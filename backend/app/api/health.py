"""Health check endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app import __version__
from app.config import Settings
from app.models.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/api/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    settings: Settings = request.app.state.settings
    return HealthResponse(
        version=__version__,
        environment=settings.app_env,
        dev_mode=settings.dev_mode and not settings.is_production,
    )
