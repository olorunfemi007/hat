#!/usr/bin/env bash
# Installs Go from the official tarball (not apt, which is often stale on
# Pi OS) and puts it on PATH, both for this session and future ones via
# ~/.bashrc. Safe to re-run - skips the download if already installed.
#
# Usage: ./install_go.sh

set -euo pipefail

GO_VERSION="1.27.1"

if [ -x /usr/local/go/bin/go ]; then
    echo "go already installed: $(/usr/local/go/bin/go version)"
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
    echo "installed: $(/usr/local/go/bin/go version)"
fi

export PATH="$PATH:/usr/local/go/bin"
if ! grep -q '/usr/local/go/bin' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH=$PATH:/usr/local/go/bin' >> "$HOME/.bashrc"
    echo "added /usr/local/go/bin to PATH in ~/.bashrc (open a new shell, or run: source ~/.bashrc)"
fi

echo
echo "go is ready for this session:"
go version
