#!/usr/bin/env python3
"""Local-only opt-in Kokoro ONNX narrator voice for MAJIN.
Install dependencies and model separately. The server never uploads speech.
It accepts only JSON /speak calls from loopback app origins and returns WAV.
"""
import argparse
import asyncio
import base64
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

MAX_TEXT_BYTES = 4096
PORT = 18765

def speech_segments(text, max_chars=160):
    """Sentence-sized inference units: Kokoro's default phoneme batch can hold
    an entire reply, so create_stream alone does not reduce first-audio delay.
    Preserve every word and punctuation; bound long sentences at whitespace.
    """
    for sentence in re.split(r'(?<=[.!?])\s+', text.strip()):
        while len(sentence) > max_chars:
            boundary = sentence.rfind(' ', 0, max_chars + 1)
            if boundary < 1:
                boundary = max_chars
            yield sentence[:boundary]
            sentence = sentence[boundary:].lstrip()
        if sentence:
            yield sentence

def valid_origin(origin):
    if not origin:
        return True   # local curl/test clients; loopback binding still required
    try:
        p = urlparse(origin)
        return p.scheme in ("http", "https") and p.hostname in ("localhost", "127.0.0.1", "::1")
    except ValueError:
        return False

def serve(args):
    # Lazy imports: --help and tests work without large inference packages.
    from kokoro_onnx import Kokoro
    import soundfile as sf
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
    options.add_session_config_entry('session.inter_op.allow_spinning', '0')
    session = ort.InferenceSession(str(args.model.resolve()), sess_options=options, providers=['CPUExecutionProvider'])
    model = Kokoro.from_session(session, str(args.voices.resolve()))
    lock = threading.Lock()
    stt = None
    stt_lock = threading.Lock()
    if args.stt_model:
        from faster_whisper import WhisperModel
        stt = WhisperModel(str(args.stt_model.resolve()), device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, body, mime="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "null") if valid_origin(self.headers.get("Origin")) else "null")
            self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if not valid_origin(self.headers.get("Origin")):
                return self.send(403, b'{"error":"origin_not_allowed"}')
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "null"))
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Max-Age", "120")
            self.end_headers()

        def do_GET(self):
            if self.path != "/health":
                return self.send(404, b'{"error":"not_found"}')
            return self.send(200, json.dumps({"ok": True, "engine": "kokoro-onnx", "voice": args.voice, "local": True, "stt": bool(stt), "streamingTts": True}).encode())

        def do_POST(self):
            if self.path == '/speak-stream':
                return self.speak_stream()
            if self.path == '/transcribe':
                return self.transcribe()
            if self.path != "/speak":
                return self.send(404, b'{"error":"not_found"}')
            if not valid_origin(self.headers.get("Origin")):
                return self.send(403, b'{"error":"origin_not_allowed"}')
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self.send(415, b'{"error":"json_required"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= MAX_TEXT_BYTES:
                    return self.send(413, b'{"error":"request_too_large"}')
                payload = json.loads(self.rfile.read(length))
                phrase = payload.get("text", "")
                if not isinstance(phrase, str) or not phrase.strip() or len(phrase) > 700:
                    return self.send(400, b'{"error":"invalid_text"}')
                with lock:
                    samples, rate = model.create(phrase, voice=args.voice, speed=args.speed, lang="en-us")
                wav = io.BytesIO()
                sf.write(wav, samples, rate, format="WAV", subtype="PCM_16")
                return self.send(200, wav.getvalue(), "audio/wav")
            except Exception as e:
                self.log_error("TTS generation failed: %s", type(e).__name__)
                return self.send(500, b'{"error":"synthesis_failed"}')

        def transcribe(self):
            if not valid_origin(self.headers.get('Origin')):
                return self.send(403, b'{"error":"origin_not_allowed"}')
            if not stt:
                return self.send(503, b'{"error":"stt_not_configured"}')
            if not stt_lock.acquire(blocking=False):
                return self.send(429, b'{"error":"stt_busy"}')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 1 <= length <= 6 * 1024 * 1024:
                    return self.send(413, b'{"error":"audio_too_large"}')
                payload = json.loads(self.rfile.read(length))
                audio = base64.b64decode(payload['data'], validate=True)
                if not 1 <= len(audio) <= 4 * 1024 * 1024:
                    return self.send(413, b'{"error":"audio_too_large"}')
                # Decode in bounded frames BEFORE inference, including untrusted
                # container durations. No microphone audio is retained on disk.
                import av
                import numpy as np
                chunks, count = [], 0
                resample = av.AudioResampler(format='s16', layout='mono', rate=16000)
                with av.open(io.BytesIO(audio)) as container:
                    for frame in container.decode(audio=0):
                        for converted in resample.resample(frame):
                            samples = converted.to_ndarray().flatten()
                            count += samples.size
                            if count > 35 * 16000:
                                return self.send(413, b'{"error":"audio_too_long"}')
                            chunks.append(samples)
                if not chunks:
                    return self.send(422, b'{"error":"no_audio"}')
                samples = np.concatenate(chunks).astype(np.float32) / 32768.0
                started = time.monotonic()
                segments, info = stt.transcribe(samples, language=None, beam_size=1, vad_filter=True, condition_on_previous_text=False)
                text = ' '.join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
                return self.send(200, json.dumps({'transcript': text, 'language': info.language, 'elapsedMs': round((time.monotonic() - started) * 1000)}, ensure_ascii=False).encode('utf-8'))
            except Exception as err:
                self.log_error('STT failed: %s', type(err).__name__)
                return self.send(422, b'{"error":"recognition_failed"}')
            finally:
                stt_lock.release()

        def speak_stream(self):
            if not valid_origin(self.headers.get('Origin')):
                return self.send(403, b'{"error":"origin_not_allowed"}')
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                return self.send(415, b'{"error":"json_required"}')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 1 <= length <= MAX_TEXT_BYTES:
                    return self.send(413, b'{"error":"request_too_large"}')
                phrase = json.loads(self.rfile.read(length)).get('text')
                if not isinstance(phrase, str) or not phrase.strip() or len(phrase) > 700:
                    return self.send(400, b'{"error":"invalid_text"}')
            except (ValueError, TypeError, AttributeError):
                return self.send(400, b'{"error":"invalid_text"}')
            if not lock.acquire(blocking=False):
                return self.send(429, b'{"error":"tts_busy"}')
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-ndjson')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                def frame(payload):
                    self.wfile.write((json.dumps(payload) + '\n').encode('utf-8'))
                    self.wfile.flush()
                async def stream():
                    sequence = 0
                    for part in speech_segments(phrase):
                        generator = model.create_stream(part, voice=args.voice, speed=args.speed, lang='en-us')
                        try:
                            async for samples, rate in generator:
                                wav = io.BytesIO()
                                sf.write(wav, samples, rate, format='WAV', subtype='PCM_16')
                                frame({'type': 'audio', 'sequence': sequence, 'data': base64.b64encode(wav.getvalue()).decode('ascii')})
                                sequence += 1
                        finally:
                            # Stop future batches on a disconnected/aborted phone.
                            # Kokoro bounds prefetch to one pending batch; in-flight
                            # ONNX work finishes before this lock can be reused.
                            await generator.aclose()
                    frame({'type': 'done', 'chunks': sequence})
                asyncio.run(stream())
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.log_error('Streaming TTS failed: %s', type(error).__name__)
                try:
                    self.wfile.write(b'{"type":"error","message":"synthesis_failed"}\n')
                    self.wfile.flush()
                except OSError:
                    pass
            finally:
                self.close_connection = True
                lock.release()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"MAJIN_KOKORO_READY http://127.0.0.1:{args.port} voice={args.voice}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            model.voices.close()
        except Exception:
            pass

def parser():
    p = argparse.ArgumentParser(description="MAJIN local Kokoro narrator (not a SunnyV2 voice clone)")
    p.add_argument("--model", type=Path, default=Path(__file__).parent / "models" / "kokoro-v1.0.onnx")
    p.add_argument("--voices", type=Path, default=Path(__file__).parent / "models" / "voices-v1.0.bin")
    p.add_argument("--voice", default="am_adam")
    p.add_argument("--speed", type=float, default=1.03)
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--stt-model", type=Path, default=None, help='Optional pre-provisioned local Whisper model; kept warm, language auto-detected')
    return p

if __name__ == "__main__":
    args = parser().parse_args()
    if not args.model.is_file() or not args.voices.is_file():
        parser().error("Kokoro model and voices data missing. Run scripts/install-kokoro-voice.ps1 first.")
    if not 0.75 <= args.speed <= 1.4 or not 1024 <= args.port <= 65535:
        parser().error("Invalid speed or port")
    serve(args)
