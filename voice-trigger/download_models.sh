#!/usr/bin/env bash
# Downloads CMU Sphinx's en-us acoustic model and pronunciation dictionary.
#
# These are plain data files (not compiled binaries), so this works on any
# architecture — needed because pip-installed pocketsphinx has no prebuilt
# wheel for Raspberry Pi's aarch64 and its from-source build doesn't bundle
# the model data that the wheels normally include.
#
# Usage: ./download_models.sh [output_dir]   (default: ./models)

set -euo pipefail

OUT_DIR="${1:-$(dirname "$0")/models}"
ACOUSTIC_URL="https://sourceforge.net/projects/cmusphinx/files/Acoustic%20and%20Language%20Models/US%20English/cmusphinx-en-us-5.2.tar.gz/download"
DICT_URL="https://sourceforge.net/projects/cmusphinx/files/Acoustic%20and%20Language%20Models/US%20English/cmudict-en-us.dict/download"

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
fetch "$DICT_URL" "cmudict-en-us.dict"

if ! file "cmusphinx-en-us-5.2.tar.gz" | grep -qi gzip; then
    echo "cmusphinx-en-us-5.2.tar.gz doesn't look like a real archive (likely an HTML error page)." >&2
    echo "SourceForge's filenames may have changed - browse:" >&2
    echo "  https://sourceforge.net/projects/cmusphinx/files/Acoustic%20and%20Language%20Models/US%20English/" >&2
    exit 1
fi

if ! file "cmudict-en-us.dict" | grep -qiE 'ascii|text'; then
    echo "cmudict-en-us.dict doesn't look like a real text file (likely an HTML error page)." >&2
    exit 1
fi

tar xzf "cmusphinx-en-us-5.2.tar.gz"

echo
echo "done. Contents of $OUT_DIR:"
ls "$OUT_DIR"
echo
echo "Point kws_listen.py at the extracted acoustic model directory above, e.g.:"
echo "  python3 kws_listen.py --hmm \"$OUT_DIR/en-us\" --dict \"$OUT_DIR/cmudict-en-us.dict\""
