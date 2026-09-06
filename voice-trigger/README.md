# voice-trigger

Standalone test program: listens on the microphone for a spotted keyphrase
(via PocketSphinx) and runs a shell command — by default a short
`libcamera-vid` capture — when it fires. Not part of the real hard-hat agent;
this is a bench-test rig for mic + wake-phrase + camera, validated on a
MacBook before deploying to the Raspberry Pi.

## Files

- `main.go` — the program. Shells out to `-listen_cmd` (default:
  `python3 kws_listen.py`), watches its stdout, and runs `-camera_cmd` on
  every spotted line (debounced by `-cooldown`, default 3s). It has no idea
  what CLI flags the listener itself uses — that's deliberate, so swapping
  STT backends later doesn't require touching Go code again.
- `kws_listen.py` — thin wrapper around pocketsphinx's `LiveSpeech`, printing
  one flushed line per spotted keyphrase. Accepts `--hmm`/`--dict` overrides
  for platforms where the bundled model data isn't available (see the Pi
  section below).
- `mic_test.py` — records a few seconds of audio and prints peak/RMS level,
  to check the mic itself is working before blaming PocketSphinx.
- `download_models.sh` — downloads CMU Sphinx's en-us acoustic model +
  dictionary directly (needed only on platforms with no prebuilt PocketSphinx
  wheel, i.e. Raspberry Pi's aarch64).
- `keyword.list` — PocketSphinx keyword-spotting list. Validated working
  entries: `turn on camera /1e-50/` and `camera /1e-50/`. See "Tuning the
  threshold" below for why `/1e-50/`, not the more conservative `/1e-40/` we
  started with.
- `go.mod` — pure Go stdlib, no third-party dependencies.

## pocketsphinx's model path layout (important, easy to get wrong)

pocketsphinx 5.x nests its bundled model under `get_model_path()` as:

```
<model_path>/en-us/en-us/            <- the acoustic model (mdef, means, variances, ...)
<model_path>/en-us/cmudict-en-us.dict  <- the dictionary
```

This is *not* the flat `en-us/` + `cmudict-en-us.dict` layout older
docs/examples describe — `kws_listen.py`'s defaults already account for this
(verified against an actual 5.1.1 install). If you ever see
`RuntimeError: Failed to initialize PocketSphinx` after a clean pip install,
check this layout with `--verbose` before assuming anything else is wrong.

## Testing locally on macOS first (recommended before touching the Pi)

```bash
cd /Users/femi/dev/hardhat/voice-trigger
python3 -m venv venv
source venv/bin/activate
pip install pocketsphinx numpy
```

PocketSphinx ships a prebuilt `universal2` wheel for macOS (covers both Intel
and Apple Silicon) with model data bundled in, so no manual model download is
needed here — that's only required on the Pi.

Check the mic is actually capturing signal:
```bash
python3 mic_test.py
```

Then test keyword spotting for real, in a normal Terminal window (not
through an agent — it needs an interactive mic-permission prompt the first
time):
```bash
python3 kws_listen.py --verbose
```
Say "turn on camera" — you should see it printed back. Ctrl-C to stop.

Once that works, test the full Go program the same way:
```bash
go build -o voice-trigger .
./voice-trigger -camera_cmd "echo CAMERA TRIGGERED"
```

## Tuning the threshold

`keyword.list` entries are `KEYPHRASE /THRESHOLD/`. Smaller (more negative
exponent, e.g. `1e-50`) is *more* lenient — easier to trigger, more false
positives. Larger (e.g. `1e-10`) is stricter.

`/1e-40/` produced zero detections in testing even with a clearly healthy
mic signal; `/1e-50/` worked reliably. Treat `1e-50` as the current known-good
starting point, not a hard rule — re-tune if you change mic, environment, or
phrase. Multi-word phrases ("turn on camera") are inherently harder for a
generic, non-adapted acoustic model to spot than a single distinctive word
("camera") — if detection is unreliable on the full phrase, that's the first
thing to simplify.

Note that keeping both `turn on camera` and `camera` in the list means
saying the full phrase can fire both matches independently (you may see
`camera` reported once or twice before `turn on camera`) — the Go program's
`-cooldown` (default 3s) absorbs this so the camera command doesn't
double-fire, but drop the `camera` line if you only want the full phrase to
count.

## Running on Raspberry Pi OS Lite (headless, over SSH)

### 1. Install PocketSphinx (via pip, not apt)

`pocketsphinx-utils` / `pocketsphinx_continuous` were dropped from Debian's
repos on newer releases (Bookworm+ only ships the library, not the CLI), so
apt won't get you a working keyword spotter there. Use the pip package
instead:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y build-essential git python3-pip python3-venv libportaudio2

python3 -m venv ~/voice-trigger-venv
source ~/voice-trigger-venv/bin/activate
pip install pocketsphinx numpy
```

(Raspberry Pi OS Bookworm's system Python blocks plain `pip install` outside
a venv — the venv above is the clean way around that. Also note: this
version of pocketsphinx depends on `sounddevice`, not the older `pyaudio` —
`libportaudio2` covers its runtime needs.)

### 2. Get the model files — PocketSphinx has no arm64 wheel

Unlike macOS/x86_64, there's no prebuilt PocketSphinx wheel for Raspberry
Pi's aarch64, so pip builds from source — and that source build does **not**
bundle the acoustic model data (only the prebuilt wheels do). Download CMU
Sphinx's model files directly instead (plain data, works on any
architecture):

```bash
cd ~/voice-trigger
./download_models.sh
```

This downloads into `~/voice-trigger/models/`. Confirm what actually
extracted:
```bash
ls ~/voice-trigger/models
```
You should see `cmusphinx-en-us-5.2/` (the acoustic model — pass this whole
directory as `--hmm`) and `cmudict.dict` (pass as `--dict`).

Sanity-check it on its own before involving Go at all:
```bash
python3 ~/voice-trigger/kws_listen.py --verbose \
    --hmm ~/voice-trigger/models/cmusphinx-en-us-5.2 \
    --dict ~/voice-trigger/models/cmudict.dict
```
Say "turn on camera" — you should see it printed back. Ctrl-C to stop.

If the mic doesn't seem to be picking anything up, run `mic_test.py` (needs
`numpy`, already installed above) to check the raw signal level before
suspecting PocketSphinx itself.

### 3. Install Go

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
./voice-trigger \
    -listen_cmd "$HOME/voice-trigger-venv/bin/python3 kws_listen.py --hmm $HOME/voice-trigger/models/cmusphinx-en-us-5.2 --dict $HOME/voice-trigger/models/cmudict.dict" \
    -camera_cmd "echo CAMERA TRIGGERED"
```

Say "turn on camera" into the mic and watch for `spotted: ...` in the log.
Once detection is reliable, drop the `-camera_cmd` override to use the real
`libcamera-vid` default, or point it at your own capture command.

### 7. Keep it running past your SSH session (optional)

```bash
sudo apt install -y tmux
tmux new -s voicetrigger
./voice-trigger -listen_cmd "$HOME/voice-trigger-venv/bin/python3 kws_listen.py --hmm $HOME/voice-trigger/models/cmusphinx-en-us-5.2 --dict $HOME/voice-trigger/models/cmudict.dict"
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

`kws_listen.py` itself takes `--kws <path>`, `--hmm <path>`, `--dict <path>`,
and `--verbose`.

## Known limitations

PocketSphinx's keyword spotting is noticeably less robust than commercial
engines (Porcupine, Vosk) — especially on a noisy construction site through a
helmet-mounted mic. Expect to spend real time tuning the threshold and mic
gain/placement, and consider simplifying to a single distinctive word if the
full phrase proves unreliable in the field.
