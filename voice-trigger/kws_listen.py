#!/usr/bin/env python3
"""Live keyword spotting via pocketsphinx's LiveSpeech.

Prints one line to stdout, flushed immediately, each time the keyphrase list
is matched. Meant to be run as a subprocess of voice-trigger's main.go, but
can be run standalone too: `python3 kws_listen.py`.

pocketsphinx 5.x nests its bundled model under get_model_path() as
en-us/en-us (the acoustic model) and en-us/cmudict-en-us.dict (the
dictionary) — not the flat en-us/ + cmudict-en-us.dict layout older docs
describe. Confirmed by inspecting an actual install (5.1.1).

On platforms with no prebuilt PyPI wheel (e.g. Raspberry Pi's aarch64),
`pip install pocketsphinx` builds from source and does NOT bundle the
acoustic model data at all (that's only included in the prebuilt wheels).
In that case pass --hmm and --dict explicitly, pointing at manually
downloaded CMU Sphinx model files, instead of relying on get_model_path().
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

    if not os.path.isfile(args.kws):
        sys.exit(f"keyword list file not found: {args.kws}")

    model_path = get_model_path()
    hmm_dir = args.hmm or os.path.join(model_path, "en-us", "en-us")
    dict_path = args.dict_path or os.path.join(model_path, "en-us", "cmudict-en-us.dict")

    print(f"hmm:  {hmm_dir} ({'exists' if os.path.isdir(hmm_dir) else 'MISSING'})", file=sys.stderr)
    print(f"dict: {dict_path} ({'exists' if os.path.isfile(dict_path) else 'MISSING'})", file=sys.stderr)
    if os.path.isdir(hmm_dir):
        print(f"hmm contents: {sorted(os.listdir(hmm_dir))}", file=sys.stderr)

    if not os.path.isdir(hmm_dir) or not os.path.isfile(dict_path):
        sys.exit(
            "Model files not found at the paths above. If pip built pocketsphinx from "
            "source (no prebuilt wheel for this platform), get_model_path() won't have "
            "real data — download CMU Sphinx's en-us acoustic model and dictionary "
            "manually and pass --hmm/--dict pointing at them."
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
