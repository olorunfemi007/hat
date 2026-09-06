#!/usr/bin/env python3
"""Live keyword spotting via pocketsphinx's LiveSpeech.

Prints one line to stdout, flushed immediately, each time the keyphrase list
is matched. Meant to be run as a subprocess of voice-trigger's main.go, but
can be run standalone too: `python3 kws_listen.py`.
"""
import argparse
import os
import sys

from pocketsphinx import LiveSpeech, get_model_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--kws",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "keyword.list"),
        help="Path to the keyword-spotting list file (KEYPHRASE /THRESHOLD/ per line)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Have pocketsphinx log its own diagnostics to stderr instead of a hidden log file",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.kws):
        sys.exit(f"keyword list file not found: {args.kws}")

    model_path = get_model_path()
    hmm_dir = os.path.join(model_path, "en-us")
    dict_path = os.path.join(model_path, "cmudict-en-us.dict")

    print(f"model_path: {model_path}", file=sys.stderr)
    for label, p in (("hmm", hmm_dir), ("dict", dict_path)):
        print(f"  {label}: {p} ({'exists' if os.path.exists(p) else 'MISSING'})", file=sys.stderr)
    if os.path.isdir(hmm_dir):
        print(f"  hmm contents: {sorted(os.listdir(hmm_dir))}", file=sys.stderr)

    if not os.path.isdir(hmm_dir) or not os.path.isfile(dict_path):
        sys.exit(
            "pocketsphinx's bundled model files are missing under get_model_path(). "
            "This is a known issue when pip has to build pocketsphinx from source "
            "(no prebuilt wheel for your Python version) — the model data sometimes "
            "isn't included in that build. Try creating the venv with an older "
            "interpreter (e.g. python3.11) so pip can use a prebuilt wheel instead."
        )

    speech = LiveSpeech(
        verbose=args.verbose,
        sampling_rate=16000,
        buffer_size=2048,
        no_search=False,
        full_utt=False,
        hmm=hmm_dir,
        lm=False,
        dic=dict_path,
        kws=args.kws,
    )

    for phrase in speech:
        print(str(phrase), flush=True)


if __name__ == "__main__":
    main()
