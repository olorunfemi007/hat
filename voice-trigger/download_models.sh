#!/usr/bin/env bash
# Downloads CMU Sphinx's en-us acoustic model and pronunciation dictionary.
#
# LAST RESORT: prefer letting `pip install pocketsphinx` fetch its own
# matched wheel first (see setup_pi.sh) - PyPI does have real aarch64 wheels
# with correctly-paired model data. Only reach for this script if that wheel
# isn't available for your Python version/arch and pip had to build from
# source (which doesn't bundle model data at all).
#
# KNOWN ISSUE: the acoustic model here (SourceForge) and cmudict.dict here
# (GitHub cmusphinx/cmudict) are NOT a verified matched pair - the acoustic
# model's phone set may not include stress-marked phones (AH1, ER0, UW2,
# etc.) that this dictionary uses for nearly every word, causing most of the
# dictionary - including basic words - to be rejected at load time. If you
# hit a wall of "Phone ... is missing in the acoustic model" errors, this is
# why; you need a dictionary phone-set-matched to cmusphinx-en-us-5.2
# specifically, not the raw GitHub cmudict.
#
# Usage: ./download_models.sh [output_dir]   (default: ./models)

set -euo pipefail

OUT_DIR="${1:-$(dirname "$0")/models}"
ACOUSTIC_URL="https://sourceforge.net/projects/cmusphinx/files/Acoustic%20and%20Language%20Models/US%20English/cmusphinx-en-us-5.2.tar.gz/download"
DICT_URL="https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

fetch() {
    local url="$1" out="$2"
    if [ -s "$out" ]; then
        echo "already have $out, skipping download"
        return
    fi
    echo "downloading $out ..."
    if command -v curl >/dev/null 2>&1; then
        curl -fL -o "$out" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$out" "$url"
    else
        echo "neither curl nor wget is available" >&2
        exit 1
    fi
}

fetch "$ACOUSTIC_URL" "cmusphinx-en-us-5.2.tar.gz"
fetch "$DICT_URL" "cmudict.dict"

if ! file "cmusphinx-en-us-5.2.tar.gz" | grep -qi gzip; then
    echo "cmusphinx-en-us-5.2.tar.gz doesn't look like a real archive (likely an HTML error page)." >&2
    echo "SourceForge's filenames may have changed - browse:" >&2
    echo "  https://sourceforge.net/projects/cmusphinx/files/Acoustic%20and%20Language%20Models/US%20English/" >&2
    exit 1
fi

if ! file "cmudict.dict" | grep -qiE 'ascii|text'; then
    echo "cmudict.dict doesn't look like a real text file (likely an HTML error page)." >&2
    exit 1
fi

EXTRACT_DIR="cmusphinx-en-us-5.2"
if [ -d "$EXTRACT_DIR" ]; then
    echo "already extracted to $OUT_DIR/$EXTRACT_DIR, skipping"
else
    tar xzf "cmusphinx-en-us-5.2.tar.gz"
fi

echo
echo "done. Contents of $OUT_DIR:"
ls "$OUT_DIR"
echo
echo "Point kws_listen.py at the extracted acoustic model directory above, e.g.:"
echo "  python3 kws_listen.py --hmm \"$OUT_DIR/$EXTRACT_DIR\" --dict \"$OUT_DIR/cmudict.dict\""
