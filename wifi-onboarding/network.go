package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const systemConnDir = "/etc/NetworkManager/system-connections"

type WifiNetwork struct {
	SSID     string
	Signal   int
	Security string
}

// runCmd runs name with args and returns combined stdout+stderr. Never use
// this for commands whose args contain a secret (AP/Wi-Fi passwords) - the
// error path echoes args verbatim for debuggability, which would leak them
// into logs. Those call sites build their own exec.Cmd instead (see
// ensureAPProfile, joinNetwork).
func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if err != nil {
		return out.String(), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(out.String()))
	}
	return out.String(), nil
}

// splitTerseFields splits one line of `nmcli -t` output on unescaped ':',
// unescaping nmcli's own "\:" / "\\" sequences. Needed because SSIDs and
// connection names can themselves contain literal colons, which nmcli's
// terse machine-readable mode escapes rather than forbids.
func splitTerseFields(line string) []string {
	var fields []string
	var cur strings.Builder
	escaped := false
	for _, r := range line {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\':
			escaped = true
		case r == ':':
			fields = append(fields, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	fields = append(fields, cur.String())
	return fields
}

// hasClientWifiProfile reports whether any saved Wi-Fi *client* connection
// profile exists, other than the setup AP's own profile. TYPE is checked
// against both known nmcli values defensively - unverified which one the
// Pi's actual NetworkManager version emits (see README open questions).
func hasClientWifiProfile(ctx context.Context, excludeConnName string) (bool, error) {
	out, err := runCmd(ctx, "nmcli", "-t", "-f", "NAME,TYPE", "connection", "show")
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		f := splitTerseFields(line)
		if len(f) < 2 {
			continue
		}
		name, typ := f[0], f[1]
		if name == excludeConnName {
			continue
		}
		if typ == "802-11-wireless" || typ == "wifi" {
			return true, nil
		}
	}
	return false, nil
}

// waitForConnected polls device state rather than trusting a single nmcli
// call, since association after boot/AP-teardown is asynchronous. It checks
// GENERAL.CONNECTION (the active connection's name), not just GENERAL.STATE:
// state alone reports "(connected)" whether wlan0 is joined to a real
// network OR still hosting the setup AP from a prior crashed run, which
// would otherwise be misread as a healthy client connection.
func waitForConnected(ctx context.Context, iface, excludeConnName string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		state, stateErr := runCmd(ctx, "nmcli", "-g", "GENERAL.STATE", "device", "show", iface)
		active, connErr := runCmd(ctx, "nmcli", "-g", "GENERAL.CONNECTION", "device", "show", iface)
		activeName := strings.TrimSpace(active)
		if stateErr == nil && connErr == nil && strings.Contains(state, "(connected)") &&
			activeName != "" && activeName != excludeConnName {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(2 * time.Second):
		}
	}
}

// connectivityProbes are deliberately not just one host: NetworkManager's
// own connectivity-check is disabled by default on Debian-family images (see
// README), so this is the only real signal available, and a single flaky
// endpoint shouldn't force an unnecessary AP fallback.
var connectivityProbes = []string{
	"http://connectivitycheck.gstatic.com/generate_204",
	"http://cp.cloudflare.com/generate_204",
}

// checkInternet scopes its probes to iface's own source address (via
// Dialer.LocalAddr) rather than whatever route the OS default policy would
// pick - otherwise a probe could succeed over an unrelated route (e.g.
// Ethernet, or the AP's own local subnet replying to itself) and be
// misread as the Wi-Fi interface itself having real internet access.
func checkInternet(ctx context.Context, iface string, perRequestTimeout time.Duration) bool {
	dialer := &net.Dialer{Timeout: perRequestTimeout}
	if ip, err := ifaceIPv4(iface); err == nil {
		dialer.LocalAddr = &net.TCPAddr{IP: ip}
	}
	client := &http.Client{
		Timeout:   perRequestTimeout,
		Transport: &http.Transport{DialContext: dialer.DialContext},
	}
	for _, url := range connectivityProbes {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusNoContent {
			return true
		}
	}
	return false
}

// ifaceIPv4 returns the first IPv4 address bound to iface.
func ifaceIPv4(iface string) (net.IP, error) {
	ifc, err := net.InterfaceByName(iface)
	if err != nil {
		return nil, err
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return nil, err
	}
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		if ip4 := ipNet.IP.To4(); ip4 != nil {
			return ip4, nil
		}
	}
	return nil, fmt.Errorf("no IPv4 address on %s", iface)
}

// scanNetworks must be called before the radio switches to AP mode - most
// Wi-Fi hardware (including the Pi's onboard radio) cannot scan while
// simultaneously operating as an AP. Callers cache the result and serve it
// from the portal for the AP's whole lifetime.
func scanNetworks(ctx context.Context, iface string) ([]WifiNetwork, error) {
	_, _ = runCmd(ctx, "nmcli", "device", "wifi", "rescan", "ifname", iface)

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(2 * time.Second):
	}

	out, err := runCmd(ctx, "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", iface)
	if err != nil {
		return nil, err
	}

	byName := map[string]int{}
	var nets []WifiNetwork
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		f := splitTerseFields(line)
		if len(f) < 3 {
			continue
		}
		ssid, signalStr, security := f[0], f[1], f[2]
		if ssid == "" {
			continue // hidden networks report a blank SSID; the portal's manual-entry field covers these
		}
		signal, _ := strconv.Atoi(signalStr)
		if idx, ok := byName[ssid]; ok {
			if signal > nets[idx].Signal {
				nets[idx].Signal = signal
				nets[idx].Security = security
			}
			continue
		}
		byName[ssid] = len(nets)
		nets = append(nets, WifiNetwork{SSID: ssid, Signal: signal, Security: security})
	}
	sort.Slice(nets, func(i, j int) bool { return nets[i].Signal > nets[j].Signal })
	return nets, nil
}

// ensureAPProfile writes the setup AP's .nmconnection profile straight into
// /etc (never plain `nmcli connection add`, which on some Trixie images
// lands in the volatile /run and vanishes on reboot - see README). Skips
// regeneration if the file already exists so re-running this doesn't need to
// re-derive nmcli's generated UUID etc.
func ensureAPProfile(ctx context.Context, cfg Config) error {
	path := filepath.Join(systemConnDir, cfg.APConnName+".nmconnection")
	if _, err := os.Stat(path); err == nil {
		return os.Chmod(path, 0600)
	} else if !os.IsNotExist(err) {
		return err
	}

	args := []string{
		"--offline", "connection", "add",
		"con-name", cfg.APConnName,
		"type", "wifi",
		"ifname", cfg.Iface,
		"wifi.mode", "ap",
		"wifi.ssid", cfg.APSSID,
		"wifi-sec.key-mgmt", "wpa-psk",
		"wifi-sec.psk", cfg.APPassword,
		"wifi-sec.proto", "rsn",
		"wifi-sec.pairwise", "ccmp",
		"wifi-sec.group", "ccmp",
		"ipv4.method", "shared",
		"ipv4.addresses", cfg.APAddress,
		"connection.autoconnect", "no",
	}

	cmd := exec.CommandContext(ctx, "nmcli", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// stdout is the generated keyfile (plaintext PSK included) - never
		// put it in an error message/log, even on failure.
		return fmt.Errorf("nmcli --offline connection add: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	if err := os.MkdirAll(systemConnDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(path, stdout.Bytes(), 0600); err != nil {
		return err
	}
	if _, err := runCmd(ctx, "nmcli", "connection", "reload"); err != nil {
		return err
	}
	log.Printf("wrote AP profile to %s", path)
	return nil
}

const captiveNATTable = "hardhat_captive"

func activateAP(ctx context.Context, cfg Config) error {
	if _, err := runCmd(ctx, "nmcli", "connection", "up", cfg.APConnName); err != nil {
		return fmt.Errorf("activate AP: %w", err)
	}
	ensureNAT(ctx, cfg)
	addCaptiveDNAT(ctx, cfg)
	return nil
}

func deactivateAP(ctx context.Context, cfg Config) {
	removeCaptiveDNAT(ctx, cfg)
	if _, err := runCmd(ctx, "nmcli", "connection", "down", cfg.APConnName); err != nil {
		log.Printf("note: bringing down AP connection (may already be down): %v", err)
	}
}

// ensureNAT works around an open upstream bug (raspberrypi/trixie-feedback
// #62): NetworkManager can bring up a shared-mode AP whose SSID is visible
// and joinable but without programming the nftables NAT/DHCP rules it needs
// to actually work, until NetworkManager itself is restarted. Must run every
// activation, not just first setup - the bug is intermittent, not one-time.
func ensureNAT(ctx context.Context, cfg Config) {
	out, err := runCmd(ctx, "nft", "list", "ruleset")
	if err == nil && strings.TrimSpace(out) != "" {
		return
	}
	log.Println("nft ruleset empty after AP activation - restarting NetworkManager to work around known Trixie bug (trixie-feedback#62)")
	if _, err := runCmd(ctx, "systemctl", "restart", "NetworkManager"); err != nil {
		log.Printf("warning: could not restart NetworkManager: %v", err)
		return
	}
	time.Sleep(3 * time.Second)
	if _, err := runCmd(ctx, "nmcli", "connection", "up", cfg.APConnName); err != nil {
		log.Printf("warning: could not re-activate AP after NetworkManager restart: %v", err)
	}
}

// addCaptiveDNAT is defense-in-depth on top of the dnsmasq-shared.d wildcard
// DNS redirect (see setup_pi.sh): a client with a stale cached DNS answer
// would otherwise bypass the redirect and fail to reach the portal at all.
// Only port 80 is touched - 443 is left alone deliberately (see README).
func addCaptiveDNAT(ctx context.Context, cfg Config) {
	_, _ = runCmd(ctx, "nft", "delete", "table", "inet", captiveNATTable) // clean slate from any prior crashed run
	_, _ = runCmd(ctx, "nft", "add", "table", "inet", captiveNATTable)
	if _, err := runCmd(ctx, "nft", "add", "chain", "inet", captiveNATTable, "prerouting",
		"{", "type", "nat", "hook", "prerouting", "priority", "-100", ";", "}"); err != nil {
		log.Printf("note: captive DNAT chain setup: %v", err)
		return
	}
	dst := fmt.Sprintf("%s:80", cfg.APGateway)
	if _, err := runCmd(ctx, "nft", "add", "rule", "inet", captiveNATTable, "prerouting",
		"iifname", cfg.Iface, "tcp", "dport", "80", "dnat", "to", dst); err != nil {
		log.Printf("warning: could not add captive-portal DNAT rule (DNS redirect alone still covers most clients): %v", err)
	}
}

func removeCaptiveDNAT(ctx context.Context, cfg Config) {
	_, _ = runCmd(ctx, "nft", "delete", "table", "inet", captiveNATTable)
}

// waitForDeviceIdle gives NetworkManager's own in-progress activation state
// a bounded window to settle before this process activates a different
// connection profile on the same device. exec.CommandContext can only
// SIGKILL the local nmcli CLI on timeout - it can't cancel NetworkManager's
// own D-Bus-driven activation, so a killed/failed join and an immediately
// following AP re-activation can otherwise race against each other. This
// reduces, but does not eliminate, that race.
func waitForDeviceIdle(ctx context.Context, iface string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := runCmd(ctx, "nmcli", "-g", "GENERAL.STATE", "device", "show", iface)
		if err == nil && !strings.Contains(out, "activating") && !strings.Contains(out, "connecting") {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(1 * time.Second):
		}
	}
}

// joinNetwork never routes through runCmd, since its args contain the
// admin-supplied plaintext Wi-Fi password and runCmd's error path would
// otherwise echo args verbatim into logs.
func joinNetwork(ctx context.Context, cfg Config, ssid, password string, hidden bool) error {
	args := []string{"device", "wifi", "connect", ssid, "ifname", cfg.Iface}
	if password != "" {
		args = append(args, "password", password)
	}
	if hidden {
		args = append(args, "hidden", "yes")
	}

	cmd := exec.CommandContext(ctx, "nmcli", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nmcli device wifi connect %q: %w: %s", ssid, err, strings.TrimSpace(out.String()))
	}

	if err := ensurePersisted(ctx, ssid); err != nil {
		log.Printf("warning: joined %q but could not confirm the profile persisted to /etc (may not survive a reboot): %v", ssid, err)
	}
	return nil
}

// ensurePersisted covers the other half of the same Trixie regression
// ensureAPProfile works around: nmcli device wifi connect can also drop its
// generated profile into the volatile /run instead of /etc.
func ensurePersisted(ctx context.Context, connName string) error {
	out, err := runCmd(ctx, "nmcli", "-g", "GENERAL.FILENAME", "connection", "show", connName)
	if err != nil {
		return err
	}
	filename := strings.TrimSpace(out)
	if filename == "" {
		return fmt.Errorf("no filename reported for connection %q", connName)
	}
	if strings.HasPrefix(filename, "/etc/") {
		return nil
	}

	data, err := os.ReadFile(filename)
	if err != nil {
		return fmt.Errorf("reading volatile profile %s: %w", filename, err)
	}
	dst := filepath.Join(systemConnDir, filepath.Base(filename))
	if err := os.WriteFile(dst, data, 0600); err != nil {
		return fmt.Errorf("persisting profile to %s: %w", dst, err)
	}
	if _, err := runCmd(ctx, "nmcli", "connection", "reload"); err != nil {
		return err
	}
	log.Printf("persisted volatile connection profile %s -> %s", filename, dst)
	return nil
}
