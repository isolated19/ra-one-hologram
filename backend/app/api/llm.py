"""Module 2 — Offline LLM API (localhost Ollama)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.llm.LocalLLMService import LocalLLMService, get_llm_service
from app.llm.ollama_bootstrap import bootstrap_status

router = APIRouter(prefix="/api/llm", tags=["llm"])


def _svc(request: Request) -> LocalLLMService:
    existing = getattr(request.app.state, "llm_service", None)
    if existing is not None:
        return existing
    return get_llm_service()


class ChatBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list)
    model: str | None = None
    extra_system: str | None = None


class ModelBody(BaseModel):
    model: str = Field(min_length=1, max_length=120)


class ConfigureBody(BaseModel):
    max_output_tokens: int | None = None
    num_ctx: int | None = None
    temperature: float | None = None
    num_thread: int | None = None
    max_history_turns: int | None = None
    timeout_sec: float | None = None


class CancelBody(BaseModel):
    request_id: str | None = None


@router.get("/health")
async def llm_health(request: Request) -> dict[str, Any]:
    h = await _svc(request).health()
    return {
        "ollama_reachable": h.ollama_reachable,
        "base_url": h.base_url,
        "preferred_installed": h.preferred_installed,
        "fallback_installed": h.fallback_installed,
        "selected_model": h.selected_model,
        "installed_models": h.installed_models,
        "detail": h.detail,
        "catalog": h.catalog,
        "runtime": _svc(request).runtime_config(),
        "cloud": False,
        "auto_download": bool(getattr(request.app.state.settings, "ollama_auto_pull", False)),
        "ollama_install": bootstrap_status(),
    }


@router.get("/config")
async def llm_config(request: Request) -> dict[str, Any]:
    return _svc(request).runtime_config()


@router.post("/configure")
async def llm_configure(body: ConfigureBody, request: Request) -> dict[str, Any]:
    return _svc(request).configure(**body.model_dump(exclude_none=True))


@router.post("/model")
async def llm_set_model(body: ModelBody, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    svc.set_model(body.model)
    return {"ok": True, "selected_model": svc.selected_model}


@router.post("/chat")
async def llm_chat(body: ChatBody, request: Request) -> dict[str, Any]:
    result = await _svc(request).chat(
        body.text,
        history=body.history,
        model=body.model,
        extra_system=body.extra_system,
    )
    if not result.success and not result.cancelled:
        # 503 when Ollama/model missing — client can show setup instructions
        raise HTTPException(
            status_code=503,
            detail={
                "error": result.error,
                "model": result.model,
                "request_id": result.request_id,
            },
        )
    return {
        "success": result.success,
        "text": result.text,
        "model": result.model,
        "error": result.error,
        "latency_ms": result.latency_ms,
        "prompt_tokens": result.prompt_tokens,
        "eval_tokens": result.eval_tokens,
        "cancelled": result.cancelled,
        "request_id": result.request_id,
        "display_name": "RA-ONE",
    }


@router.post("/cancel")
async def llm_cancel(body: CancelBody, request: Request) -> dict[str, Any]:
    n = await _svc(request).cancel(body.request_id)
    return {"ok": True, "cancelled": n}


@router.post("/warm")
async def llm_warm(request: Request) -> dict[str, Any]:
    result = await _svc(request).warm()
    return {
        "success": result.success,
        "text": result.text,
        "model": result.model,
        "error": result.error,
        "latency_ms": result.latency_ms,
    }
