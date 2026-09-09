// wifi-onboarding gives a screenless Raspberry Pi a "Chromecast-style"
// Wi-Fi setup flow: if it has no working Wi-Fi at boot, it stands up its own
// temporary access point plus a captive-portal HTTP server so an admin's
// phone/laptop can pick the real network and hand over its password. On a
// successful join it tears the AP down and keeps running as a background
// watcher, falling back to AP mode again if connectivity is later lost.
//
// All network changes go through nmcli (see network.go) with argument
// arrays, never a shell string - SSID/password here are admin-supplied.
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	Iface               string
	APConnName          string
	APSSID              string
	APPassword          string
	APAddress           string
	APGateway           string
	HTTPPort            int
	ConnectTimeout      time.Duration
	ProbeTimeout        time.Duration
	WatchInterval       time.Duration
	JoinTimeout         time.Duration
	MaxFailuresBeforeAP int
}

func parseFlags() Config {
	iface := flag.String("iface", "wlan0", "Wi-Fi interface to manage")
	apConnName := flag.String("ap-conn-name", "hardhat-setup-ap", "NetworkManager connection name for the temporary setup AP")
	apSSID := flag.String("ap-ssid", "Hardhat-Setup", "SSID broadcast by the temporary setup AP")
	apPassword := flag.String("ap-password", "hardhat-setup", "WPA2 passphrase for the temporary setup AP (8-63 chars). Prefer $AP_PASSWORD instead of this flag - a flag value sits in this long-running process's argv (world-readable via ps/proc) for its entire lifetime")
	apAddress := flag.String("ap-address", "192.168.4.1/24", "Static address (CIDR) the Pi uses on the AP interface; the gateway/portal IP is derived from it")
	httpPort := flag.Int("http-port", 80, "Port the captive portal HTTP server listens on")
	connectTimeout := flag.Duration("connect-timeout", 25*time.Second, "How long to wait for NetworkManager to auto-associate to a saved network at startup before falling back to AP mode")
	probeTimeout := flag.Duration("probe-timeout", 5*time.Second, "Per-request timeout for the internet connectivity probe")
	watchInterval := flag.Duration("watch-interval", 30*time.Second, "How often to re-check connectivity once connected")
	joinTimeout := flag.Duration("join-timeout", 25*time.Second, "How long to wait for a requested Wi-Fi join to succeed or fail")
	maxFailures := flag.Int("max-failures-before-ap", 3, "Consecutive failed connectivity checks (spaced watch-interval apart) before falling back to AP mode; debounces transient outages")
	flag.Parse()

	password := *apPassword
	if envPassword, ok := os.LookupEnv("AP_PASSWORD"); ok {
		password = envPassword
	}

	return Config{
		Iface:               *iface,
		APConnName:          *apConnName,
		APSSID:              *apSSID,
		APPassword:          password,
		APAddress:           *apAddress,
		APGateway:           gatewayFromCIDR(*apAddress),
		HTTPPort:            *httpPort,
		ConnectTimeout:      *connectTimeout,
		ProbeTimeout:        *probeTimeout,
		WatchInterval:       *watchInterval,
		JoinTimeout:         *joinTimeout,
		MaxFailuresBeforeAP: *maxFailures,
	}
}

// gatewayFromCIDR fails fast on a malformed -ap-address rather than
// defaulting just the derived gateway: silently defaulting only this value
// would leave APGateway (used for the HTTP bind address and all logging)
// diverging from the still-invalid cfg.APAddress that gets passed to nmcli.
func gatewayFromCIDR(cidr string) string {
	ip, _, err := net.ParseCIDR(cidr)
	if err != nil {
		log.Fatalf("invalid -ap-address %q: %v", cidr, err)
	}
	return ip.String()
}

// App holds the state shared between the main orchestration loop (the only
// writer of networks/lastError) and the portal's HTTP handlers (readers, and
// on /connect the other writer) - guarded by mu.
type App struct {
	cfg Config

	mu        sync.Mutex
	networks  []WifiNetwork
	lastError string
}

func main() {
	cfg := parseFlags()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app := &App{cfg: cfg}
	if err := app.run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("fatal: %v", err)
	}
	log.Println("shutting down")
}

func (a *App) run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		if a.hasWorkingConnection(ctx) {
			deactivateAP(ctx, a.cfg) // idempotent no-op if the AP is already down
			if err := a.watch(ctx); err != nil {
				return err
			}
			continue
		}

		if err := a.serveAPUntilJoined(ctx); err != nil {
			return err
		}
	}
}

// hasWorkingConnection implements the three-step check from the research:
// (1) is there even a saved Wi-Fi client profile to try, (2) give
// NetworkManager a bounded window to auto-associate, (3) confirm with a real
// HTTP probe rather than trusting nmcli's (disabled-by-default) connectivity
// state.
func (a *App) hasWorkingConnection(ctx context.Context) bool {
	has, err := hasClientWifiProfile(ctx, a.cfg.APConnName)
	if err != nil {
		log.Printf("warning: checking for saved Wi-Fi profiles: %v", err)
	}
	if !has {
		log.Println("no saved Wi-Fi client profile found - going straight to AP mode")
		return false
	}

	connectCtx, cancel := context.WithTimeout(ctx, a.cfg.ConnectTimeout)
	defer cancel()
	if !waitForConnected(connectCtx, a.cfg.Iface, a.cfg.APConnName, a.cfg.ConnectTimeout) {
		log.Printf("no association on %s within %s", a.cfg.Iface, a.cfg.ConnectTimeout)
		return false
	}

	probeCtx, cancel2 := context.WithTimeout(ctx, a.cfg.ProbeTimeout*2)
	defer cancel2()
	if !checkInternet(probeCtx, a.cfg.Iface, a.cfg.ProbeTimeout) {
		log.Println("associated but connectivity probe failed")
		return false
	}
	return true
}

// watch polls connectivity while joined to a real network and returns (nil
// error) once it should fall back to AP mode. A single failed probe doesn't
// trigger fallback - MaxFailuresBeforeAP debounces transient blips (e.g. a
// flaky upstream link) so the helmet doesn't pop its own hotspot over a
// momentary outage.
func (a *App) watch(ctx context.Context) error {
	log.Println("connected - watching for connectivity loss")
	fails := 0
	ticker := time.NewTicker(a.cfg.WatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, a.cfg.ProbeTimeout*2)
			ok := checkInternet(probeCtx, a.cfg.Iface, a.cfg.ProbeTimeout)
			cancel()
			if ok {
				fails = 0
				continue
			}
			fails++
			log.Printf("connectivity check failed (%d/%d)", fails, a.cfg.MaxFailuresBeforeAP)
			if fails >= a.cfg.MaxFailuresBeforeAP {
				log.Println("lost connectivity - falling back to AP mode")
				return nil
			}
		}
	}
}

// serveAPUntilJoined brings up the setup AP and serves the captive portal
// until one full join attempt resolves (success or failure), the server
// fails outright, or ctx is canceled. A failed join is handled entirely
// inside handleConnect (it re-activates the AP itself) - this function just
// ends the cycle either way and lets run()'s loop decide what happens next.
func (a *App) serveAPUntilJoined(ctx context.Context) error {
	log.Println("scanning for nearby networks before starting the AP (the radio can't scan and run a hotspot at the same time)")
	nets, err := scanNetworks(ctx, a.cfg.Iface)
	if err != nil {
		log.Printf("warning: pre-AP scan failed: %v", err)
	}
	a.mu.Lock()
	a.networks = nets
	a.mu.Unlock()

	if err := ensureAPProfile(ctx, a.cfg); err != nil {
		return err
	}
	if err := activateAP(ctx, a.cfg); err != nil {
		return err
	}
	log.Printf("AP %q active at %s - browse to http://%s/ to configure Wi-Fi", a.cfg.APSSID, a.cfg.APGateway, a.cfg.APGateway)

	joined := make(chan bool, 1)
	srv := a.newPortalServer(joined)

	serveErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil {
			serveErr <- err
		}
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	select {
	case <-ctx.Done():
		deactivateAP(context.Background(), a.cfg)
		return ctx.Err()
	case err := <-serveErr:
		deactivateAP(context.Background(), a.cfg)
		return err
	case ok := <-joined:
		if ok {
			log.Println("join succeeded - leaving AP mode")
		} else {
			log.Println("join attempt failed - AP re-activated for another try")
		}
		return nil
	}
}
