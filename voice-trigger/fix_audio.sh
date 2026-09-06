#!/usr/bin/env bash
# Adds a "mono_mic" ALSA PCM to ~/.asoundrc that wraps the Google voiceHAT
# sound card (hw:0,0) through ALSA's "plug" layer, which auto-converts
# channel count/format. This works around the voiceHAT's ALSA driver only
# supporting stereo capture, while pocketsphinx's LiveSpeech hardcodes mono
# and offers no way to override it.
#
# Usage: ./fix_audio.sh

set -euo pipefail

ASOUNDRC="$HOME/.asoundrc"
MARKER="pcm.mono_mic"

if [ -f "$ASOUNDRC" ] && grep -q "$MARKER" "$ASOUNDRC"; then
    echo "mono_mic already defined in $ASOUNDRC, skipping"
else
    cat >> "$ASOUNDRC" <<'EOF'
pcm.mono_mic {
    type plug
    slave.pcm "hw:0,0"
}
EOF
    echo "added mono_mic to $ASOUNDRC"
fi

echo
echo "audio devices sounddevice can see now:"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/kws_listen.py" --list_devices

echo
echo "if 'mono_mic' appears above, test with:"
echo "  python3 $SCRIPT_DIR/kws_listen.py --device mono_mic --verbose"
