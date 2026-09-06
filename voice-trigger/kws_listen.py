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
    args = parser.parse_args()

    if not os.path.isfile(args.kws):
        sys.exit(f"keyword list file not found: {args.kws}")

    model_path = get_model_path()

    speech = LiveSpeech(
        verbose=False,
        sampling_rate=16000,
        buffer_size=2048,
        no_search=False,
        full_utt=False,
        hmm=os.path.join(model_path, "en-us"),
        lm=False,
        dic=os.path.join(model_path, "cmudict-en-us.dict"),
        kws=args.kws,
    )

    for phrase in speech:
        print(str(phrase), flush=True)


if __name__ == "__main__":
    main()
