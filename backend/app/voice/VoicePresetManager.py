"""Load / merge RA-ONE voice presets from JSON."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from .VoiceConfig import DEFAULT_PRESET, DEFAULT_VOICE_ID, PRESETS_PATH, VOICE_SETTINGS_PATH
from .VoiceEffectProcessor import EffectParams


class VoicePresetManager:
    def __init__(self, presets_path: Path | None = None) -> None:
        self.presets_path = presets_path or PRESETS_PATH
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        with open(self.presets_path, encoding="utf-8") as f:
            data = json.load(f)
        # Optional runtime overrides
        if VOICE_SETTINGS_PATH.exists():
            with open(VOICE_SETTINGS_PATH, encoding="utf-8") as f:
                overrides = json.load(f)
            if "default_voice" in overrides:
                data["default_voice"] = overrides["default_voice"]
            if "default_preset" in overrides:
                data["default_preset"] = overrides["default_preset"]
            if "presets" in overrides and isinstance(overrides["presets"], dict):
                for key, patch in overrides["presets"].items():
                    if key in data["presets"] and isinstance(patch, dict):
                        data["presets"][key].update(patch)
        return data

    def reload(self) -> None:
        self._data = self._load()

    @property
    def default_preset(self) -> str:
        return self._data.get("default_preset", DEFAULT_PRESET)

    @property
    def default_voice(self) -> str:
        return self._data.get("default_voice", DEFAULT_VOICE_ID)

    def list_presets(self) -> list[dict[str, Any]]:
        out = []
        for key, cfg in self._data.get("presets", {}).items():
            out.append(
                {
                    "id": key,
                    "label": cfg.get("label", key),
                    "description": cfg.get("description", ""),
                    "voice_id": cfg.get("voice_id", self.default_voice),
                    "params": {k: v for k, v in cfg.items() if k not in ("label", "description")},
                }
            )
        return out

    def get_preset(self, preset_id: str | None) -> dict[str, Any]:
        presets = self._data.get("presets", {})
        key = preset_id or self.default_preset
        if key not in presets:
            raise KeyError(f"Unknown voice preset '{key}'")
        cfg = deepcopy(presets[key])
        cfg["id"] = key
        return cfg

    def to_effect_params(self, cfg: dict[str, Any], overrides: dict[str, Any] | None = None) -> EffectParams:
        merged = {**cfg, **(overrides or {})}
        return EffectParams(
            pitch_semitones=float(merged.get("pitch_semitones", 0.0)),
            speed=float(merged.get("speed", 1.0)),
            bass_gain_db=float(merged.get("bass_gain_db", 0.0)),
            bass_cutoff_hz=float(merged.get("bass_cutoff_hz", 180.0)),
            saturation=float(merged.get("saturation", 0.0)),
            mechanical=float(merged.get("mechanical", 0.0)),
            octave_mix=float(merged.get("octave_mix", 0.0)),
            reverb_mix=float(merged.get("reverb_mix", 0.0)),
            reverb_delay_ms=float(merged.get("reverb_delay_ms", 50.0)),
            reverb_decay=float(merged.get("reverb_decay", 0.35)),
            compress_threshold=float(merged.get("compress_threshold", 0.55)),
            compress_ratio=float(merged.get("compress_ratio", 2.5)),
        )
