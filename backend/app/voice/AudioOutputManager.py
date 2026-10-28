"""In-memory WAV encoding — no persistent temp files for synthesis."""

from __future__ import annotations

import io
import wave

import numpy as np


class AudioOutputManager:
    """Encode float32 mono audio to WAV bytes at the source sample rate."""

    @staticmethod
    def float_to_pcm16(audio: np.ndarray) -> np.ndarray:
        x = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
        return (x * 32767.0).astype(np.int16)

    def to_wav_bytes(self, audio: np.ndarray, sample_rate: int) -> bytes:
        pcm = self.float_to_pcm16(audio)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(int(sample_rate))
            wf.writeframes(pcm.tobytes())
        return buf.getvalue()

    @staticmethod
    def peak_and_rms(audio: np.ndarray) -> tuple[float, float]:
        if audio.size == 0:
            return 0.0, 0.0
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(np.square(audio))))
        return peak, rms
