#!/usr/bin/env python3
"""Run all feasible engine benchmarks and write recommendation JSON/MD."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from voice_eval.orchestrator import engine_status, load_config, run_engine  # noqa: E402
from voice_eval.reference_validator import validate_reference  # noqa: E402


def score_row(r: dict) -> dict:
    """Heuristic scores 0–10 from measured fields (subjective dims left null)."""
    if not r.get("success"):
        return {
            "cpu_speed": 0,
            "ram": 0,
            "offline": 0,
            "install": 0,
            "cloning": 0,
            "overall_auto": 0,
        }
    synth = float(r.get("synthesize_sec") or 999)
    load = float(r.get("load_sec") or 999)
    ram = float(r.get("peak_rss_mb") or 0)
    # Lower is better for synth/load/ram on this laptop
    speed = max(0, 10 - min(synth / 8.0, 10))
    ram_s = max(0, 10 - min(ram / 400.0, 10))
    offline = 10 if r.get("offline_after_cache") else 3
    install = 8 if r.get("success") else 2
    cloning = 9 if r.get("cloning_used") else (4 if r.get("engine") == "kokoro_onnx" else 5)
    overall = round(0.35 * speed + 0.25 * ram_s + 0.2 * offline + 0.1 * install + 0.1 * cloning, 2)
    return {
        "cpu_speed": round(speed, 2),
        "ram": round(ram_s, 2),
        "offline": offline,
        "install": install,
        "cloning": cloning,
        "overall_auto": overall,
        "note": "Voice similarity/naturalness/rugged quality require human listening.",
    }


def recommend(results: list[dict]) -> dict:
    ok = [r for r in results if r.get("success")]
    if not ok:
        return {
            "winner": None,
            "reason": "No engine completed successfully on this machine.",
            "action": "Fix installs / provide my_voice.wav / check logs in results/.",
        }
    ranked = sorted(ok, key=lambda r: score_row(r)["overall_auto"], reverse=True)
    top = ranked[0]
    clones = [r for r in ok if r.get("cloning_used")]
    reason_parts = [
        f"Best automatic score: {top.get('engine')} "
        f"(synth {top.get('synthesize_sec'):.1f}s, peak RSS ~{top.get('peak_rss_mb', 0):.0f} MB).",
    ]
    if clones:
        best_clone = max(clones, key=lambda r: score_row(r)["overall_auto"])
        reason_parts.append(
            f"Best measured cloning run: {best_clone.get('engine')} "
            f"(listen to {best_clone.get('output_path')} for similarity)."
        )
    else:
        reason_parts.append(
            "No cloning run succeeded (missing/invalid reference WAV). "
            "Kokoro baseline uses installed voices only."
        )
    reason_parts.append(
        "Do NOT replace production Piper until you A/B listen and confirm rugged cinematic quality."
    )
    return {
        "winner": top.get("engine"),
        "winner_output": top.get("output_path"),
        "scores": {r.get("engine"): score_row(r) for r in results},
        "reason": " ".join(reason_parts),
        "replace_production_piper": False,
    }


def main() -> int:
    cfg = load_config()
    results_dir = ROOT / cfg.get("output_dir", "results")
    results_dir.mkdir(parents=True, exist_ok=True)
    ref = ROOT / cfg["reference_wav"]
    ref_report = validate_reference(ref).to_dict()

    print("Engine venvs:", json.dumps(engine_status(), indent=2))
    print("Reference:", json.dumps(ref_report, indent=2))

    jobs = [
        ("kokoro", {"preset": "commander", "mode": "builtin"}),
        ("pocket", {"preset": "commander", "mode": "builtin"}),
        ("pocket", {"preset": "commander", "mode": "clone"}),
        ("coqui", {"preset": "commander", "mode": "clone"}),
    ]

    results: list[dict] = []
    for engine, opts in jobs:
        # Skip duplicate pocket clone if no ref
        if opts.get("mode") == "clone" and not ref_report.get("ok"):
            print(f"\n--- skip {engine} clone (reference not OK) ---")
            results.append(
                {
                    "success": False,
                    "engine": f"{engine}_clone",
                    "error": "reference_not_ok",
                    "reference": ref_report,
                }
            )
            continue
        label = f"{engine}:{opts.get('mode')}"
        print(f"\n=== Running {label} ===")
        t0 = time.perf_counter()
        try:
            r = run_engine(engine, preset=opts.get("preset", "commander"), mode=opts.get("mode"), timeout_sec=1200)
        except Exception as exc:  # noqa: BLE001
            r = {"success": False, "engine": engine, "error": str(exc)}
        r["job"] = label
        r["job_wall_sec"] = time.perf_counter() - t0
        results.append(r)
        print(json.dumps({k: r.get(k) for k in (
            "success", "engine", "mode", "load_sec", "synthesize_sec",
            "peak_rss_mb", "output_path", "error", "cloning_used",
        )}, indent=2))

    rec = recommend(results)
    payload = {
        "machine": {
            "os": "Windows 11",
            "cpu": "Intel i7-8650U",
            "ram_gb": 16,
            "python": "3.12",
            "prefer_cpu": True,
        },
        "reference": ref_report,
        "results": results,
        "recommendation": rec,
        "listening_checklist": [
            "Similarity to reference (if cloning)",
            "Rugged / cinematic character with Dark/Cosmic/Commander presets",
            "Naturalness / artifacts",
            "Intelligibility of 'Raw-One'",
        ],
    }
    out_json = results_dir / "benchmark_report.json"
    out_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    md = results_dir / "RECOMMENDATION.md"
    lines = [
        "# RA-ONE Voice Cloning Evaluation — Recommendation",
        "",
        f"**Automatic winner (metrics):** `{rec.get('winner')}`",
        "",
        rec.get("reason", ""),
        "",
        f"**Replace production Piper now?** `{rec.get('replace_production_piper')}`",
        "",
        "## Measured runs",
        "",
        "| Job | Success | Load s | Synth s | Peak RSS MB | Clone | Output |",
        "|-----|---------|--------|---------|-------------|-------|--------|",
    ]
    for r in results:
        lines.append(
            "| {job} | {ok} | {load} | {synth} | {ram} | {clone} | {out} |".format(
                job=r.get("job") or r.get("engine"),
                ok=r.get("success"),
                load=f"{r.get('load_sec', 0):.1f}" if r.get("load_sec") is not None else "—",
                synth=f"{r.get('synthesize_sec', 0):.1f}" if r.get("synthesize_sec") is not None else "—",
                ram=f"{r.get('peak_rss_mb', 0):.0f}" if r.get("peak_rss_mb") else "—",
                clone=r.get("cloning_used"),
                out=Path(r["output_path"]).name if r.get("output_path") else (r.get("error") or "—")[:40],
            )
        )
    lines += [
        "",
        "## Subjective (fill after listening)",
        "",
        "- Voice similarity: _/10",
        "- Rugged quality: _/10",
        "- Naturalness: _/10",
        "",
        "Upload your owned `reference/my_voice.wav` before trusting cloning scores.",
        "",
    ]
    md.write_text("\n".join(lines), encoding="utf-8")
    print("\nWrote", out_json)
    print("Wrote", md)
    print("Recommendation:", rec.get("winner"), "-", rec.get("reason")[:200])
    return 0 if any(r.get("success") for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
