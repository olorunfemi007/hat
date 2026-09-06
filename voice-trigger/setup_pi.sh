#!/usr/bin/env bash
# One-shot setup for voice-trigger on Raspberry Pi OS Lite (headless).
# Installs apt deps, Go, a Python venv with pocketsphinx, and builds the Go
# binary. Safe to re-run — each step skips itself if already done.
#
# PyPI does have a real manylinux aarch64 wheel for pocketsphinx (with
# correctly-matched bundled model data) for Python 3.11, which is what
# Debian Bookworm / current Pi OS ships. So the primary path is just a plain
# `pip install` — this only falls back to manually downloading CMU Sphinx's
# model files if that didn't actually produce bundled data (e.g. a different
# Python version with no wheel, forcing a from-source build). The fallback
# combo (SourceForge acoustic model + GitHub cmudict.dict) is NOT
# phone-set-compatible without care - see download_models.sh's caveat.
#
# Usage: ./setup_pi.sh

set -euo pipefail

GO_VERSION="1.27.1"
VENV_DIR="$HOME/voice-trigger-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/5] apt packages"
sudo apt-get update
sudo apt-get install -y build-essential git python3-pip python3-venv libportaudio2

echo "==> [2/5] Go toolchain"
if command -v go >/dev/null 2>&1; then
    echo "go already installed: $(go version)"
else
    case "$(uname -m)" in
        aarch64) GO_ARCH="arm64" ;;
        armv7l|armv6l) GO_ARCH="armv6l" ;;
        x86_64) GO_ARCH="amd64" ;;
        *) echo "unrecognized architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    TARBALL="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
    echo "downloading $TARBALL ..."
    curl -LO "https://go.dev/dl/${TARBALL}"
    sudo tar -C /usr/local -xzf "$TARBALL"
    rm -f "$TARBALL"
    if ! grep -q '/usr/local/go/bin' "$HOME/.bashrc" 2>/dev/null; then
        echo 'export PATH=$PATH:/usr/local/go/bin' >> "$HOME/.bashrc"
    fi
    export PATH="$PATH:/usr/local/go/bin"
    echo "installed: $(go version)"
fi

echo "==> [3/5] Python venv + pocketsphinx"
echo "python3 is: $(python3 --version)"
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install pocketsphinx numpy -q
echo "venv ready at $VENV_DIR"

echo "==> [4/5] Verifying bundled model data"
if "$VENV_DIR/bin/python3" -c "
from pocketsphinx import get_model_path
import os, sys
p = get_model_path()
sys.exit(0 if os.path.isdir(os.path.join(p, 'en-us', 'en-us')) else 1)
"; then
    echo "bundled model data present - no manual download needed"
    USE_MANUAL_MODELS=0
else
    echo "no bundled model data (likely no wheel for this Python/arch combo - pip built from source)."
    echo "falling back to manual CMU Sphinx model download."
    "$SCRIPT_DIR/download_models.sh"
    USE_MANUAL_MODELS=1
fi

echo "==> [5/5] Building voice-trigger"
export PATH="$PATH:/usr/local/go/bin"
(cd "$SCRIPT_DIR" && go build -o voice-trigger .)

echo
echo "==> Setup complete. Test it with:"
echo
echo "  cd $SCRIPT_DIR"
if [ "$USE_MANUAL_MODELS" -eq 0 ]; then
    echo "  ./voice-trigger \\"
    echo "      -listen_cmd \"$VENV_DIR/bin/python3 kws_listen.py\" \\"
    echo "      -camera_cmd \"echo CAMERA TRIGGERED\""
else
    MODEL_DIR="$SCRIPT_DIR/models"
    echo "  ./voice-trigger \\"
    echo "      -listen_cmd \"$VENV_DIR/bin/python3 kws_listen.py --hmm $MODEL_DIR/cmusphinx-en-us-5.2 --dict $MODEL_DIR/cmudict.dict\" \\"
    echo "      -camera_cmd \"echo CAMERA TRIGGERED\""
    echo
    echo "  NOTE: this fallback pairing has a known phone-set mismatch between"
    echo "  the acoustic model and dictionary that can cause most words to be"
    echo "  rejected. If kws_listen.py logs lots of 'Phone ... is missing in"
    echo "  the acoustic model' errors, this needs a properly matched dictionary"
    echo "  instead of cmudict.dict - ask for help sourcing one."
fi
