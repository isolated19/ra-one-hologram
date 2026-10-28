"""Module 4 — ActionExecutor allowlist / permission / confirmation tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.actions.ActionExecutor import ActionExecutor
from app.actions.schemas import ActionId, ActionRequest
from app.config import Settings
from app.main import create_app
from app.permissions.PermissionManager import PermissionManager
from app.permissions.categories import PermissionCategory
from app.services.assistant_state import AssistantStateService
from app.websocket.manager import ConnectionManager


@pytest.fixture
def home(tmp_path: Path) -> Path:
    return tmp_path / "RAONE"


@pytest.fixture
def perms(home: Path) -> PermissionManager:
    return PermissionManager(home=home)


@pytest.fixture
def executor(perms: PermissionManager, home: Path) -> ActionExecutor:
    return ActionExecutor(permissions=perms, home=home)


def test_catalog_and_deny_without_permission(executor: ActionExecutor):
    result = executor.execute(
        ActionRequest(
            action=ActionId.OPEN_APPLICATION,
            params={"target": "calculator"},
            dry_run=True,
        )
    )
    assert result.success is False
    assert result.permission_denied is True


def test_open_calculator_dry_run_with_allowlist(executor: ActionExecutor, perms: PermissionManager):
    perms.set_allowed_applications(["calculator"])
    result = executor.execute(
        ActionRequest(
            action=ActionId.OPEN_APPLICATION,
            params={"target": "calculator"},
            dry_run=True,
        )
    )
    assert result.success is True
    assert result.dry_run is True
    assert result.data["target"] == "calculator"


def test_unapproved_app_rejected(executor: ActionExecutor, perms: PermissionManager):
    perms.set_allowed_applications(["calculator"])
    result = executor.execute(
        ActionRequest(
            action=ActionId.OPEN_APPLICATION,
            params={"target": "notepad"},
            dry_run=True,
        )
    )
    assert result.success is False
    assert result.permission_denied is True


def test_create_note_requires_confirm(executor: ActionExecutor):
    result = executor.execute(
        ActionRequest(
            action=ActionId.CREATE_NOTE,
            params={"title": "idea", "content": "hello world", "confirm": False},
        )
    )
    assert result.success is False
    assert result.requires_confirmation is True


def test_create_note_writes_under_raone(executor: ActionExecutor, home: Path):
    result = executor.execute(
        ActionRequest(
            action=ActionId.CREATE_NOTE,
            params={"title": "idea", "content": "stored note", "confirm": True},
        )
    )
    assert result.success is True
    path = Path(result.data["path"])
    assert path.exists()
    assert str(home.resolve()) in str(path.resolve())
    assert path.read_text(encoding="utf-8") == "stored note"


def test_read_file_outside_allowlist_denied(executor: ActionExecutor, tmp_path: Path):
    secret = tmp_path / "secret.txt"
    secret.write_text("nope", encoding="utf-8")
    result = executor.execute(
        ActionRequest(
            action=ActionId.READ_TEXT_FILE,
            params={"path": str(secret)},
        )
    )
    assert result.success is False
    assert result.permission_denied is True


def test_read_file_in_allowlist(executor: ActionExecutor, perms: PermissionManager, tmp_path: Path):
    docs = tmp_path / "docs"
    docs.mkdir()
    f = docs / "a.txt"
    f.write_text("hello from file", encoding="utf-8")
    perms.set_allowed_user_folders([str(docs)])
    result = executor.execute(
        ActionRequest(
            action=ActionId.READ_TEXT_FILE,
            params={"path": str(f)},
        )
    )
    assert result.success is True
    assert result.data["content"] == "hello from file"
    assert result.data["executable_content"] is False


def test_open_url_requires_host_allowlist_and_confirm(executor: ActionExecutor, perms: PermissionManager):
    perms.set_allowed_browser_hosts(["example.com"])
    denied = executor.execute(
        ActionRequest(
            action=ActionId.OPEN_URL,
            params={"url": "https://example.com/x", "confirm": False},
            dry_run=True,
        )
    )
    assert denied.requires_confirmation is True

    ok = executor.execute(
        ActionRequest(
            action=ActionId.OPEN_URL,
            params={"url": "https://example.com/x", "confirm": True},
            dry_run=True,
        )
    )
    assert ok.success is True

    blocked = executor.execute(
        ActionRequest(
            action=ActionId.OPEN_URL,
            params={"url": "https://evil.test/", "confirm": True},
            dry_run=True,
        )
    )
    assert blocked.permission_denied is True


def test_system_info(executor: ActionExecutor):
    result = executor.execute(ActionRequest(action=ActionId.REPORT_SYSTEM_INFO, params={}))
    assert result.success is True
    assert "system" in result.data


def test_from_intent_open_calculator(executor: ActionExecutor, perms: PermissionManager):
    perms.set_allowed_applications(["calculator"])
    result = executor.execute_from_intent(
        action="open_application",
        target="calculator",
        dry_run=True,
    )
    assert result.success is True


def test_rejects_unknown_action_string(executor: ActionExecutor):
    result = executor.execute_from_intent(action="format_disk", dry_run=True)
    assert result.success is False
    assert result.permission_denied is True


def test_api_execute(tmp_path: Path):
    home = tmp_path / "RAONE"
    perms = PermissionManager(home=home)
    perms.set_allowed_applications(["notepad"])
    ex = ActionExecutor(permissions=perms, home=home)
    settings = Settings(APP_ENV="development", DEV_MODE=True, CORS_ORIGINS="http://localhost:5173")
    app = create_app(
        settings,
        assistant_state=AssistantStateService(),
        ws_manager=ConnectionManager(),
        permission_manager=perms,
        action_executor=ex,
    )
    with TestClient(app) as client:
        r = client.get("/api/actions/catalog")
        assert r.status_code == 200
        assert "open_application" in r.json()["actions"]

        r2 = client.post(
            "/api/actions/execute",
            json={
                "action": "open_application",
                "params": {"target": "notepad"},
                "dry_run": True,
            },
        )
        assert r2.status_code == 200
        assert r2.json()["success"] is True

        r3 = client.post(
            "/api/actions/from-intent",
            json={"action": "open_application", "target": "calculator", "dry_run": True},
        )
        assert r3.status_code == 200
        assert r3.json()["permission_denied"] is True  # calculator not allowlisted
