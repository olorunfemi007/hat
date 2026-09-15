#!/usr/bin/env python3
"""Endpointed PocketSphinx commands. Only finalized, unambiguous speech reaches stdout."""
import argparse
from array import array
import math
import os
import signal
import subprocess
import sys
import wave

SAMPLE_RATE = 16000
MAX_SPEECH_BYTES = SAMPLE_RATE * 2 * 8
COMMANDS = {
    "start camera": "turn on camera",
    "stop camera": "turn off camera",
    "turn on camera": "turn on camera",
    "start recording": "turn on camera",
    "turn off camera": "turn off camera",
    "stop recording": "turn off camera",
    "turn on light": "turn on light",
    "turn off light": "turn off light",
}


class HighPassFilter:
    """Streaming first-order high-pass for mono S16_LE PCM; constant state."""

    def __init__(self, cutoff_hz=120, sample_rate=SAMPLE_RATE):
        if not math.isfinite(cutoff_hz) or not 0 <= cutoff_hz < sample_rate / 2:
            raise ValueError("high-pass cutoff must be 0 (disabled) or below half the sample rate")
        self.enabled = cutoff_hz != 0
        k = math.tan(math.pi * cutoff_hz / sample_rate)
        self.gain = 1 / (1 + k)
        self.feedback = (1 - k) / (1 + k)
        self.previous_input = self.previous_output = 0.0

    def process(self, pcm):
        if len(pcm) % 2:
            raise ValueError("16-bit PCM must contain complete samples")
        if not self.enabled:
            return pcm
        samples = array("h")
        samples.frombytes(pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        previous_input, previous_output = self.previous_input, self.previous_output
        gain, feedback = self.gain, self.feedback
        for i, sample in enumerate(samples):
            output = gain * (sample - previous_input) + feedback * previous_output
            previous_input, previous_output = sample, output
            samples[i] = max(-32768, min(32767, round(output)))
        self.previous_input, self.previous_output = previous_input, previous_output
        if sys.byteorder != "little":
            samples.byteswap()
        return samples.tobytes()


def recognize(decoder, pcm, verbose=False, verifier=None):
    """Keep all keyword candidates, including transient competing matches."""
    candidates = set()

    def collect():
        for segment in decoder.seg() or ():
            phrase = " ".join(segment.word.lower().split())
            if phrase in COMMANDS:
                candidates.add(COMMANDS[phrase])

    decoder.start_utt()
    try:
        for offset in range(0, len(pcm), 2048):
            decoder.process_raw(pcm[offset:offset + 2048], False, False)
            collect()
    finally:
        decoder.end_utt()
    collect()
    if candidates and verifier is not None:
        # Keyword spotting independently scores each phrase, so both may match
        # the same audio. Grammar decoding makes the alternatives compete.
        verifier.start_utt()
        try:
            verifier.process_raw(pcm, False, True)
        finally:
            verifier.end_utt()
        hypothesis = verifier.hyp()
        text = " ".join(hypothesis.hypstr.lower().split()) if hypothesis else ""
        if verbose:
            print(f"Grammar result: {text or 'no command'}", file=sys.stderr)
        confirmed = COMMANDS.get(text)
        if confirmed in candidates:
            return confirmed
        print("Rejected speech: no single matching complete command", file=sys.stderr)
        return None
    if len(candidates) > 1:
        print("Rejected ambiguous speech: " + ", ".join(sorted(candidates)), file=sys.stderr)
        return None
    if verbose:
        print("Speech result: " + (", ".join(candidates) or "no command"), file=sys.stderr)
    return next(iter(candidates), None)


def listen(read, endpointer, decoder, emit, verbose=False, verifier=None, audio_filter=None):
    """Decode once per silence-delimited utterance; discard incomplete/long speech.

    EOF is not a speech boundary: a failed recorder must not execute a partial
    command. WAV replay should include the natural silence after the command.
    """
    pcm = bytearray()
    history = bytearray()
    total_bytes = 0
    too_long = False
    while True:
        frame = read(endpointer.frame_bytes)
        if len(frame) != endpointer.frame_bytes:
            return
        if audio_filter is not None:
            frame = audio_filter.process(frame)
        total_bytes += len(frame)
        history.extend(frame)
        del history[:-SAMPLE_RATE * 2]
        speech = endpointer.process(frame)
        if speech is not None:
            if not too_long:
                if not pcm:
                    # VAD can miss quiet initial consonants (e.g. the "st" in
                    # "start"). Recover 300 ms preceding its speech boundary.
                    start = round(endpointer.speech_start * SAMPLE_RATE) * 2
                    origin = total_bytes - len(history)
                    pcm.extend(history[max(0, start - 9600 - origin):max(0, start - origin)])
                if len(pcm) + len(speech) > MAX_SPEECH_BYTES:
                    pcm.clear()
                    too_long = True
                    print("Rejected speech longer than 8 seconds; waiting for silence", file=sys.stderr)
                else:
                    pcm.extend(speech)
        if not endpointer.in_speech:
            if pcm and not too_long:
                command = recognize(decoder, pcm, verbose, verifier)
                if command:
                    emit(command)
            pcm.clear()
            too_long = False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--list_devices",
        action="store_true",
        help="List ALSA PCM devices (via `arecord -L`) and exit",
    )
    parser.add_argument(
        "--alsa_device",
        default="plughw:0,0",
        help="ALSA device passed to arecord's -D flag. `plughw:CARD,DEVICE` lets ALSA "
        "convert channel count/rate for hardware that doesn't natively support what "
        "pocketsphinx needs (mono, 16kHz). Check `arecord -l` for your card/device numbers.",
    )
    parser.add_argument(
        "--arecord_bin",
        default="arecord",
        help="Path to the arecord binary",
    )
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
    parser.add_argument("--wav", help="Replay a mono 16-bit 16 kHz WAV instead of the microphone")
    parser.add_argument("--highpass_hz", type=float, default=120,
                        help="High-pass cutoff in Hz before speech detection (default: 120; 0 disables)")
    args = parser.parse_args()
    try:
        audio_filter = HighPassFilter(args.highpass_hz)
    except ValueError as error:
        parser.error(str(error))

    if args.list_devices:
        subprocess.run([args.arecord_bin, "-L"], check=True)
        return

    if not os.path.isfile(args.kws):
        sys.exit(f"keyword list file not found: {args.kws}")

    from pocketsphinx import Decoder, Endpointer, get_model_path

    model_path = get_model_path()
    hmm_dir = args.hmm or os.path.join(model_path, "en-us", "en-us")
    dict_path = args.dict_path or os.path.join(model_path, "en-us", "cmudict-en-us.dict")

    print(f"hmm:  {hmm_dir} ({'exists' if os.path.isdir(hmm_dir) else 'MISSING'})", file=sys.stderr)
    print(f"dict: {dict_path} ({'exists' if os.path.isfile(dict_path) else 'MISSING'})", file=sys.stderr)

    if not os.path.isdir(hmm_dir) or not os.path.isfile(dict_path):
        sys.exit(
            "Model files not found at the paths above. If pip built pocketsphinx from "
            "source (no prebuilt wheel for this platform), get_model_path() won't have "
            "real data — download CMU Sphinx's en-us acoustic model and dictionary "
            "manually and pass --hmm/--dict pointing at them."
        )

    decoder = Decoder(
        loglevel="INFO" if args.verbose else "ERROR",
        hmm=hmm_dir,
        lm=None,
        dict=dict_path,
        kws=args.kws,
        samprate=16000,
    )

    verifier = Decoder(hmm=hmm_dir, dict=dict_path, lm=None, samprate=SAMPLE_RATE,
                       loglevel="INFO" if args.verbose else "ERROR")
    # Allow sequences so two spoken commands are not forced into a single one.
    verifier.add_jsgf_string("commands", "#JSGF V1.0; grammar commands; "
                             "<command> = " + " | ".join(COMMANDS) + "; "
                             "public <utterance> = <command>+;")
    verifier.activate_search("commands")
    endpointer = Endpointer(sample_rate=SAMPLE_RATE)
    emit = lambda command: print(command, flush=True)
    if args.wav:
        with wave.open(args.wav, "rb") as recording:
            if (recording.getnchannels(), recording.getsampwidth(), recording.getframerate(),
                    recording.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                sys.exit("WAV must be uncompressed mono 16-bit PCM at 16000 Hz")
            listen(lambda size: recording.readframes(size // 2), endpointer, decoder, emit,
                   args.verbose, verifier, audio_filter)
        return

    arecord_cmd = [
        args.arecord_bin,
        "-D", args.alsa_device,
        "-f", "S16_LE",
        "-r", "16000",
        "-c", "1",
        "-t", "raw",
        "-q",
    ]
    print(f"running: {' '.join(arecord_cmd)}", file=sys.stderr)
    proc = subprocess.Popen(arecord_cmd, stdout=subprocess.PIPE)

    def shutdown(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, shutdown)
    try:
        listen(proc.stdout.read, endpointer, decoder, emit, args.verbose, verifier, audio_filter)
        sys.exit(f"arecord audio stream ended unexpectedly (rc={proc.poll()})")
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        proc.stdout.close()


if __name__ == "__main__":
    main()
