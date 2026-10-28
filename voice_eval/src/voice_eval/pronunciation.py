"""Display RA-ONE / speak Raw-One — eval-only, separate from main app."""

from __future__ import annotations

import re

DISPLAY_NAME = "RA-ONE"
SPOKEN_NAME = "Raw-One"


def to_spoken_text(text: str, spoken: str = SPOKEN_NAME) -> str:
    t = str(text or "")
    patterns = [
        r"\bR\s*A\s*[\-–—]?\s*ONE\b",
        r"\bRA[\-–—]?ONE\b",
        r"\bRA\s+ONE\b",
        r"\bRay[\-–—]?\s*One\b",
        r"\bRaw[\-–—]?\s*One\b",
    ]
    for pat in patterns:
        t = re.sub(pat, spoken, t, flags=re.I)
    return t
