"""
Route a user utterance to the correct handler.

Real LLM is the default for questions/conversation.
Mock/test responses only when explicitly requested (dev mode flag).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.actions.ActionExecutor import ActionExecutor
from app.conversation.FastReplyService import match_fast_reply
from app.core.logging import get_logger
from app.intent.IntentAnalyzer import IntentAnalyzer
from app.intent.schemas import IntentType
from app.llm.LocalLLMService import ChatMessage, LocalLLMService
from app.llm.models_info import EMOTION_PROMPT, WEB_PROMPT
from app.llm.ollama_bootstrap import bootstrap_status
from app.web.WebLookup import WebAnswer, WebLookup, classify as classify_web

logger = get_logger(__name__)


@dataclass
class RouteResult:
    success: bool
    text: str
    source: str  # llm | action | intent | error | mock
    intent: str = "unknown"
    action: str | None = None
    model: str | None = None
    simulated: bool = False
    error: str | None = None
    latency_ms: float = 0.0
    meta: dict[str, Any] = field(default_factory=dict)


class AssistantResponseRouter:
    def __init__(
        self,
        llm: LocalLLMService,
        intent: IntentAnalyzer,
        actions: ActionExecutor | None = None,
        *,
        allow_mock: bool = False,
        web: WebLookup | None = None,
    ) -> None:
        self.llm = llm
        self.intent = intent
        self.actions = actions
        self.allow_mock = allow_mock
        self.web = web

    async def route(
        self,
        text: str,
        *,
        history: list[dict[str, str]] | None = None,
        use_mock: bool = False,
        confirm_action: bool = False,
        emotion: dict[str, Any] | None = None,
    ) -> RouteResult:
        cleaned = (text or "").strip()
        if not cleaned:
            return RouteResult(success=False, text="", source="error", error="Empty question")

        # Dev-only mock path
        if use_mock and self.allow_mock:
            return RouteResult(
                success=True,
                text="(Developer mock mode) I received your question.",
                source="mock",
                simulated=True,
                intent="conversation",
            )

        # Module 22: zero-LLM path for greetings / time / identity (fixes 10s "hi" replies)
        fast = match_fast_reply(cleaned)
        if fast:
            logger.info("fast_reply reason=%s chars=%d", fast.reason, len(fast.text))
            return RouteResult(
                success=True,
                text=fast.text,
                source="fast",
                intent=fast.intent,
                simulated=False,
                meta={"fast_reason": fast.reason, "skipped_llm": True},
            )

        # Live data (weather / news / facts): go online before the local model guesses
        web_answer: WebAnswer | None = None
        web_query = classify_web(cleaned) if self.web else None
        if web_query:
            web_answer = await self.web.answer(web_query)
            if web_answer and web_answer.direct:
                logger.info("web_answer kind=%s source=%s", web_answer.kind, web_answer.source)
                return RouteResult(
                    success=True,
                    text=web_answer.text,
                    source="web",
                    intent="general_question",
                    meta={"web_source": web_answer.source, "web_kind": web_answer.kind},
                )

        intent = await self.intent.analyze(cleaned)
        intent_name = intent.intent.value

        if intent.intent == IntentType.SLEEP_COMMAND:
            return RouteResult(
                success=True,
                text="Entering sleep mode.",
                source="intent",
                intent=intent_name,
                meta={"sleep": True},
            )

        if intent.intent == IntentType.WAKE_COMMAND:
            return RouteResult(
                success=True,
                text="I'm here.",
                source="intent",
                intent=intent_name,
                meta={"wake": True},
            )

        if intent.intent == IntentType.COMPUTER_ACTION and intent.action and self.actions:
            result = self.actions.execute_from_intent(
                action=intent.action,
                target=intent.target,
                query=intent.query,
                memory_content=intent.memory_content,
                confirm=confirm_action,
                dry_run=False,
                source="conversation",
            )
            if result.requires_confirmation:
                return RouteResult(
                    success=True,
                    text=f"I can {intent.action.replace('_', ' ')} {intent.target or ''}. Confirm to proceed.".strip(),
                    source="action",
                    intent=intent_name,
                    action=intent.action,
                    meta={"requires_confirmation": True, "action_result": result.model_dump()},
                )
            if result.permission_denied:
                return RouteResult(
                    success=True,
                    text=f"I can't do that yet. {result.message}",
                    source="action",
                    intent=intent_name,
                    action=intent.action,
                    meta={"permission_denied": True},
                )
            if result.success:
                spoken = result.message
                return RouteResult(
                    success=True,
                    text=spoken,
                    source="action",
                    intent=intent_name,
                    action=intent.action,
                    meta={"action_result": result.model_dump()},
                )

        if intent.intent in (
            IntentType.REMEMBER_INFORMATION,
            IntentType.RETRIEVE_INFORMATION,
            IntentType.MEMORY_REQUEST,
        ):
            # Memory modules land later — be honest, do not pretend
            return RouteResult(
                success=True,
                text=(
                    "Memory storage is not fully connected yet. "
                    "I heard your request and will support approved memories in a later module."
                ),
                source="intent",
                intent=intent_name,
                meta={"memory_pending": True},
            )

        # Default: real local LLM
        health = await self.llm.health()
        no_model = not health.preferred_installed and not health.fallback_installed
        if web_answer and (not health.ollama_reachable or no_model):
            # Online facts still work while the local model is down or downloading
            return RouteResult(
                success=True,
                text=web_answer.text,
                source="web",
                intent=intent_name,
                meta={"web_source": web_answer.source, "web_kind": web_answer.kind},
            )
        install = bootstrap_status()
        if not health.ollama_reachable:
            if install["state"] in ("checking", "installing", "starting"):
                error = "Ollama is being installed and started automatically. Try again in a minute."
            else:
                error = (
                    "Ollama is offline. Install and start Ollama, then pull qwen3:1.7b "
                    "(see backend/scripts/setup_ollama.ps1)."
                )
            return RouteResult(
                success=False,
                text="",
                source="error",
                intent=intent_name,
                error=error,
                meta={"ollama_reachable": False},
            )
        if no_model:
            if install["state"] == "pulling-model":
                error = "I'm still downloading my language model, sir. Give me a few minutes."
            else:
                error = (
                    f"No Qwen3 model installed. Preferred {health.catalog and 'qwen3:1.7b'}. "
                    "Run setup_ollama.ps1 and type YES to download."
                )
            return RouteResult(
                success=False,
                text="",
                source="error",
                intent=intent_name,
                error=error,
                meta={
                    "preferred_installed": False,
                    "fallback_installed": False,
                    "installed_models": health.installed_models,
                },
            )

        question = intent.query or intent.cleaned_text or cleaned
        extra: list[str] = []
        if web_answer:
            extra.append(WEB_PROMPT.format(results="\n".join(web_answer.context)))
        mood = _emotion_label(emotion)
        if mood:
            extra.append(EMOTION_PROMPT.format(label=mood[0], pct=mood[1]))
        gen = await self.llm.chat(
            question,
            history=history or [],
            extra_system="\n".join(extra) or None,
        )
        if not gen.success and web_answer:
            return RouteResult(
                success=True,
                text=web_answer.text,
                source="web",
                intent=intent_name,
                meta={"web_source": web_answer.source, "web_kind": web_answer.kind},
            )
        if not gen.success:
            return RouteResult(
                success=False,
                text="",
                source="error",
                intent=intent_name,
                model=gen.model,
                error=gen.error or "LLM generation failed",
                latency_ms=gen.latency_ms,
            )

        return RouteResult(
            success=True,
            text=gen.text,
            source="llm",
            intent=intent_name,
            model=gen.model,
            simulated=False,
            latency_ms=gen.latency_ms,
            meta={
                "prompt_tokens": gen.prompt_tokens,
                "eval_tokens": gen.eval_tokens,
                "request_id": gen.request_id,
                **({"web_source": web_answer.source} if web_answer else {}),
            },
        )


_EMOTIONS = {"happy", "sad", "angry", "fearful", "disgusted", "surprised"}


def _emotion_label(emotion: dict[str, Any] | None) -> tuple[str, int] | None:
    """Camera mood worth telling the model about: a known, non-neutral, confident label."""
    if not emotion:
        return None
    label = str(emotion.get("label") or "").lower()
    try:
        confidence = float(emotion.get("confidence") or 0)
    except (TypeError, ValueError):
        return None
    if label not in _EMOTIONS or confidence < 0.5:
        return None
    if label == "fearful":
        label = "worried"
    elif label == "disgusted":
        label = "displeased"
    return label, round(confidence * 100)
