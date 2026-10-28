"""Pytest fixtures for Module 1 backend tests."""

from __future__ import annotations

import os

# Tests must never install Ollama, pull a 1.4 GB model or call the internet from app startup
os.environ.setdefault("OLLAMA_AUTO_INSTALL", "false")
os.environ.setdefault("OLLAMA_AUTO_PULL", "false")
os.environ.setdefault("WEB_LOOKUP_ENABLED", "false")

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.assistant_state import AssistantStateService
from app.websocket.manager import ConnectionManager


@pytest.fixture
def settings_dev() -> Settings:
    return Settings(
        APP_ENV="development",
        DEV_MODE=True,
        CORS_ORIGINS="http://localhost:5173",
        LOG_LEVEL="WARNING",
    )


@pytest.fixture
def settings_prod() -> Settings:
    return Settings(
        APP_ENV="production",
        DEV_MODE=True,  # ignored in production
        CORS_ORIGINS="http://localhost:5173",
        LOG_LEVEL="WARNING",
    )


@pytest.fixture
def app(settings_dev: Settings):
    return create_app(
        settings_dev,
        assistant_state=AssistantStateService(),
        ws_manager=ConnectionManager(),
    )


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def prod_client(settings_prod: Settings):
    application = create_app(
        settings_prod,
        assistant_state=AssistantStateService(),
        ws_manager=ConnectionManager(),
    )
    with TestClient(application) as c:
        yield c
