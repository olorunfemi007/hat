package main

import (
	"context"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	_ "embed"
)

//go:embed portal.html
var portalHTML string

var portalTmpl = template.Must(template.New("portal").Parse(portalHTML))

type portalPageData struct {
	APSSID   string
	Networks []WifiNetwork
	Error    string
}

// probePaths are the OS-specific captive-portal detection requests (see
// README): every one of them is deliberately answered with the plain setup
// form (never their real expected "everything's fine" response), which is
// what makes iOS/Android/Windows automatically pop the sign-in browser open.
var probePaths = []string{
	"/hotspot-detect.html",       // Apple, expects a page whose body is exactly "Success"
	"/library/test/success.html", // older Apple
	"/generate_204",              // Android/Chrome, expects a bare 204
	"/gen_204",
	"/connecttest.txt", // Windows NCSI, expects the exact string "Microsoft Connect Test"
	"/ncsi.txt",        // legacy Windows NCSI, expects "Microsoft NCSI"
}

// newPortalServer builds the captive-portal HTTP server for one AP cycle.
// joined receives exactly one true/false when a submitted join attempt
// resolves; handleConnect is the only sender.
func (a *App) newPortalServer(joined chan<- bool) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handleIndex)
	for _, p := range probePaths {
		mux.HandleFunc(p, a.handleIndex)
	}
	// joined only has room for one value; without this guard a double-submit
	// (e.g. an impatient double-tap on the form) would start a second
	// concurrent join attempt whose goroutine would then block forever
	// trying to send once the first attempt has already filled the channel.
	// The release is deferred right here (not inside handleConnect) so it
	// always fires regardless of which return path handleConnect takes -
	// handleConnect has early returns (bad form, empty SSID) that must not
	// leave `joining` stuck at 1, which would permanently 409 every future
	// /connect on this AP cycle with no way back to AP-mode fallback.
	var joining int32
	mux.HandleFunc("/connect", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			a.handleConnect(w, r, joined)
			return
		}
		if !atomic.CompareAndSwapInt32(&joining, 0, 1) {
			http.Error(w, "a join attempt is already in progress - wait a moment and reload", http.StatusConflict)
			return
		}
		defer atomic.StoreInt32(&joining, 0)
		a.handleConnect(w, r, joined)
	})

	return &http.Server{
		Addr:              fmt.Sprintf("%s:%d", a.cfg.APGateway, a.cfg.HTTPPort),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

func (a *App) handleIndex(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	data := portalPageData{
		APSSID:   a.cfg.APSSID,
		Networks: a.networks,
		Error:    a.lastError,
	}
	a.mu.Unlock()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := portalTmpl.Execute(w, data); err != nil {
		log.Printf("template execute: %v", err)
	}
}

func (a *App) setError(msg string) {
	a.mu.Lock()
	a.lastError = msg
	a.mu.Unlock()
}

func (a *App) handleConnect(w http.ResponseWriter, r *http.Request, joined chan<- bool) {
	if r.Method != http.MethodPost {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}

	ssid := strings.TrimSpace(r.FormValue("ssid"))
	if manual := strings.TrimSpace(r.FormValue("ssid_manual")); manual != "" {
		ssid = manual
	}
	password := r.FormValue("password")
	hidden := r.FormValue("hidden") == "on"

	if ssid == "" {
		a.setError("Please choose or type a network name.")
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	// Look up the scanned security type (e.g. "WPA2", "WPA2 WPA3") for this
	// SSID so joinNetwork can pick the right wifi-sec.key-mgmt value instead
	// of guessing - manual/hidden entries won't be in the cached scan, which
	// is fine, joinNetwork's default (wpa-psk) covers the common case.
	var security string
	a.mu.Lock()
	for _, n := range a.networks {
		if n.SSID == ssid {
			security = n.Security
			break
		}
	}
	a.mu.Unlock()

	log.Printf("attempting to join %q", ssid)

	// Deliberately not r.Context(): activating the target network forces
	// wlan0 out of AP mode, which drops the very TCP connection this request
	// arrived on almost immediately - using r.Context() here would cancel
	// the join attempt itself the instant that happens, before nmcli could
	// ever report success or failure.
	joinCtx, cancel := context.WithTimeout(context.Background(), a.cfg.JoinTimeout)
	defer cancel()

	if err := joinNetwork(joinCtx, a.cfg, ssid, password, hidden, security); err != nil {
		log.Printf("join %q failed: %v", ssid, err)
		a.setError(fmt.Sprintf("Could not join %q: %v", ssid, err))

		// Give NetworkManager's own in-progress activation state (from the
		// join attempt that just failed/was killed) a bounded window to
		// settle before activating a different profile on the same device.
		waitForDeviceIdle(context.Background(), a.cfg.Iface, 10*time.Second)

		apErr := activateAP(context.Background(), a.cfg)
		if apErr != nil {
			log.Printf("could not re-activate AP after failed join: %v", apErr)
		}
		writeConnectResult(w, false, apErr == nil, ssid, a.cfg.APSSID)
		joined <- false
		return
	}

	log.Printf("joined %q", ssid)
	a.setError("")
	writeConnectResult(w, true, true, ssid, a.cfg.APSSID)
	joined <- true
}

// writeConnectResult is best-effort: in the common case the requesting
// phone's own link to the AP has already dropped by the time this would
// reach it (see handleConnect), so nothing reads this response at all. It
// only reliably lands when the client reached the portal over Ethernet/a
// second radio, or when the join failed fast enough that the AP hadn't been
// torn down yet.
// apOK is meaningless when ok is true (join succeeded, so the AP is being
// torn down deliberately). When ok is false, apOK reflects whether the
// recovery activateAP call in handleConnect actually succeeded - the admin
// must not be told to reconnect to a hotspot that isn't really back up.
func writeConnectResult(w http.ResponseWriter, ok, apOK bool, ssid, apSSID string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	safeSSID := template.HTMLEscapeString(ssid)
	safeAP := template.HTMLEscapeString(apSSID)
	if ok {
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Joining</title>`+
			`<body style="font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem">`+
			`<h1>Joining %s&hellip;</h1>`+
			`<p>The hotspot is shutting down now. If this succeeds, this page will simply stop responding - that's expected. Reconnect your phone to your normal Wi-Fi.</p></body>`, safeSSID)
		return
	}
	if apOK {
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Retrying</title>`+
			`<body style="font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem">`+
			`<h1>Could not join %s</h1>`+
			`<p>The %s hotspot is back up. Reconnect to it and reload the setup page to see the error and try again.</p></body>`, safeSSID, safeAP)
		return
	}
	fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Error</title>`+
		`<body style="font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem">`+
		`<h1>Could not join %s</h1>`+
		`<p>The setup hotspot could not be restarted automatically after this failure. The device may need to be power-cycled, or the wifi-onboarding service restarted, before you can try again.</p></body>`, safeSSID)
}
