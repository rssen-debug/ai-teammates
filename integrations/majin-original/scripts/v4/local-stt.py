"""Local CPU speech recognition. No audio leaves the host; no runtime downloads.

Install faster-whisper==1.2.1 and provision a model directory separately.
MAJIN_V4_STT_COMMAND: "python" "local-stt.py" --model "model-dir" {WAV}
PyAV decodes iOS AAC/MP4 as well as WebM/Opus; no ffmpeg executable is needed.
"""
import argparse
import sys
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--language", default="auto")
parser.add_argument("audio")
args = parser.parse_args()
sys.stdout.reconfigure(encoding="utf-8")
model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=2,
                     num_workers=1, local_files_only=True)
segments, info = model.transcribe(args.audio, language=None if args.language == "auto" else args.language, beam_size=1,
                                  vad_filter=True, condition_on_previous_text=False)
if info.duration > 35:
    raise ValueError("Audio duration exceeds 35 seconds")
print(" ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip())
