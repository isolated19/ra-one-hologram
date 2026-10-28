"""Module 4 — Allowlisted action execution API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.actions.ActionExecutor import ActionExecutor, get_action_executor
from app.actions.schemas import ActionId, ActionRequest, APP_LAUNCH_MAP

router = APIRouter(prefix="/api/actions", tags=["actions"])


def _ex(request: Request) -> ActionExecutor:
    existing = getattr(request.app.state, "action_executor", None)
    if existing is not None:
        return existing
    return get_action_executor()


class ExecuteBody(BaseModel):
    action: ActionId
    params: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False
    source: str = "api"


class FromIntentBody(BaseModel):
    action: str | None = None
    target: str | None = None
    query: str | None = None
    memory_content: str | None = None
    confirm: bool = False
    dry_run: bool = False


@router.get("/catalog")
async def action_catalog() -> dict[str, Any]:
    return {
        "actions": [a.value for a in ActionId],
        "applications": sorted(APP_LAUNCH_MAP.keys()),
        "notes": [
            "Intent recognition is not authorization.",
            "Consequential actions require confirm=true.",
            "No arbitrary shell execution.",
            "Admin elevation is never silent.",
        ],
    }


@router.post("/execute")
async def execute_action(body: ExecuteBody, request: Request) -> dict[str, Any]:
    result = _ex(request).execute(
        ActionRequest(
            action=body.action,
            params=body.params,
            dry_run=body.dry_run,
            source=body.source,
            intent_authorized=False,
        )
    )
    return result.model_dump()


@router.post("/from-intent")
async def execute_from_intent(body: FromIntentBody, request: Request) -> dict[str, Any]:
    result = _ex(request).execute_from_intent(
        action=body.action,
        target=body.target,
        query=body.query,
        memory_content=body.memory_content,
        confirm=body.confirm,
        dry_run=body.dry_run,
        source="intent",
    )
    return result.model_dump()


@router.get("/audit")
async def recent_audit(request: Request, limit: int = 20) -> dict[str, Any]:
    return {"entries": _ex(request).recent_audit(limit=min(100, max(1, limit)))}
