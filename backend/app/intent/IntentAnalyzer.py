"""
Speech Intent Analyzer (Module 3).

Classifies transcribed speech into structured intents.
Never executes actions. Never treats intent as authorization.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any

from pydantic import ValidationError

from app.assistant.name_normalizer import match_sleep_command, match_wake_phrase, normalize_for_match
from app.core.logging import get_logger
from app.intent.schemas import (
    ALLOWED_ACTIONS,
    ALLOWED_APP_TARGETS,
    IntentResult,
    IntentType,
    LLMIntentDraft,
)
from app.llm.LocalLLMService import LocalLLMService, get_llm_service

logger = get_logger(__name__)

INTENT_SYSTEM = """You classify user speech for RA-ONE. Reply with ONLY a JSON object, no markdown.
Schema:
{
  "intent": one of [
    "general_question","conversation","computer_action","memory_request",
    "remember_information","retrieve_information","sleep_command","wake_command","unknown"
  ],
  "action": one of ["open_application","open_url","read_text_file","create_note","report_system_info","none"] or null,
  "target": string or null (app name like calculator/notepad, or url host, or short label),
  "query": string or null (question text if any),
  "memory_content": string or null (fact to remember if any),
  "confidence": number 0..1
}
Rules:
- Never invent shell commands or file paths outside the action enum.
- computer_action only for clear requests to open apps/urls/notes/system info.
- remember_information when user asks to remember something.
- retrieve_information when user asks what you remember.
- sleep_command for go to sleep / stop listening.
- wake_command only if the utterance is mainly a wake greeting with no question.
- Keep targets simple lowercase words (calculator, notepad).
"""


class IntentAnalyzer:
    def __init__(self, llm: LocalLLMService | None = None, *, use_llm: bool = True) -> None:
        self.llm = llm
        self.use_llm = use_llm

    def _llm(self) -> LocalLLMService:
        return self.llm or get_llm_service()

    async def analyze(self, raw_text: str, *, force_llm: bool = False) -> IntentResult:
        raw = (raw_text or "").strip()
        if not raw:
            return IntentResult(
                intent=IntentType.UNKNOWN,
                confidence=0.0,
                cleaned_text="",
                raw_text="",
                notes="empty transcript",
                source="rules",
            )

        wake = match_wake_phrase(raw)
        sleep = match_sleep_command(raw)
        remainder = (wake.get("remainder") or "").strip() if wake.get("matched") else raw
        # If wake matched with empty remainder, treat as wake_command unless sleep also matched
        cleaned = normalize_for_match(remainder if wake.get("matched") else raw)
        if wake.get("matched") and remainder:
            cleaned = normalize_for_match(remainder)

        # High-confidence deterministic paths first.
        # Threshold 0.7: clear questions/open-app rules must NOT call Ollama just to classify
        # (that used to add a second full LLM round-trip before the real answer).
        rule = self._rules(raw, cleaned, wake, sleep)
        if rule and rule.confidence >= 0.7 and not force_llm:
            return rule

        if not self.use_llm:
            return rule or IntentResult(
                intent=IntentType.UNKNOWN,
                cleaned_text=cleaned,
                remainder=remainder if wake.get("matched") else "",
                wake_matched=bool(wake.get("matched")),
                sleep_matched=bool(sleep.get("matched")),
                raw_text=raw,
                confidence=0.2,
                source="rules",
                notes="LLM disabled",
            )

        llm_result = await self._llm_classify(remainder or raw, raw, wake, sleep)
        if llm_result:
            # Prefer sleep/wake rule overrides if present
            if sleep.get("matched") and llm_result.intent not in (
                IntentType.SLEEP_COMMAND,
                IntentType.REMEMBER_INFORMATION,
            ):
                llm_result.intent = IntentType.SLEEP_COMMAND
                llm_result.action = None
                llm_result.sleep_matched = True
            return llm_result

        return rule or IntentResult(
            intent=IntentType.UNKNOWN,
            cleaned_text=cleaned,
            remainder=remainder if wake.get("matched") else "",
            wake_matched=bool(wake.get("matched")),
            sleep_matched=bool(sleep.get("matched")),
            raw_text=raw,
            confidence=0.15,
            source="rules",
            notes="LLM unavailable or invalid JSON; fell back to unknown",
        )

    def analyze_sync_rules_only(self, raw_text: str) -> IntentResult:
        """Deterministic path for tests / offline without Ollama."""
        raw = (raw_text or "").strip()
        wake = match_wake_phrase(raw)
        sleep = match_sleep_command(raw)
        remainder = (wake.get("remainder") or "").strip() if wake.get("matched") else raw
        cleaned = normalize_for_match(remainder if (wake.get("matched") and remainder) else raw)
        return self._rules(raw, cleaned, wake, sleep) or IntentResult(
            intent=IntentType.UNKNOWN,
            cleaned_text=cleaned,
            remainder=remainder if wake.get("matched") else "",
            wake_matched=bool(wake.get("matched")),
            sleep_matched=bool(sleep.get("matched")),
            raw_text=raw,
            confidence=0.1,
            source="rules",
        )

    def _rules(self, raw: str, cleaned: str, wake: dict, sleep: dict) -> IntentResult | None:
        if sleep.get("matched"):
            return IntentResult(
                intent=IntentType.SLEEP_COMMAND,
                confidence=0.95,
                cleaned_text=cleaned,
                remainder="",
                wake_matched=bool(wake.get("matched")),
                sleep_matched=True,
                source="rules",
                raw_text=raw,
                notes=f"sleep:{sleep.get('command')}",
            )

        if wake.get("matched") and not (wake.get("remainder") or "").strip():
            return IntentResult(
                intent=IntentType.WAKE_COMMAND,
                confidence=0.95,
                cleaned_text="",
                remainder="",
                wake_matched=True,
                source="rules",
                raw_text=raw,
                notes=f"greeting:{wake.get('greeting')}",
            )

        text = cleaned or normalize_for_match(raw)

        # Retrieve memory (before remember — "what do you remember" is not a store)
        if re.search(
            r"\b(what do you remember|what can you remember|recall what|do you remember)\b",
            text,
            re.I,
        ):
            q = re.sub(
                r"^(hey|hi|hello)?\s*(ra_one|raw one)?\s*",
                "",
                text,
                flags=re.I,
            ).strip()
            return IntentResult(
                intent=IntentType.RETRIEVE_INFORMATION,
                query=q or text,
                confidence=0.88,
                cleaned_text=text,
                remainder=wake.get("remainder") or "",
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        # Remember / store fact
        m_rem = re.search(
            r"\b(?:please\s+remember|remember\s+that|remember\s+this|remember\s+i)\s+(.+)$",
            text,
            re.I,
        )
        if m_rem:
            content = m_rem.group(1).strip(" .,!")
            return IntentResult(
                intent=IntentType.REMEMBER_INFORMATION,
                memory_content=content,
                query=content,
                confidence=0.9,
                cleaned_text=text,
                remainder=wake.get("remainder") or "",
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        # Open application
        m_open = re.search(
            r"\b(?:open|launch|start)\s+(?:the\s+)?(calculator|calc|notepad|browser|settings|explorer|file explorer)\b",
            text,
            re.I,
        )
        if m_open:
            target = _map_app_target(m_open.group(1))
            return IntentResult(
                intent=IntentType.COMPUTER_ACTION,
                action="open_application",
                target=target,
                confidence=0.92,
                cleaned_text=text,
                remainder=wake.get("remainder") or "",
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        # System info
        if re.search(r"\b(system info|system information|how much ram|cpu usage|what('s| is) my (cpu|ram))\b", text, re.I):
            return IntentResult(
                intent=IntentType.COMPUTER_ACTION,
                action="report_system_info",
                target="system",
                confidence=0.9,
                cleaned_text=text,
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        # Create note
        m_note = re.search(r"\b(?:create|make|write)\s+(?:a\s+)?note\b(?:\s+(?:that|saying|:)\s+(.+))?", text, re.I)
        if m_note:
            return IntentResult(
                intent=IntentType.COMPUTER_ACTION,
                action="create_note",
                target="note",
                memory_content=(m_note.group(1) or "").strip() or None,
                query=(m_note.group(1) or "").strip() or None,
                confidence=0.85,
                cleaned_text=text,
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        # Question vs conversation heuristics
        if text.endswith("?") or re.match(
            r"^(what|who|why|how|when|where|which|can you|could you|tell me|explain)\b",
            text,
            re.I,
        ):
            return IntentResult(
                intent=IntentType.GENERAL_QUESTION,
                query=text,
                confidence=0.7,
                cleaned_text=text,
                remainder=wake.get("remainder") or "",
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        # Short chit-chat: keep confidence below 0.7 so FastReply / LLM can still run
        if len(text.split()) <= 6 and not re.search(r"\b(open|launch|remember|forget|sleep)\b", text):
            return IntentResult(
                intent=IntentType.CONVERSATION,
                query=text,
                confidence=0.55,
                cleaned_text=text,
                wake_matched=bool(wake.get("matched")),
                source="rules",
                raw_text=raw,
            )

        return None

    async def _llm_classify(
        self,
        utterance: str,
        raw: str,
        wake: dict,
        sleep: dict,
    ) -> IntentResult | None:
        try:
            result = await self._llm().chat(
                utterance,
                history=[],
                system_override=INTENT_SYSTEM,
                max_output_tokens=180,
                temperature=0.1,
            )
        except Exception as exc:
            logger.warning("Intent LLM call failed: %s", exc)
            return None
        if not result.success or not result.text:
            return None

        draft = _parse_llm_json(result.text)
        if draft is None:
            return None

        action = draft.action
        if action and action not in ALLOWED_ACTIONS:
            action = None
        target = draft.target
        if draft.intent == IntentType.COMPUTER_ACTION and action == "open_application":
            mapped = _map_app_target(target or "")
            if mapped not in ALLOWED_APP_TARGETS:
                # Reject unsafe/unknown app targets — do not pass through
                return IntentResult(
                    intent=IntentType.UNKNOWN,
                    confidence=0.4,
                    cleaned_text=normalize_for_match(utterance),
                    wake_matched=bool(wake.get("matched")),
                    sleep_matched=bool(sleep.get("matched")),
                    source="llm",
                    raw_text=raw,
                    notes=f"rejected unsafe app target: {target!r}",
                )
            target = mapped

        return IntentResult(
            intent=draft.intent,
            action=action if action != "none" else None,
            target=target,
            query=draft.query,
            memory_content=draft.memory_content,
            confidence=float(draft.confidence),
            cleaned_text=normalize_for_match(utterance),
            remainder=wake.get("remainder") or "",
            wake_matched=bool(wake.get("matched")),
            sleep_matched=bool(sleep.get("matched")),
            source="llm",
            raw_text=raw,
            notes=f"model={result.model}",
        )


def _map_app_target(name: str) -> str:
    n = (name or "").strip().lower()
    aliases = {
        "calc": "calculator",
        "calculator": "calculator",
        "notepad": "notepad",
        "browser": "browser",
        "settings": "settings",
        "explorer": "explorer",
        "file explorer": "explorer",
    }
    return aliases.get(n, n)


def _parse_llm_json(text: str) -> LLMIntentDraft | None:
    t = text.strip()
    # Extract first JSON object if model wrapped it
    if "```" in t:
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    start = t.find("{")
    end = t.rfind("}")
    if start < 0 or end <= start:
        return None
    blob = t[start : end + 1]
    try:
        data = json.loads(blob)
        return LLMIntentDraft.model_validate(data)
    except (json.JSONDecodeError, ValidationError) as exc:
        logger.debug("Intent JSON validation failed: %s", exc)
        return None


@lru_cache
def get_intent_analyzer() -> IntentAnalyzer:
    return IntentAnalyzer()
