"""Pydantic schemas for Module 1 assistant API and WebSocket events."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

ASSISTANT_STATES = ("idle", "listening", "thinking", "speaking")
AssistantState = Literal["idle", "listening", "thinking", "speaking"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "ra-one-backend"
    version: str
    environment: str
    dev_mode: bool
    timestamp: datetime = Field(default_factory=utc_now)


class AssistantStatusResponse(BaseModel):
    state: AssistantState
    previous_state: AssistantState | None = None
    updated_at: datetime
    connected_clients: int = 0


class SetAssistantStateRequest(BaseModel):
    state: AssistantState
    source: str = Field(default="api", max_length=64)


class AssistantStateEvent(BaseModel):
    """Canonical WebSocket payload for frontend sync."""

    type: Literal["assistant.state"] = "assistant.state"
    state: AssistantState
    timestamp: datetime = Field(default_factory=utc_now)
    previous_state: AssistantState | None = None
    source: str | None = None

    def to_ws_dict(self) -> dict:
        data = self.model_dump(mode="json")
        # ISO-8601 with Z suffix for frontend readability
        ts = self.timestamp
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        data["timestamp"] = ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return data
