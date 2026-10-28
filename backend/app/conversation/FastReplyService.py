"""
Deterministic replies for trivial utterances (Module 22 fast intent routing).

Skips Ollama entirely for greetings, thanks, time/date, and identity basics.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class FastReply:
    text: str
    intent: str
    reason: str


_GREETING = re.compile(
    r"^(hey|hi|hello|hiya|yo|good\s+(morning|afternoon|evening))([\s,!.?]|$)",
    re.I,
)
_THANKS = re.compile(r"^(thanks|thank\s+you|thx|ty)([\s,!.?]|$)", re.I)
_BYE = re.compile(r"^(bye|goodbye|good\s+night|see\s+you)([\s,!.?]|$)", re.I)
_HOW_ARE = re.compile(
    r"^(how\s+are\s+you|how('?s| is)\s+it\s+going|what'?s\s+up)([\s?!.]|$)",
    re.I,
)
# Searched (not anchored): speech often arrives as "what is the time, RA-ONE?" or
# "can you tell me the time". _short_match() caps the extra words so "what time is the
# meeting tomorrow" still goes to the LLM.
_TIME = re.compile(
    r"\b(what\s+time\s+is\s+it|what('?s|\s+is)\s+the\s+time|(the\s+)?current\s+time|"
    r"tell\s+me\s+the\s+time|time\s+(is\s+it\s+)?now|got\s+the\s+time)\b",
    re.I,
)
_DATE = re.compile(
    r"\b(what('?s|\s+is)\s+(the\s+)?(today'?s\s+)?date|what\s+day\s+is\s+(it|today)|today'?s\s+date|"
    r"tell\s+me\s+the\s+date)\b",
    re.I,
)
_EXTRA_WORDS_OK = 4


def _short_match(pattern: re.Pattern[str], text: str) -> bool:
    # Words left once every match is removed (people repeat themselves: "what is the time? what is the time")
    rest = pattern.sub(" ", text)
    return rest != text and len(re.findall(r"\w+", rest)) <= _EXTRA_WORDS_OK
_WHO = re.compile(
    r"^(who\s+are\s+you|what\s+are\s+you|what'?s\s+your\s+name|your\s+name)\b",
    re.I,
)


_HI_REPLIES = (
    "Hey. Good to hear from you. How can I help?",
    "Hello, sir. What can I help you with?",
    "Hi there. What do you need help with?",
)
_HOW_ARE_REPLIES = (
    "All systems running smoothly, sir. How about you? How can I help?",
    "Doing well, thanks for asking. How are you holding up? How can I help?",
)
_THANKS_REPLIES = ("Anytime, sir.", "My pleasure.", "Happy to help.")


def _pick(options: tuple[str, ...]) -> str:
    return random.choice(options)


def _strip_wake(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(
        r"^(hey|hi|hello)\s+(ra[\s\-]?one|raw[\s\-]?one|ray[\s\-]?one|are\s+one)\s*[,.]?\s*",
        "",
        t,
        flags=re.I,
    )
    t = re.sub(
        r"^(ra[\s\-]?one|raw[\s\-]?one|ray[\s\-]?one|are\s+one)\s*[,.]?\s*",
        "",
        t,
        flags=re.I,
    )
    return t.strip(" .,!?")


def match_fast_reply(raw: str, *, tz_name: str = "Asia/Kolkata") -> FastReply | None:
    """Return a canned reply when the utterance needs no LLM."""
    text = _strip_wake(raw)
    if not text:
        return None

    # Whole-utterance greetings only (avoid matching "hi" inside longer questions)
    words = text.split()
    if len(words) <= 4 and _GREETING.match(text):
        # "hi how are you" handled below; bare hi/hello
        if _HOW_ARE.match(text):
            return FastReply(
                text=_pick(_HOW_ARE_REPLIES),
                intent="conversation",
                reason="how_are_you",
            )
        if re.match(r"^(hey|hi|hello|hiya|yo)([\s,!.?]*)$", text, re.I):
            return FastReply(
                text=_pick(_HI_REPLIES),
                intent="conversation",
                reason="greeting",
            )
        if re.match(r"^good\s+(morning|afternoon|evening)([\s,!.?]*)$", text, re.I):
            part = re.match(r"^good\s+(\w+)", text, re.I).group(1).lower()
            return FastReply(
                text=f"Good {part}, sir. How can I help?",
                intent="conversation",
                reason="greeting",
            )

    if len(words) <= 5 and _HOW_ARE.match(text):
        return FastReply(
            text=_pick(_HOW_ARE_REPLIES),
            intent="conversation",
            reason="how_are_you",
        )

    if len(words) <= 4 and _THANKS.match(text):
        return FastReply(
            text=_pick(_THANKS_REPLIES),
            intent="conversation",
            reason="thanks",
        )

    if len(words) <= 4 and _BYE.match(text):
        return FastReply(
            text="Take care, sir. Just say Hey RA-ONE when you need me.",
            intent="conversation",
            reason="bye",
        )

    if _WHO.match(text):
        return FastReply(
            text="I'm RA-ONE, your personal assistant. Think of me as part JARVIS, part friend.",
            intent="conversation",
            reason="identity",
        )

    if _short_match(_TIME, text):
        try:
            now = datetime.now(ZoneInfo(tz_name))
        except Exception:
            now = datetime.now()
        spoken = now.strftime("%I:%M %p").lstrip("0")
        return FastReply(
            text=f"It's {spoken}.",
            intent="conversation",
            reason="time",
        )

    if _short_match(_DATE, text):
        try:
            now = datetime.now(ZoneInfo(tz_name))
        except Exception:
            now = datetime.now()
        spoken = now.strftime("%A, %B %d, %Y")
        return FastReply(
            text=f"Today is {spoken}.",
            intent="conversation",
            reason="date",
        )

    return None
