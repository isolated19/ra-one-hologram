"""Short-term conversation window + routing to the local LLM."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from app.actions.ActionExecutor import ActionExecutor
from app.conversation.AssistantResponseRouter import AssistantResponseRouter, RouteResult
from app.core.logging import get_logger
from app.intent.IntentAnalyzer import IntentAnalyzer
from app.llm.LocalLLMService import LocalLLMService, get_llm_service
from app.web.WebLookup import WebLookup

logger = get_logger(__name__)


@dataclass
class TurnRecord:
    role: str
    content: str
    ts: float = field(default_factory=time.time)


class ConversationService:
    def __init__(
        self,
        llm: LocalLLMService | None = None,
        intent: IntentAnalyzer | None = None,
        actions: ActionExecutor | None = None,
        *,
        max_turns: int = 8,
        allow_mock: bool = False,
        web: WebLookup | None = None,
    ) -> None:
        self.llm = llm or get_llm_service()
        self.intent = intent or IntentAnalyzer(llm=self.llm)
        self.actions = actions
        self.max_turns = max_turns
        self.router = AssistantResponseRouter(
            self.llm,
            self.intent,
            actions=self.actions,
            allow_mock=allow_mock,
            web=web,
        )
        self.session_id = str(uuid.uuid4())
        self._history: list[TurnRecord] = []

    def clear(self) -> None:
        self._history.clear()
        self.session_id = str(uuid.uuid4())

    def history_for_llm(self) -> list[dict[str, str]]:
        # Keep last N user/assistant pairs
        out: list[dict[str, str]] = []
        for turn in self._history[-(self.max_turns * 2) :]:
            out.append({"role": turn.role, "content": turn.content})
        return out

    async def handle_turn(
        self,
        text: str,
        *,
        use_mock: bool = False,
        confirm_action: bool = False,
        correlation_id: str | None = None,
        emotion: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cid = correlation_id or str(uuid.uuid4())
        t0 = time.perf_counter()
        logger.info("conversation.turn start id=%s", cid)

        result: RouteResult = await self.router.route(
            text,
            history=self.history_for_llm(),
            use_mock=use_mock,
            confirm_action=confirm_action,
            emotion=emotion,
        )

        if result.success and result.text and result.source in ("llm", "action", "intent", "mock", "fast", "web"):
            self._history.append(TurnRecord(role="user", content=text.strip()))
            self._history.append(TurnRecord(role="assistant", content=result.text))

        payload = {
            "success": result.success,
            "text": result.text,
            "display_name": "RA-ONE",
            "source": result.source,
            "intent": result.intent,
            "action": result.action,
            "model": result.model,
            "simulated": result.simulated,
            "error": result.error,
            "latency_ms": result.latency_ms or (time.perf_counter() - t0) * 1000,
            "correlation_id": cid,
            "session_id": self.session_id,
            "meta": result.meta,
        }
        logger.info(
            "conversation.turn end id=%s source=%s success=%s latency_ms=%.0f",
            cid,
            result.source,
            result.success,
            payload["latency_ms"],
        )
        return payload


@lru_cache
def get_conversation_service() -> ConversationService:
    return ConversationService()
