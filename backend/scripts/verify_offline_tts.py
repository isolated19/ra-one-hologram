#!/usr/bin/env python3
"""Verify Piper synthesis does not call external TTS HTTP APIs during generation."""

from __future__ import annotations

import socket
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BlockExternalHTTP(socket.socket):
    """Deny outbound TCP to non-loopback (best-effort offline check)."""

    def connect(self, address):  # type: ignore[override]
        host = address[0]
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise OSError(f"Blocked external connect to {address} during offline TTS verify")
        return super().connect(address)


def main() -> int:
    import sys

    sys.path.insert(0, str(ROOT))
    # Patch after imports of stdlib but before synthesis network would occur
    original = socket.socket
    socket.socket = BlockExternalHTTP  # type: ignore

    from app.voice.OfflineTTSEngine import OfflineTTSEngine

    engine = OfflineTTSEngine()
    if not engine.list_installed_voices():
        print("FAIL: no local models")
        return 1

    display = "Offline verification. I am RA-ONE."
    t0 = time.perf_counter()
    try:
        result = engine.synthesize_sync(
            display,
            preset="raone_classic",
        )
    except OSError as exc:
        print("FAIL: network attempted during synthesis:", exc)
        return 2
    finally:
        socket.socket = original  # type: ignore

    ms = (time.perf_counter() - t0) * 1000
    out = ROOT / "models" / "piper" / "_offline_verify.wav"
    out.write_bytes(result.wav_bytes)
    spoken = getattr(result, "spoken_text", "") or ""
    print("OK offline synthesis")
    print(f"  piper={result.piper_version} voice={result.voice_id} preset={result.preset_id}")
    print(f"  display={display!r}")
    print(f"  spoken={spoken!r}")
    if "Raw-One" not in spoken and "Rawwun" not in spoken:
        print("FAIL: TC-22 pronunciation — expected Raw-One in spoken_text")
        return 3
    print(f"  latency_ms={result.latency_ms:.0f} wall_ms={ms:.0f} peak={result.peak:.3f} clipped={result.clipped}")
    print(f"  wrote {out}")
    print("  TC-22: play the WAV and confirm you hear Raw-One (not R-A-One).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
