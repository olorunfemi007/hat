# voice-trigger

Listens on the microphone for camera commands via PocketSphinx. The default
camera action records a distinct MP4 and queues it for verified company storage.
The existing `-camera_cmd` override still supports hardware/bench commands.
“Turn off camera” gracefully finishes the current clip; repeated camera-on
detections do not interrupt a recording. Light actions have optional independent
command hooks; no light driver or GPIO assignments are implemented.

For installation, automatic startup, storage setup and offline behavior, follow
[the capture/sync runbook](../device-agent/SYNC.md). The bench checks below still
work with `-camera_cmd "echo CAMERA TRIGGERED"`.

## Files

- `main.go` — the program. Shells out to `-listen_cmd` (default:
  `python3 kws_listen.py`), watches its stdout, and runs `-camera_cmd` on
  camera-on phrases (debounced by `-cooldown`, default 3s). Camera-off stops
  the current command; unknown phrases are ignored. It has no idea
  what CLI flags the listener itself uses — that's deliberate, so swapping
  STT backends later doesn't require touching Go code again.
- `kws_listen.py` — captures through `arecord` and uses PocketSphinx voice
  activity detection to finish each spoken phrase before accepting one command. Accepts `--hmm`/`--dict` overrides
  for platforms where the bundled model data isn't available (see the Pi
  section below).
- `mic_test.py` — records a few seconds of audio and prints peak/RMS level,
  to check the mic itself is working before blaming PocketSphinx.
- `download_models.sh` — downloads CMU Sphinx's en-us acoustic model +
  dictionary directly (needed only on platforms with no prebuilt PocketSphinx
  wheel, i.e. Raspberry Pi's aarch64).
- `keyword.list` — PocketSphinx keyword-spotting list with `start camera`,
  `stop camera`, `start recording`, and `stop recording`. Short overlapping aliases are deliberately excluded. See "Tuning the
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
Say "start camera" — you should see `turn on camera` printed (the internal camera action). Ctrl-C to stop.

Once that works, test the full Go program the same way:
```bash
go build -o voice-trigger .
./voice-trigger -camera_cmd "echo CAMERA TRIGGERED"
```

## Tuning the threshold

`keyword.list` entries are `KEYPHRASE /THRESHOLD/`. Smaller (more negative
exponent, e.g. `1e-50`) is *more* lenient — easier to trigger, more false
positives. Larger (e.g. `1e-10`) is stricter.

The default remains `/1e-50/`, which previously detected speech on the Pi
where `/1e-40/` did not. It is a starting point for your microphone, not a
universal accuracy setting. Increase the threshold gradually if false matches
persist, and test both commands against recordings from the actual helmet.

A 300 ms audio buffer before detected speech preserves quiet initial consonants
such as the “st” in “start.” The listener waits for a short silence (roughly 0.3 seconds) before acting.
It retains all keyword candidates within that speech region, then runs a second
PocketSphinx pass using a command grammar. That pass compares complete phrases
against one another instead of detecting each keyword independently. An action
requires a single complete command from the grammar that also matched the
keyword search. Disagreement or multiple recognized commands logs `Rejected
speech` and does neither; pause and repeat the intended command. Commands spoken
without a silence between them may be rejected together. Speech longer than
8 seconds is discarded until silence, and recorder failure cannot execute an
unfinished phrase.

Use **“start camera”** / **“stop camera”** or **“start recording”** /
**“stop recording”** with the default keyword list. Do not add
`camera`, `on camera`, or `off camera`: the listener intentionally ignores those
fragments. The Go cooldown only limits repeated identical actions; it cannot
resolve recognition of opposing commands. Optional full light phrases and
`turn on camera` / `turn off camera` are supported if added to the keyword list. Spoken start/stop phrases are
normalized to the existing internal `turn on camera` / `turn off camera` actions,
so the Go dispatcher does not need rebuilding. Changing only `keyword.list` is
not sufficient for a new phrase: it must also exist in `kws_listen.py`’s
`COMMANDS` map, which supplies the verification grammar.
This change does not require a light driver.

### Low-frequency noise filter

A first-order high-pass filter at **120 Hz** runs before voice activity detection,
the pre-speech buffer, and both recognition passes. It reduces low-frequency
rumble and DC offset without additional packages. It keeps two state values
between frames and processes 16,000 samples per second; no FFT or background
process is needed. Recorded camera audio is unaffected.

Add `--highpass_hz 0` to the Python listener command to disable it for comparison,
or `--highpass_hz 100` to set another cutoff. Live input and `--wav` replay use
the same filter. For the installed service, change `HARDHAT_LISTEN_CMD` in
`/etc/hardhat/voice-trigger.env` and restart the voice service. The default is
a starting point, not an industrial-noise calibration: it cannot remove noise
that overlaps speech frequencies or repair microphone clipping.

Validation covers frequency response, DC removal, full-scale input, continuity
between audio frames, bypass, and invalid settings. All four generated command
samples also passed recognition with the filter, both clean and with an added
60 Hz tone (500 PCM units peak). These are synthetic checks, not factory audio
or Pi Zero W performance measurements; verify both with the deployed helmet.

### Update an existing Pi installation

From the updated repository directory on the Pi:

```bash
sudo install -m 0644 voice-trigger/kws_listen.py voice-trigger/keyword.list /opt/hardhat/voice-trigger/
sudo systemctl restart hardhat-voice.service
sudo journalctl -u hardhat-voice.service -f
```

This uses the existing service and PocketSphinx 5.1.1 environment. If your
`HARDHAT_LISTEN_CMD` specifies a custom `--kws` path, update that file as well.
Say each command separately, leaving a brief silence after it. Expect one
camera action per accepted phrase.

### Replay microphone recordings and run regression tests

To diagnose accuracy without starting the camera, stop the service temporarily
and capture a test WAV (substitute your configured ALSA device). Include a second
of silence before and after each command:

```bash
sudo systemctl stop hardhat-voice.service
arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -t wav -d 15 /tmp/voice-check.wav
/opt/hardhat/voice-trigger/venv/bin/python3 /opt/hardhat/voice-trigger/kws_listen.py --wav /tmp/voice-check.wav --verbose
sudo systemctl start hardhat-voice.service
```

Replay only prints accepted commands; it does not control the camera. Diagnostics
go to stderr. The file must be mono, 16-bit, uncompressed PCM at 16 kHz.
Keep diagnostic recordings private and delete them when finished.

From this repository, run the listener regressions without a microphone or
PocketSphinx installation:

```bash
python3 -m unittest discover -s voice-trigger -p 'test_*.py' -v
```

These cover conflicting/transient matches, repeated detections, separate on/off
phrases, grammar confirmation and disagreement, ignored fragments, interrupted
audio, and recovery after long speech.
Actual recognition accuracy still depends on microphone placement, background
noise, pronunciation, and threshold calibration.

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
Say "start camera" — you should see `turn on camera` printed (the internal camera action). Ctrl-C to stop.

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

Say "start camera" into the mic and watch for `spotted: ...` in the log.
Once detection is reliable, follow [the capture/sync runbook](../device-agent/SYNC.md)
to install and run the default durable recorder. You can also point
`-camera_cmd` at your existing camera command for a standalone hardware check.
That custom command only queues data if it invokes the capture wrapper.

### 7. Keep it running past your SSH session (optional)

```bash
sudo apt install -y tmux
tmux new -s voicetrigger
./voice-trigger -listen_cmd "$HOME/voice-trigger-venv/bin/python3 kws_listen.py --hmm $HOME/voice-trigger/models/cmusphinx-en-us-5.2 --dict $HOME/voice-trigger/models/cmudict.dict"
# Ctrl-b then d to detach; `tmux attach -t voicetrigger` to reattach
```

For automatic startup use `setup_capture_service.sh` and `hardhat-voice.service`,
as described in [the capture/sync runbook](../device-agent/SYNC.md). Stop the
foreground/tmux listener before starting the service to free the microphone.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `-listen_cmd` | `python3 kws_listen.py` | Command whose stdout prints one line per spotted keyphrase |
| `-camera_cmd` | `/usr/bin/python3 -B /opt/hardhat/device-agent/capture.py` | Record, finalize and queue a unique MP4 clip |
| `-light_on_cmd` | empty | Optional executable for light-on phrases |
| `-light_off_cmd` | empty | Optional executable for light-off phrases |
| `-cooldown` | `3s` | Minimum time between identical actions; camera-off is independent of camera-on |

`kws_listen.py` itself takes `--kws <path>`, `--hmm <path>`, `--dict <path>`,
and `--verbose`.

## Known limitations

PocketSphinx's keyword spotting is noticeably less robust than commercial
engines (Porcupine, Vosk) — especially on a noisy construction site through a
helmet-mounted mic. Expect to spend real time tuning the threshold and mic
gain/placement, and consider simplifying to a single distinctive word if the
full phrase proves unreliable in the field.
