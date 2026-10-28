"""Module 3 — Intent analysis API (classify only; never execute)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.intent.IntentAnalyzer import IntentAnalyzer, get_intent_analyzer
from app.intent.schemas import ALLOWED_ACTIONS, ALLOWED_APP_TARGETS, IntentType

router = APIRouter(prefix="/api/intent", tags=["intent"])


def _analyzer(request: Request) -> IntentAnalyzer:
    existing = getattr(request.app.state, "intent_analyzer", None)
    if existing is not None:
        return existing
    return get_intent_analyzer()


class AnalyzeBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    force_llm: bool = False
    rules_only: bool = False


@router.get("/schema")
async def intent_schema() -> dict[str, Any]:
    return {
        "intents": [i.value for i in IntentType],
        "allowed_actions": sorted(ALLOWED_ACTIONS),
        "allowed_app_targets": sorted(ALLOWED_APP_TARGETS),
        "authorization": False,
        "note": "Intent recognition is not permission to execute actions.",
    }


@router.post("/analyze")
async def analyze_intent(body: AnalyzeBody, request: Request) -> dict[str, Any]:
    analyzer = _analyzer(request)
    if body.rules_only:
        result = analyzer.analyze_sync_rules_only(body.text)
    else:
        result = await analyzer.analyze(body.text, force_llm=body.force_llm)
    return result.to_public_dict()
