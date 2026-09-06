#!/usr/bin/env python3
"""Live keyword spotting via pocketsphinx, fed by raw audio from `arecord`.

Prints one line to stdout, flushed immediately, each time the keyphrase list
is matched. Meant to be run as a subprocess of voice-trigger's main.go, but
can be run standalone too: `python3 kws_listen.py`.

pocketsphinx 5.x nests its bundled model under get_model_path() as
en-us/en-us (the acoustic model) and en-us/cmudict-en-us.dict (the
dictionary) — not the flat en-us/ + cmudict-en-us.dict layout older docs
describe. Confirmed by inspecting an actual install (5.1.1).

On platforms with no prebuilt PyPI wheel, `pip install pocketsphinx` builds
from source and does NOT bundle the acoustic model data at all (that's only
included in the prebuilt wheels). In that case pass --hmm and --dict
explicitly, pointing at manually downloaded CMU Sphinx model files, instead
of relying on get_model_path().

Audio comes from `arecord`, not pocketsphinx's own LiveSpeech/sounddevice
capture. On at least one Raspberry Pi + HAT sound card combo tested,
PortAudio's ALSA introspection reported 0 input channels for every
named/virtual ALSA device (sysdefault, default, dmix, and any custom `plug`
wrapper) even though `arecord` captures from the same hardware fine. Rather
than depend on PortAudio's introspection at all, arecord's own `plughw`
addressing handles channel/rate conversion (e.g. a stereo-only HAT codec
down-mixed to the mono 16kHz pocketsphinx needs), and its raw output is fed
straight into pocketsphinx's Decoder via process_raw().
"""
import argparse
import os
import signal
import subprocess
import sys

from pocketsphinx import Pocketsphinx, get_model_path

CHUNK_BYTES = 2048  # 1024 mono int16 samples per read


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--list_devices",
        action="store_true",
        help="List ALSA PCM devices (via `arecord -L`) and exit",
    )
    parser.add_argument(
        "--alsa_device",
        default="plughw:0,0",
        help="ALSA device passed to arecord's -D flag. `plughw:CARD,DEVICE` lets ALSA "
        "convert channel count/rate for hardware that doesn't natively support what "
        "pocketsphinx needs (mono, 16kHz). Check `arecord -l` for your card/device numbers.",
    )
    parser.add_argument(
        "--arecord_bin",
        default="arecord",
        help="Path to the arecord binary",
    )
    parser.add_argument(
        "--kws",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "keyword.list"),
        help="Path to the keyword-spotting list file (KEYPHRASE /THRESHOLD/ per line)",
    )
    parser.add_argument(
        "--hmm",
        default=None,
        help="Path to the acoustic model directory. Default: <get_model_path()>/en-us/en-us",
    )
    parser.add_argument(
        "--dict",
        dest="dict_path",
        default=None,
        help="Path to the pronunciation dictionary. Default: <get_model_path()>/en-us/cmudict-en-us.dict",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Have pocketsphinx log its own diagnostics to stderr instead of a hidden log file",
    )
    args = parser.parse_args()

    if args.list_devices:
        subprocess.run(["arecord", "-L"])
        return

    if not os.path.isfile(args.kws):
        sys.exit(f"keyword list file not found: {args.kws}")

    model_path = get_model_path()
    hmm_dir = args.hmm or os.path.join(model_path, "en-us", "en-us")
    dict_path = args.dict_path or os.path.join(model_path, "en-us", "cmudict-en-us.dict")

    print(f"hmm:  {hmm_dir} ({'exists' if os.path.isdir(hmm_dir) else 'MISSING'})", file=sys.stderr)
    print(f"dict: {dict_path} ({'exists' if os.path.isfile(dict_path) else 'MISSING'})", file=sys.stderr)

    if not os.path.isdir(hmm_dir) or not os.path.isfile(dict_path):
        sys.exit(
            "Model files not found at the paths above. If pip built pocketsphinx from "
            "source (no prebuilt wheel for this platform), get_model_path() won't have "
            "real data — download CMU Sphinx's en-us acoustic model and dictionary "
            "manually and pass --hmm/--dict pointing at them."
        )

    decoder = Pocketsphinx(
        verbose=args.verbose,
        hmm=hmm_dir,
        lm=False,
        dic=dict_path,
        kws=args.kws,
        samprate=16000,
    )

    arecord_cmd = [
        args.arecord_bin,
        "-D", args.alsa_device,
        "-f", "S16_LE",
        "-r", "16000",
        "-c", "1",
        "-t", "raw",
        "-q",
    ]
    print(f"running: {' '.join(arecord_cmd)}", file=sys.stderr)
    proc = subprocess.Popen(arecord_cmd, stdout=subprocess.PIPE)

    def shutdown(signum, frame):
        proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)

    decoder.start_utt()
    try:
        while True:
            buf = proc.stdout.read(CHUNK_BYTES)
            if not buf:
                stderr = proc.stderr.read() if proc.stderr else b""
                sys.exit(f"arecord exited unexpectedly (rc={proc.poll()}). {stderr.decode(errors='replace')}")

            decoder.process_raw(buf, False, False)

            if decoder.hyp() is not None:
                print(decoder.hypothesis(), flush=True)
                decoder.end_utt()
                decoder.start_utt()
    except KeyboardInterrupt:
        pass
    finally:
        decoder.end_utt()
        proc.terminate()


if __name__ == "__main__":
    main()
