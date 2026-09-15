import contextlib
import io
import math
import struct
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import kws_listen as listener


class HighPassTests(unittest.TestCase):
    def tone(self, hz):
        return struct.pack("<16000h", *(round(10000 * math.sin(2 * math.pi * hz * i / 16000))
                                       for i in range(16000)))

    def test_attenuates_rumble_and_preserves_speech_band(self):
        def gain(hz):
            samples = struct.unpack("<16000h", listener.HighPassFilter().process(self.tone(hz)))
            return math.sqrt(sum(x*x for x in samples[8000:]) / 8000) / (10000 / math.sqrt(2))
        self.assertLess(gain(30), 0.25)
        self.assertAlmostEqual(gain(120), 1 / math.sqrt(2), places=2)
        self.assertGreater(gain(1000), 0.98)

    def test_state_survives_frame_boundaries(self):
        pcm = self.tone(120)
        expected = listener.HighPassFilter().process(pcm)
        filt = listener.HighPassFilter()
        actual = b"".join(filt.process(pcm[i:i+960]) for i in range(0, len(pcm), 960))
        self.assertEqual(actual, expected)

    def test_dc_decays_and_extreme_input_does_not_overflow(self):
        filt = listener.HighPassFilter()
        pcm = struct.pack("<16000h", *([32767]*8000 + [-32768]*8000))
        result = struct.unpack("<16000h", filt.process(pcm))
        self.assertEqual(result[-1], 0)
        self.assertEqual(result[7999], 0)
        self.assertTrue(all(-32768 <= x <= 32767 for x in result))

    def test_bypass_is_bit_exact_and_invalid_inputs_fail(self):
        pcm = self.tone(30)
        self.assertEqual(listener.HighPassFilter(0).process(pcm), pcm)
        for cutoff in (-1, 8000, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                listener.HighPassFilter(cutoff)
        with self.assertRaises(ValueError):
            listener.HighPassFilter().process(b"x")


class Decoder:
    def __init__(self, results):
        self.results = iter(results)
        self.words = []
        self.starts = self.ends = 0

    def start_utt(self):
        self.starts += 1

    def process_raw(self, *args):
        self.words = next(self.results)

    def seg(self):
        return (SimpleNamespace(word=word) for word in self.words)

    def end_utt(self):
        self.ends += 1


class Endpointer:
    frame_bytes = 2
    speech_start = 0

    def __init__(self, frames):
        self.frames = iter(frames)
        self.in_speech = False

    def process(self, frame):
        self.in_speech, speech = next(self.frames)
        return speech


class ListenerTests(unittest.TestCase):
    def test_quiet_onset_is_preserved_before_vad_boundary(self):
        ep = Endpointer([(False, None), (True, b"bb"), (False, b"cc")])
        ep.speech_start = 2 / (listener.SAMPLE_RATE * 2)
        captured = []
        def recognize(_decoder, pcm, *_args):
            captured.append(bytes(pcm))
        with patch.object(listener, "recognize", side_effect=recognize):
            listener.listen(io.BytesIO(b"aabbcc").read, ep, Decoder([]), lambda _: None)
        self.assertEqual(captured, [b"aabbcc"])

    def test_default_keywords_are_supported_by_command_grammar(self):
        keywords = Path(listener.__file__).with_name("keyword.list").read_text()
        for line in keywords.splitlines():
            phrase = line.split("/", 1)[0].strip()
            if phrase:
                self.assertIn(phrase, listener.COMMANDS)

    def test_start_and_stop_camera_map_to_existing_dispatcher_actions(self):
        self.assertEqual(self.verify(["start camera"], "start camera"), "turn on camera")
        self.assertEqual(self.verify(["stop camera"], "stop camera"), "turn off camera")
        self.assertIsNone(self.verify(["start camera"], "stop camera"))
        self.assertIsNone(self.verify(["stop camera"], "start camera"))
        self.assertIsNone(self.verify(["start camera", "stop camera"],
                                     "start camera stop camera"))

    def test_recording_phrases_map_to_existing_dispatcher_actions(self):
        self.assertEqual(self.verify(["start recording"], "start recording"), "turn on camera")
        self.assertEqual(self.verify(["stop recording"], "stop recording"), "turn off camera")
        self.assertIsNone(self.verify(["start recording"], "stop recording"))
        self.assertIsNone(self.verify(["stop recording"], "start recording"))

    def verify(self, candidates, hypothesis):
        decoder = Decoder([candidates])
        verifier = Decoder([[]])
        verifier.hyp = lambda: SimpleNamespace(hypstr=hypothesis) if hypothesis else None
        with contextlib.redirect_stderr(io.StringIO()):
            result = listener.recognize(decoder, b"00", verifier=verifier)
        return result

    def test_grammar_resolves_overlapping_keyword_detections(self):
        for command in ("turn on camera", "turn off camera"):
            self.assertEqual(self.verify(["turn on camera", "turn off camera"], command), command)

    def test_grammar_cannot_override_keyword_gate(self):
        self.assertIsNone(self.verify(["turn on camera"], "turn off camera"))
        self.assertIsNone(self.verify([], "turn on camera"))

    def test_multiple_complete_commands_are_rejected(self):
        self.assertIsNone(self.verify(["turn on camera", "turn off camera"],
                                     "turn on camera turn off camera"))

    def test_empty_grammar_result_is_rejected(self):
        self.assertIsNone(self.verify(["turn on camera"], None))

    def test_transient_opposing_matches_emit_nothing(self):
        decoder = Decoder([["turn on camera"], ["turn off camera"]])
        with contextlib.redirect_stderr(io.StringIO()) as log:
            self.assertIsNone(listener.recognize(decoder, b"\0" * 4096))
        self.assertIn("ambiguous", log.getvalue())
        self.assertEqual((decoder.starts, decoder.ends), (1, 1))

    def test_repeated_matches_and_aliases_emit_one_command(self):
        decoder = Decoder([["turn on camera", "turn on camera", "start recording"]])
        self.assertEqual(listener.recognize(decoder, b"\0\0"), "turn on camera")

    def test_short_fragments_noise_and_unknown_words_do_not_act(self):
        for phrase in ("on camera", "off camera", "camera", "<sil>", "hello"):
            with self.subTest(phrase=phrase):
                self.assertIsNone(listener.recognize(Decoder([[phrase]]), b"\0\0"))

    def test_separate_on_and_off_utterances_both_execute(self):
        ep = Endpointer([(True, b"aa"), (False, b"bb"),
                         (True, b"cc"), (False, b"dd")])
        decoder = Decoder([["turn on camera"], ["turn off camera"]])
        commands = []
        listener.listen(io.BytesIO(b"0" * 8).read, ep, decoder, commands.append)
        self.assertEqual(commands, ["turn on camera", "turn off camera"])
        self.assertEqual(decoder.starts, 2)

    def test_no_decoding_before_silence_and_no_partial_command_on_eof(self):
        ep = Endpointer([(True, b"aa")])
        decoder = Decoder([])
        commands = []
        listener.listen(io.BytesIO(b"00").read, ep, decoder, commands.append)
        self.assertEqual(commands, [])
        self.assertEqual(decoder.starts, 0)

    def test_long_speech_is_discarded_then_next_command_works(self):
        ep = Endpointer([(True, b"1234"), (True, b"56"), (False, b"78"),
                         (True, b"aa"), (False, b"bb")])
        decoder = Decoder([["turn off camera"]])
        commands = []
        with patch.object(listener, "MAX_SPEECH_BYTES", 4), contextlib.redirect_stderr(io.StringIO()):
            listener.listen(io.BytesIO(b"0" * 10).read, ep, decoder, commands.append)
        self.assertEqual(commands, ["turn off camera"])
        self.assertEqual(decoder.starts, 1)

    def test_final_decoder_matches_are_checked(self):
        decoder = Decoder([["turn on camera"]])
        def finish():
            decoder.words = ["turn off camera"]
        decoder.end_utt = finish
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(listener.recognize(decoder, b"00"))


if __name__ == "__main__":
    unittest.main()
