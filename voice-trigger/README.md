# voice-trigger

Standalone test program: listens on the microphone for a spotted keyphrase
(via PocketSphinx) and runs a shell command — by default a short
`libcamera-vid` capture — when it fires. Not part of the real hard-hat agent;
this is a bench-test rig for mic + wake-phrase + camera on a Raspberry Pi
before wiring the behavior into the actual edge agent.

## Files

- `main.go` — the program. Shells out to `-listen_cmd` (default:
  `python3 kws_listen.py`), watches its stdout, and runs `-camera_cmd` on
  every spotted line (debounced by `-cooldown`, default 3s). It has no idea
  what CLI flags the listener itself uses — that's deliberate, so swapping
  STT backends later doesn't require touching Go code again.
- `kws_listen.py` — thin wrapper around pocketsphinx's `LiveSpeech`, printing
  one flushed line per spotted keyphrase.
- `keyword.list` — PocketSphinx keyword-spotting list. Default entry:
  `turn on camera /1e-40/`. The threshold controls sensitivity — a more
  negative exponent (e.g. `1e-50`) triggers more easily but with more false
  positives; a less negative one (e.g. `1e-10`) is stricter. Tune by ear
  against your actual mic and ambient noise.
- `go.mod` — pure Go stdlib, no third-party dependencies.

## Running on Raspberry Pi OS Lite (headless, over SSH)

### 1. Install PocketSphinx (via pip, not apt)

`pocketsphinx-utils` / `pocketsphinx_continuous` were dropped from Debian's
repos on newer releases (Bookworm+ only ships the library, not the CLI), so
apt won't get you a working keyword spotter there. Use the pip package
instead, which is actively maintained and bundles its own model files:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y build-essential git python3-pip python3-venv portaudio19-dev

python3 -m venv ~/voice-trigger-venv
source ~/voice-trigger-venv/bin/activate
pip install pocketsphinx pyaudio
```

(Raspberry Pi OS Bookworm's system Python blocks plain `pip install` outside
a venv — the venv above is the clean way around that.)

Sanity-check it on its own before involving Go at all:

```bash
python3 ~/voice-trigger/kws_listen.py
```
Say "turn on camera" — you should see it printed back to the terminal.
Ctrl-C to stop.

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

# sanity-check detection first, without touching the camera.
# Point -listen_cmd at the venv's python so it can see the pip-installed packages.
./voice-trigger \
    -listen_cmd "$HOME/voice-trigger-venv/bin/python3 kws_listen.py" \
    -camera_cmd "echo CAMERA TRIGGERED"
```

Say "turn on camera" into the mic and watch for `spotted: ...` in the log.
Once detection is reliable, drop the `-camera_cmd` override to use the real
`libcamera-vid` default, or point it at your own capture command.

### 7. Keep it running past your SSH session (optional)

```bash
sudo apt install -y tmux
tmux new -s voicetrigger
./voice-trigger -listen_cmd "$HOME/voice-trigger-venv/bin/python3 kws_listen.py"
# Ctrl-b then d to detach; `tmux attach -t voicetrigger` to reattach
```

For something more permanent than a foreground/tmux test, run it as a
systemd service instead — not set up yet, ask if you want it added.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `-listen_cmd` | `python3 kws_listen.py` | Command whose stdout prints one line per spotted keyphrase |
| `-camera_cmd` | `libcamera-vid -t 10000 -o /home/pi/clip.h264` | Command to run when the keyphrase is spotted |
| `-cooldown` | `3s` | Minimum time between triggers |

`kws_listen.py` itself takes `--kws <path>` (default: `keyword.list` next to
the script) if you want to point it at a different keyword list.

## Known limitations

PocketSphinx's keyword spotting is noticeably less robust than commercial
engines (Porcupine, Vosk) — especially on a noisy construction site through a
helmet-mounted mic. Expect to spend real time tuning the threshold and mic
gain/placement before this is reliable enough to build on.
