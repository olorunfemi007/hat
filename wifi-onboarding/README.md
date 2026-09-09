# wifi-onboarding

Screenless Wi-Fi setup for the hard-hat Pi: "Option A" from `workflow.txt`'s
no-screen onboarding section, Chromecast/Ring-style. If the helmet has no
working Wi-Fi, it broadcasts its own temporary hotspot and serves a captive
portal so an admin's phone/laptop can hand it the real network's SSID and
password. Once that succeeds, the hotspot goes away and the helmet keeps
running as a background watcher, ready to fall back into hotspot mode again
if it ever loses connectivity.

This is a standalone component, independent of `voice-trigger/` - it only
touches network configuration.

Not in scope here (see `workflow.txt` for the fuller picture): the QR
code/device-ID/claim-token flow, the "hold a button for 5s to enter setup
mode" trigger, and contacting a provisioning service after joining. This
program's job ends at "the helmet is on the real Wi-Fi network."

## Files

- `main.go` - flags, the `App` type, and the main orchestration loop: check
  connectivity -> watch while connected, or serve the AP + portal until a
  network is joined -> repeat forever.
- `network.go` - every point of contact with the OS: nmcli (AP profile
  creation/activation, scanning, joining, persistence checks), the internet
  connectivity probe, and the `nft` captive-portal DNAT hardening rule. All
  external commands run via `exec.Command`/`exec.CommandContext` with
  argument arrays - never a shell string - since SSID/password are
  admin-supplied input.
- `portal.go` + `portal.html` - the captive-portal HTTP server: the setup
  form, the OS-specific captive-portal probe paths, and the `/connect`
  handler that attempts to join the chosen network.
- `wifi-onboarding.service` - systemd unit, installed (and enabled, but not
  started) by `setup_pi.sh`.
- `setup_pi.sh` - idempotent installer: apt packages, Go build, binary +
  unit install, static dnsmasq/env config.
- `go.mod` - pure Go stdlib, no third-party dependencies.

## How it works

### Startup connectivity check

On every boot (and after falling back from a watch cycle), before touching
the radio at all:

1. **Is there even a saved Wi-Fi client profile?** (`nmcli -t -f NAME,TYPE
   connection show`, excluding the setup AP's own profile.) If not, there's
   nothing to wait on - go straight to AP mode.
2. **Give NetworkManager a bounded window to auto-associate.** Poll `nmcli -g
   GENERAL.STATE device show wlan0` for `(connected)`, up to `-connect-timeout`
   (default 25s). The systemd unit also orders itself after
   `NetworkManager-wait-online.service`, which Raspberry Pi OS ships and
   enables, as a first line of help here.
3. **Confirm with a real HTTP probe.** NetworkManager's own connectivity-check
   is disabled by default on Debian-family images (empty `uri=` under
   `[connectivity]` in `NetworkManager.conf`), so `nmcli -g CONNECTIVITY
   general` always reports `full` regardless of actual internet access - it
   cannot be trusted. Instead this does a real `GET` against
   `http://connectivitycheck.gstatic.com/generate_204`, expecting exactly
   `204`; if that fails (timeout, DNS failure, wrong status), it tries
   `http://cp.cloudflare.com/generate_204` before giving up, so one flaky
   endpoint doesn't force an unnecessary AP fallback.

Any failure at any step -> AP mode. All three pass -> enter watch mode.

### Watch mode

While connected, re-runs the same HTTP probe every `-watch-interval`
(default 30s). A single failed probe doesn't trigger fallback -
`-max-failures-before-ap` (default 3) consecutive failures are required, to
debounce a momentary upstream blip rather than popping the hotspot back up
over nothing.

### AP mode

1. **Scan first.** Most Wi-Fi radios, including the Pi's onboard one, cannot
   scan for networks while simultaneously running as an AP - it's a
   hardware/firmware limitation, not something NetworkManager can work
   around. So the scan (`nmcli device wifi rescan` + `nmcli -t -f
   SSID,SIGNAL,SECURITY device wifi list`) happens *before* switching modes,
   and the result is cached and served from the portal for the AP's entire
   lifetime - it will not update while the hotspot is up. The form makes this
   explicit and always offers a manual SSID field as a fallback (also the
   only way to reach a hidden network, which reports a blank SSID in scan
   results).
2. **Bring up the AP via NetworkManager, not hostapd+dnsmasq.** `nmcli
   --offline connection add ... wifi.mode ap ... ipv4.method shared` is
   written directly as a `.nmconnection` file into
   `/etc/NetworkManager/system-connections/` (see "Trixie gotchas" below for
   why it's `--offline` + a direct file write, not the plain `nmcli
   connection add` shown in most tutorials). `ipv4.method shared` makes
   NetworkManager run its own internal DHCP server and spawn a private
   per-connection `dnsmasq` instance - no `hostapd` install, nothing else
   fighting NetworkManager for control of `wlan0`.
3. **Work around a known Trixie NetworkManager bug.** After activating the
   AP, checks `nft list ruleset` is non-empty; if it's empty, restarts
   `NetworkManager` and re-activates the AP connection. This is an open,
   unresolved upstream bug
   ([raspberrypi/trixie-feedback#62](https://github.com/raspberrypi/trixie-feedback/issues/62)):
   NetworkManager can bring up a shared-mode AP whose SSID is visible and
   joinable, without actually programming the nftables NAT rules DHCP/DNS
   need - clients associate but get nothing. Runs on *every* activation, not
   just once, since the bug is intermittent.
4. **Serve the captive portal** on `http://<ap-gateway>/` (default
   `192.168.4.1`, bound to that address specifically, not `0.0.0.0` -
   the portal should only be reachable over the AP interface).

### Making phones auto-open the portal

Every DNS query from a client on the hotspot resolves to the Pi itself, via
a `dnsmasq-shared.d` wildcard drop-in (`address=/#/192.168.4.1`, set up once
by `setup_pi.sh`, not by the Go binary) - `#` is dnsmasq's match-all-domains
token. That's what routes each OS's captive-portal probe (a real hostname
like `captive.apple.com`) to our server. The portal then deliberately fails
every probe's "everything's fine" check instead of passing it, which is what
makes the OS pop its sign-in browser open automatically:

| Platform | Probe path | What "fine" looks like | What we serve instead |
|---|---|---|---|
| iOS/macOS | `/hotspot-detect.html` | Body is exactly `Success` | The setup form (200) |
| Android | `/generate_204` (+ `/gen_204`) | Bare `204 No Content` | The setup form (200) |
| Windows | `/connecttest.txt` (+ legacy `/ncsi.txt`) | Body is exactly `Microsoft Connect Test` | The setup form (200) |

As defense in depth against a client with a stale cached DNS answer (which
would bypass the wildcard redirect and just fail to reach the portal at
all), AP activation also adds an `nft` DNAT rule redirecting inbound TCP
port 80 on `wlan0` to the portal. Port 443 is deliberately left alone - a
client hitting our self-signed-nothing on 443 will fail TLS validation, and
that reads to the OS as "no internet," which is the correct captive-portal
signal anyway; trying to intercept HTTPS would just be fighting certificate
validation for no benefit.

Known iOS quirk (Apple Developer Forums, unresolved as of iOS 26 at the time
the design research for this was done): the automatic Captive Network
Assistant popup can occasionally fail with a "network connection was lost"
error even though the portal itself is fine. The form's own help text tells
the admin to open Safari and browse to any `http://` URL as a fallback.

### Joining the target network

`POST /connect` calls `nmcli device wifi connect <ssid> ifname wlan0
[password <pw>] [hidden yes]` with a **process-level context, not the HTTP
request's context** - see the comment in `handleConnect`. This matters: the
Pi has one Wi-Fi radio, so the instant NetworkManager starts switching
`wlan0` from AP mode to client mode to attempt the join, the phone that's
mid-request loses its own link to the hotspot and the TCP connection this
request arrived on drops. Using the request's context would cancel the join
attempt itself at that exact moment, before nmcli could ever report success
or failure.

**This means the "please wait" / success / failure response the server
tries to write back is best-effort and, in the common case, unreadable** -
the phone's link to the Pi is usually already gone by the time there's
anything to send. This isn't a bug to fix; it's inherent to onboarding over
a single Wi-Fi radio with no side channel (Chromecast-style devices solve
this with a second radio - BLE - for exactly this reason). What actually
carries the outcome across is documented state on the Pi side, plus the
form's own copy telling the admin what to expect:

- **Join succeeds:** NetworkManager tears the AP down as a side effect of
  activating the new profile. The Go process returns to its main loop, which
  finds a working connection and enters watch mode. The old hotspot is gone
  for good; the admin has to find the helmet on the new network by other
  means (this program doesn't do any "phone home" step - see "Not in scope"
  above).
- **Join fails** (wrong password, network out of range, etc.): the handler
  explicitly re-activates the AP profile and records the error. The admin's
  phone/laptop has to reconnect to `Hardhat-Setup` (usually automatic if it
  was recently joined) and reload the page to see the error banner and try
  again.

Either way, a successful `nmcli` join also gets a persistence check (see
below) before being trusted.

## Trixie-specific gotchas this code defends against

Raspberry Pi OS Trixie (Debian 13) keeps NetworkManager as the default
network backend from Bookworm onward, but layers Netplan + cloud-init-driven
provisioning on top. This code avoids `/etc/netplan` entirely and manages
`.nmconnection` files directly, for two confirmed reasons:

1. **Profiles can land in `/run` instead of `/etc` and vanish on reboot**
   ([raspberrypi/trixie-feedback#3](https://github.com/raspberrypi/trixie-feedback/issues/3),
   also reported independently on the Raspberry Pi forums). Community
   reports suggest a Trixie Lite image dated 2025-11-24 or later restored
   Bookworm-like `/etc` behavior by default, but since the exact image build
   on the target Pi isn't verifiable from here, this code doesn't rely on
   that:
   - The AP profile is generated with `nmcli --offline connection add`
     (which just prints a keyfile to stdout, touching nothing on disk) and
     written into `/etc/NetworkManager/system-connections/` directly by Go
     (`ensureAPProfile` in `network.go`), never via a plain `nmcli connection
     add`.
   - After every successful `nmcli device wifi connect`, `ensurePersisted`
     checks `nmcli -g GENERAL.FILENAME connection show <ssid>`; if it
     reports a path under `/run` instead of `/etc`, the profile is copied
     over and `nmcli connection reload` run, so the credentials the admin
     just typed in actually survive a reboot.
2. **NetworkManager can fail to program AP NAT rules at activation** (open
   bug, `trixie-feedback#62`, covered above under "AP mode").

Netplan itself is never touched by this code at all - not read, not
written - specifically because of a separate reported regression
([raspberrypi/trixie-feedback#40](https://github.com/raspberrypi/trixie-feedback/issues/40))
where netplan mismanages multiple Wi-Fi profiles and only the first survives
`netplan apply`.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `-iface` | `wlan0` | Wi-Fi interface to manage |
| `-ap-conn-name` | `hardhat-setup-ap` | NetworkManager connection name for the setup AP |
| `-ap-ssid` | `Hardhat-Setup` | SSID broadcast by the setup AP |
| `-ap-password` | `hardhat-setup` | WPA2 passphrase for the setup AP (8-63 chars); set via `AP_PASSWORD` in `/etc/hardhat/wifi-onboarding.env`, not by editing the unit file |
| `-ap-address` | `192.168.4.1/24` | Static CIDR the Pi uses on the AP interface; the portal/gateway IP is derived from it |
| `-http-port` | `80` | Port the captive portal listens on (bound to the AP gateway IP only) |
| `-connect-timeout` | `25s` | How long to wait for NetworkManager to auto-associate at startup before falling back to AP mode |
| `-probe-timeout` | `5s` | Per-request timeout for the internet connectivity probe |
| `-watch-interval` | `30s` | How often to re-check connectivity once connected |
| `-join-timeout` | `25s` | How long to wait for a requested Wi-Fi join to resolve |
| `-max-failures-before-ap` | `3` | Consecutive failed connectivity checks (spaced `-watch-interval` apart) before falling back to AP mode |

## Installing on the Pi

```bash
scp -r /Users/femi/dev/hardhat/wifi-onboarding pi@<pi-ip>:~/
ssh pi@<pi-ip>
cd ~/wifi-onboarding
./setup_pi.sh
```

`setup_pi.sh` installs `dnsmasq-base` + `nftables`, builds and installs the
binary to `/usr/local/bin/wifi-onboarding`, writes
`/etc/hardhat/wifi-onboarding.env` (edit `AP_PASSWORD` here) and
`/etc/NetworkManager/dnsmasq-shared.d/captive.conf`, and installs +
`systemctl enable`s the unit - **but does not start it.**

**Start it deliberately, ideally over Ethernet or a local console the first
time**, not over the Pi's own Wi-Fi client connection: if you're SSH'd in
over `wlan0` and this service decides connectivity looks bad, it will switch
the radio to AP mode and drop your SSH session out from under you.

```bash
sudo systemctl start wifi-onboarding.service
journalctl -u wifi-onboarding.service -f
```

## Testing on the Pi

**Test the AP + portal without a real Wi-Fi outage:** the easiest way is to
temporarily point `-connect-timeout`/probes somewhere that will fail, or
just disconnect the Pi from Wi-Fi and run interactively first before
installing the systemd unit at all:

```bash
sudo nmcli connection down "<your-current-wifi-profile-name>"
sudo ./wifi-onboarding
```

Watch the log for `AP ... active at http://192.168.4.1/`. From a phone or
laptop:

1. Connect to the `Hardhat-Setup` Wi-Fi network (password from
   `/etc/hardhat/wifi-onboarding.env`, or whatever you passed via
   `-ap-password` when testing interactively).
2. A captive-portal sign-in prompt should appear within a few seconds; if
   not, open a browser and go to any `http://` address (not `https://`).
3. Pick your real network (or type it manually) and submit.
4. Your phone will lose its connection to `Hardhat-Setup` - that's expected.
   Reconnect to your normal Wi-Fi and check whether the Pi shows up on it
   (e.g. `ping <pi-hostname>.local`, or check your router's client list).
5. If it didn't work, reconnect to `Hardhat-Setup` and reload the setup
   page - you should see an error banner explaining why (most likely a wrong
   password).

**Verify persistence across reboot** (the Trixie regression this code
defends against):

```bash
ls /etc/NetworkManager/system-connections/
# should show both hardhat-setup-ap.nmconnection and your joined
# network's profile - if either is missing here but present under
# /run/NetworkManager/system-connections/ instead, ensurePersisted /
# ensureAPProfile didn't do their job; check the service's journal.
sudo reboot
# after it comes back: confirm it auto-joined the real network instead of
# starting the hotspot again.
```

**Verify the Trixie NAT bug workaround is reachable:** watch for `nft
ruleset empty after AP activation - restarting NetworkManager` in the
journal during an AP activation. If you never see it, either the bug isn't
present on this image build, or (less likely) `nft list ruleset` is
reporting non-empty for an unrelated reason - worth a manual `sudo nft list
ruleset` check while the AP is up either way.

## Known limitations / open questions for real hardware

- **`nmcli` TYPE string for Wi-Fi client profiles.** `hasClientWifiProfile`
  checks for both `802-11-wireless` and `wifi` defensively, since which one a
  given NetworkManager version emits from `nmcli -t -f TYPE connection show`
  wasn't verifiable from this machine. Worth confirming against the actual
  Pi's `nmcli --version` output the first time this runs.
- ~~`nft` DNAT rule syntax~~ **Resolved, confirmed against real hardware.**
  Two real bugs were found and fixed by actually running this on a Pi:
  (1) the chain-block spec needs a semicolon before its closing brace -
  `{ type nat hook prerouting priority -100 ; }`, not `{ ... -100 }` - or nft
  rejects it with "syntax error, unexpected end of file"; (2) in an `inet`
  (dual-stack) family table, a NAT statement must specify which address
  family it translates for - `dnat ip to <addr>`, not a bare `dnat to
  <addr>` - or nft rejects it as ambiguous. Both are fixed in the current
  code. Failures here are non-fatal either way (logged as warnings, don't
  block AP mode) - the DNS wildcard redirect is the primary mechanism - but
  worth a `sudo nft list ruleset` check while the AP is up to confirm the
  `hardhat_captive` table's DNAT rule actually landed.
- ~~`nmcli device wifi connect` for joining the target network~~ **Resolved,
  confirmed against real hardware.** The original implementation used
  `nmcli device wifi connect <ssid> password <pw>`, which relies on nmcli's
  own heuristics to infer the security profile. Against a real Android
  hotspot (S24 Ultra, likely WPA2/WPA3-mixed "Personal" security) this
  failed outright with `802-11-wireless-security.key-mgmt: property is
  missing`. Fixed by writing an explicit connection profile via `nmcli
  --offline` instead (the same technique already used for the setup AP's own
  profile), setting `wifi-sec.key-mgmt` explicitly rather than leaving nmcli
  to guess - `wpa-psk` by default, `sae` if the pre-AP scan reported the
  target as WPA3-only. This also incidentally fixed a separate issue (the
  admin-submitted password briefly appearing in `nmcli`'s own process args).
- **Single-radio AP+STA exclusivity** is assumed throughout (can't scan
  while hosting an AP; joining a new network necessarily tears down the AP).
  This matches the research this was built against, but if the Pi ends up
  using a USB Wi-Fi adapter with real AP+STA concurrent-mode firmware
  instead of the onboard radio, some of this (especially the "your phone
  will lose the hotspot mid-join" behavior) may not apply and could
  potentially be improved.
- **No rate-limiting or auth on `/connect`** beyond needing to know the AP's
  own WPA2 password to be on the hotspot's network at all. Fine for a
  physically-present-admin onboarding flow; would need hardening before ever
  exposing this on anything less contained.
