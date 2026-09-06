#!/usr/bin/env python3
"""Records a few seconds of audio and prints its peak/RMS level.

Isolates whether the microphone is actually capturing a real signal, before
blaming PocketSphinx's keyword threshold or phrase choice for a lack of
detections.
"""
import sys

import numpy as np
import sounddevice as sd

DURATION_S = 4
SAMPLE_RATE = 16000

print(f"recording {DURATION_S}s at {SAMPLE_RATE}Hz — speak normally now...", file=sys.stderr)
audio = sd.rec(int(DURATION_S * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
sd.wait()

samples = audio.flatten().astype(np.float64)
peak = np.max(np.abs(samples))
rms = np.sqrt(np.mean(samples ** 2))

print(f"peak amplitude: {peak:.0f} / 32767")
print(f"RMS level:      {rms:.1f}")

if peak < 500:
    print("-> looks silent or near-silent. Check: correct input device selected, mic not muted, system input volume.")
elif peak < 3000:
    print("-> signal present but quiet. Try speaking louder/closer, or raise input gain.")
else:
    print("-> healthy signal level, mic capture looks fine.")
