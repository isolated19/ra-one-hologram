"""Fast-path replies — no Ollama for greetings / time / identity."""

from __future__ import annotations

import pytest

from app.conversation.AssistantResponseRouter import AssistantResponseRouter
from app.conversation.FastReplyService import match_fast_reply
from app.intent.IntentAnalyzer import IntentAnalyzer


@pytest.mark.parametrize(
    "text,reason",
    [
        ("hi", "greeting"),
        ("Hello!", "greeting"),
        ("hey", "greeting"),
        ("thanks", "thanks"),
        ("who are you", "identity"),
        ("what time is it", "time"),
        ("what's the date", "date"),
        ("Hey RA-ONE, hi", "greeting"),
    ],
)
def test_match_fast_reply(text: str, reason: str):
    hit = match_fast_reply(text)
    assert hit is not None
    assert hit.reason == reason
    assert hit.text


def test_fast_reply_does_not_steal_questions():
    assert match_fast_reply("hi what is python") is None
    assert match_fast_reply("what is artificial intelligence") is None


@pytest.mark.parametrize(
    "text",
    [
        "What is the time?",
        "What is the time? What is the time, RAVAN?",
        "can you tell me the time",
        "RA-ONE what's the time now",
        "what time is it",
    ],
)
def test_time_questions_skip_llm(text):
    hit = match_fast_reply(text)
    assert hit is not None and hit.reason == "time"


@pytest.mark.parametrize("text", ["what time is the cricket match tomorrow in mumbai", "explain time zones to me"])
def test_time_topics_still_go_to_llm(text):
    hit = match_fast_reply(text)
    assert hit is None or hit.reason != "time"


@pytest.mark.asyncio
async def test_router_skips_llm_for_hi():
    class BoomLLM:
        async def health(self):
            raise AssertionError("health should not run for fast replies")

        async def chat(self, *args, **kwargs):
            raise AssertionError("chat should not run for fast replies")

    router = AssistantResponseRouter(
        BoomLLM(),  # type: ignore[arg-type]
        IntentAnalyzer(use_llm=False),
        allow_mock=False,
    )
    result = await router.route("hi")
    assert result.success
    assert result.source == "fast"
    assert result.meta.get("skipped_llm") is True
    assert "help" in result.text.lower()
