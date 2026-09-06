# voice-trigger

Standalone test program: listens on the microphone for a spotted keyphrase
(via PocketSphinx) and runs a shell command — by default a short
`libcamera-vid` capture — when it fires. Not part of the real hard-hat agent;
this is a bench-test rig for mic + wake-phrase + camera on a Raspberry Pi
before wiring the behavior into the actual edge agent.

## Files

- `main.go` — the program. Shells out to `pocketsphinx_continuous`, watches
  its stdout, and runs `-camera_cmd` on every spotted line (debounced by
  `-cooldown`, default 3s).
- `keyword.list` — PocketSphinx keyword-spotting list. Default entry:
  `turn on camera /1e-40/`. The threshold controls sensitivity — a more
  negative exponent (e.g. `1e-50`) triggers more easily but with more false
  positives; a less negative one (e.g. `1e-10`) is stricter. Tune by ear
  against your actual mic and ambient noise.
- `go.mod` — pure Go stdlib, no third-party dependencies.

## Running on Raspberry Pi OS Lite (headless, over SSH)

### 1. Update and install build essentials + PocketSphinx

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y build-essential git \
    pocketsphinx pocketsphinx-utils libpocketsphinx-dev libsphinxbase-dev \
    libasound2-dev alsa-utils
```

Confirm what CLI you actually got — this varies by Debian release:

```bash
pocketsphinx_continuous -h 2>&1 | grep -E 'inmic|kws'
```

If nothing prints, that binary isn't available on this image. The program
expects the classic `pocketsphinx_continuous -inmic yes -kws <file>`
interface; if apt gave you the newer Python-first `pocketsphinx` CLI instead,
`main.go` needs its default binary name and args adjusted to match.

### 2. Install Go

Apt's Go package on Pi OS is often stale — grab the current arm64 tarball
from https://go.dev/dl/ instead (version below is an example, check the site
for the latest):

```bash
curl -LO https://go.dev/dl/go1.23.4.linux-arm64.tar.gz
sudo tar -C /usr/local -xzf go1.23.4.linux-arm64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
go version
```

### 3. Confirm the mic works before involving any code

```bash
arecord -l                       # list capture devices, note the card/device number
arecord -d 5 -f cd test.wav      # record 5s
ls -la test.wav                  # should be a few hundred KB, not ~44 bytes
```

If your mic isn't card 0, set it as the ALSA default in `~/.asoundrc`:

```
pcm.!default { type hw; card 1; }
ctl.!default { type hw; card 1; }
```

### 4. Confirm the camera works standalone

```bash
sudo raspi-config   # Interface Options -> Camera -> enable, reboot if changed
libcamera-hello --list-cameras
libcamera-vid -t 2000 -o test.h264
```

### 5. Copy the code onto the Pi

From your dev machine:

```bash
scp -r /Users/femi/dev/hardhat/voice-trigger pi@<pi-ip>:~/
```

### 6. Build and run

```bash
cd ~/voice-trigger
go build -o voice-trigger .

# sanity-check detection first, without touching the camera
./voice-trigger -camera_cmd "echo CAMERA TRIGGERED"
```

Say "turn on camera" into the mic and watch for `spotted: ...` in the log.
Once detection is reliable, drop the override to use the real `libcamera-vid`
default, or point `-camera_cmd` at your own capture command.

### 7. Keep it running past your SSH session (optional)

```bash
sudo apt install -y tmux
tmux new -s voicetrigger
./voice-trigger
# Ctrl-b then d to detach; `tmux attach -t voicetrigger` to reattach
```

For something more permanent than a foreground/tmux test, run it as a
systemd service instead — not set up yet, ask if you want it added.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `-kws_file` | `keyword.list` | PocketSphinx keyword-spotting list file |
| `-pocketsphinx_bin` | `pocketsphinx_continuous` | Path to the PocketSphinx binary |
| `-hmm` | (built-in en-us model) | Optional path to an acoustic model directory |
| `-dict` | (none) | Optional path to a pronunciation dictionary |
| `-camera_cmd` | `libcamera-vid -t 10000 -o /home/pi/clip.h264` | Command to run when the keyphrase is spotted |
| `-cooldown` | `3s` | Minimum time between triggers |

## Known limitations

PocketSphinx's keyword spotting is noticeably less robust than commercial
engines (Porcupine, Vosk) — especially on a noisy construction site through a
helmet-mounted mic. Expect to spend real time tuning the threshold and mic
gain/placement before this is reliable enough to build on.
