#!/usr/bin/env bash
# One-shot setup for voice-trigger on Raspberry Pi OS Lite (headless).
# Installs apt deps, Go, a Python venv with pocketsphinx, downloads the
# CMU Sphinx model files (no arm wheel exists for pocketsphinx, so this is
# required), and builds the Go binary. Safe to re-run — each step skips
# itself if already done.
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
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install pocketsphinx numpy -q
echo "venv ready at $VENV_DIR"

echo "==> [4/5] CMU Sphinx model files"
"$SCRIPT_DIR/download_models.sh"

echo "==> [5/5] Building voice-trigger"
export PATH="$PATH:/usr/local/go/bin"
(cd "$SCRIPT_DIR" && go build -o voice-trigger .)

MODEL_DIR="$SCRIPT_DIR/models"
echo
echo "==> Setup complete. Test it with:"
echo
echo "  cd $SCRIPT_DIR"
echo "  ./voice-trigger \\"
echo "      -listen_cmd \"$VENV_DIR/bin/python3 kws_listen.py --hmm $MODEL_DIR/cmusphinx-en-us-5.2 --dict $MODEL_DIR/cmudict.dict\" \\"
echo "      -camera_cmd \"echo CAMERA TRIGGERED\""
