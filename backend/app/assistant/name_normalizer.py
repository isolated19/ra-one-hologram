"""STT wake matching and TTS pronunciation (separate pipelines)."""

from __future__ import annotations

import re

from .identity_config import IDENTITY, SLEEP_COMMANDS, WAKE_DICTIONARY


def normalize_for_match(text: str = "") -> str:
    t = text.lower()
    t = re.sub(r"[^\w\s\-']", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def canonicalize_name_tokens(text: str) -> str:
    t = normalize_for_match(text)
    patterns = [
        r"\br\s*a\s*[\-]?\s*one\b",
        r"\bare\s+a\s+one\b",
        r"\bray[\s\-]?one\b",
        r"\braw[\s\-]?one\b",
        r"\bra[\s\-]?one\b",
        r"\braone\b",
        r"\br[\s\-]?one\b",
    ]
    for pat in patterns:
        t = re.sub(pat, " ra_one ", t)
    return re.sub(r"\s+", " ", t).strip()


def _name_alternation() -> str:
    parts = sorted(
        (re.escape(a).replace(r"\ ", r"\s+") for a in WAKE_DICTIONARY["name_aliases"]),
        key=len,
        reverse=True,
    )
    return "(?:" + "|".join(parts) + ")"


def match_wake_phrase(raw: str) -> dict:
    text = normalize_for_match(raw)
    empty = {
        "matched": False,
        "remainder": text,
        "greeting": None,
        "wake_span": "",
        "canonical": IDENTITY["canonical_id"],
    }
    if not text:
        return {**empty, "remainder": ""}

    greet = "|".join(WAKE_DICTIONARY["greetings"])
    name = _name_alternation()
    m = re.match(rf"^(?:({greet})\s+)?({name})(?:\s*[,.]?\s*|$)", text, re.I)
    if not m:
        bare = re.match(rf"^({name})$", text, re.I)
        if bare:
            return {
                "matched": True,
                "remainder": "",
                "greeting": None,
                "wake_span": bare.group(1),
                "canonical": IDENTITY["canonical_id"],
            }
        return empty

    greeting = m.group(1).lower() if m.group(1) else None
    remainder = text[m.end() :].lstrip(" ,.!?").strip()
    return {
        "matched": True,
        "remainder": remainder,
        "greeting": greeting,
        "wake_span": m.group(2),
        "canonical": IDENTITY["canonical_id"],
    }


def match_sleep_command(raw: str) -> dict:
    canon = canonicalize_name_tokens(raw)
    cid = IDENTITY["canonical_id"]
    stripped = re.sub(rf"^(hey|hi|hello)?\s*{cid}\s*,?\s*", "", canon).strip()
    for cmd in SLEEP_COMMANDS:
        if stripped == cmd or stripped.startswith(cmd + " "):
            return {"matched": True, "command": cmd}
        if f"{cid} {cmd}" in canon:
            return {"matched": True, "command": cmd}
    return {"matched": False, "command": None}


def to_spoken_text(display_text: str, voice_id: str | None = None, use_phonetic: bool = False) -> str:
    """TTS-only rewrite. Display/UI text must stay unchanged."""
    t = str(display_text or "")
    if not t:
        return t
    spoken = (
        IDENTITY["phonetic_spoken_name"]
        if use_phonetic
        else IDENTITY["voice_phonetics"].get(voice_id or "", IDENTITY["spoken_name"])
    )
    patterns = [
        r"\bR\s*A\s*[\-–—]?\s*ONE\b",
        r"\bRA[\-–—]?ONE\b",
        r"\bRA\s+ONE\b",
        r"\bRay[\-–—]?\s*One\b",
        r"\bRaw[\-–—]?\s*One\b",
    ]
    for pat in patterns:
        t = re.sub(pat, spoken, t, flags=re.I)
    t = re.sub(re.escape(IDENTITY["spoken_name"]), spoken, t, flags=re.I)
    return t
