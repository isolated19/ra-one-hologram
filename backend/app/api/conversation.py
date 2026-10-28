"""Conversation turn API — real local LLM by default."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.conversation.ConversationService import ConversationService, get_conversation_service
from app.llm.ollama_bootstrap import bootstrap_status

router = APIRouter(prefix="/api/conversation", tags=["conversation"])


def _svc(request: Request) -> ConversationService:
    existing = getattr(request.app.state, "conversation_service", None)
    if existing is not None:
        return existing
    return get_conversation_service()


class TurnBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    use_mock: bool = False
    confirm_action: bool = False
    correlation_id: str | None = None
    # Camera-read expression from the UI, e.g. {"label": "sad", "confidence": 0.8}
    emotion: dict[str, Any] | None = None


@router.post("/turn")
async def conversation_turn(body: TurnBody, request: Request) -> dict[str, Any]:
    settings = request.app.state.settings
    allow_mock = bool(getattr(settings, "dev_mode", False)) and not settings.is_production
    if body.use_mock and not allow_mock:
        raise HTTPException(status_code=400, detail="Mock responses only allowed in development")

    result = await _svc(request).handle_turn(
        body.text,
        use_mock=body.use_mock and allow_mock,
        confirm_action=body.confirm_action,
        correlation_id=body.correlation_id,
        emotion=body.emotion,
    )
    if not result.get("success"):
        # Surface as 503 so the UI can show a real error (not a fake answer)
        raise HTTPException(status_code=503, detail=result)
    return result


@router.post("/clear")
async def conversation_clear(request: Request) -> dict[str, Any]:
    _svc(request).clear()
    return {"ok": True, "session_id": _svc(request).session_id}


@router.get("/health")
async def conversation_health(request: Request) -> dict[str, Any]:
    llm = await request.app.state.llm_service.health()
    return {
        "conversation": True,
        "ollama_reachable": llm.ollama_reachable,
        "selected_model": llm.selected_model,
        "preferred_installed": llm.preferred_installed,
        "fallback_installed": llm.fallback_installed,
        "detail": llm.detail,
        "ollama_install": bootstrap_status(),
    }
