"""Apply RA-ONE spoken pronunciation before Piper synthesis."""

from __future__ import annotations

from app.assistant.name_normalizer import to_spoken_text


class PronunciationManager:
    def prepare_for_tts(
        self,
        display_text: str,
        *,
        voice_id: str | None = None,
        use_phonetic: bool = False,
    ) -> dict:
        spoken = to_spoken_text(display_text, voice_id=voice_id, use_phonetic=use_phonetic)
        return {
            "display_text": display_text,
            "spoken_text": spoken,
            "changed": spoken != display_text,
        }
