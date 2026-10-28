"""TC-01 / TC-02 — identity display vs TTS pronunciation."""

from __future__ import annotations

from app.assistant.identity_config import IDENTITY
from app.assistant.name_normalizer import (
    match_sleep_command,
    match_wake_phrase,
    to_spoken_text,
)
from app.voice.pronunciation_manager import PronunciationManager


def test_tc01_display_name_is_ra_one():
    assert IDENTITY["display_name"] == "RA-ONE"
    assert IDENTITY["canonical_id"] == "ra_one"
    assert IDENTITY["spoken_name"] == "Raw-One"


def test_tc02_tts_preprocessing():
    display = "I am RA-ONE. How can I assist you?"
    spoken = to_spoken_text(display)
    assert spoken == "I am Raw-One. How can I assist you?"
    assert "RA-ONE" in display


def test_pronunciation_manager_keeps_display():
    pm = PronunciationManager()
    prep = pm.prepare_for_tts("Hello, I am RA-ONE.")
    assert prep["display_text"] == "Hello, I am RA-ONE."
    assert prep["spoken_text"] == "Hello, I am Raw-One."
    assert prep["changed"] is True


def test_wake_aliases():
    for phrase in ("Hey RA-ONE", "Hi Raw One", "RA-ONE", "Ray One", "Are A One"):
        hit = match_wake_phrase(phrase)
        assert hit["matched"] is True, phrase
        assert hit["canonical"] == "ra_one"


def test_wake_plus_question_remainder():
    hit = match_wake_phrase("Hey RA-ONE who are you")
    assert hit["matched"]
    assert "who are you" in hit["remainder"]


def test_background_rejected():
    assert match_wake_phrase("what's for dinner tonight")["matched"] is False


def test_sleep_command():
    assert match_sleep_command("RA-ONE, go to sleep")["matched"] is True
