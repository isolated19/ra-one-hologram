"""Assistant status / state HTTP endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from app.config import Settings
from app.core.logging import get_logger
from app.models.schemas import (
    AssistantStatusResponse,
    SetAssistantStateRequest,
)
from app.services.assistant_state import (
    InvalidAssistantStateError,
    AssistantStateService,
)
from app.websocket.manager import ConnectionManager

logger = get_logger(__name__)
router = APIRouter(prefix="/api/assistant", tags=["assistant"])


def _status_payload(
    service: AssistantStateService,
    manager: ConnectionManager,
) -> AssistantStatusResponse:
    data = service.get_status()
    return AssistantStatusResponse(
        state=data["state"],
        previous_state=data["previous_state"],
        updated_at=data["updated_at"],
        connected_clients=manager.connection_count,
    )


@router.get("/status", response_model=AssistantStatusResponse)
async def get_assistant_status(request: Request) -> AssistantStatusResponse:
    service: AssistantStateService = request.app.state.assistant_state
    manager: ConnectionManager = request.app.state.ws_manager
    return _status_payload(service, manager)


@router.post("/state", response_model=AssistantStatusResponse)
async def set_assistant_state(
    body: SetAssistantStateRequest,
    request: Request,
) -> AssistantStatusResponse:
    """
    Development-only state mutation.

    Disabled when APP_ENV=production or DEV_MODE=false.
    """
    settings: Settings = request.app.state.settings
    if not settings.state_mutation_allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Assistant state mutation is disabled. "
                "Enable DEV_MODE in a non-production environment."
            ),
        )

    service: AssistantStateService = request.app.state.assistant_state
    manager: ConnectionManager = request.app.state.ws_manager

    try:
        event = service.set_state(body.state, source=body.source or "api")
    except InvalidAssistantStateError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    sent = await manager.broadcast(event.to_ws_dict())
    logger.debug("Broadcast assistant.state to %s client(s)", sent)
    return _status_payload(service, manager)
