"""Module 1 — PermissionManager automated tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.permissions.PermissionManager import PermissionManager
from app.permissions.categories import PermissionCategory


@pytest.fixture
def mgr(tmp_path: Path) -> PermissionManager:
    home = tmp_path / "RAONE"
    return PermissionManager(home=home)


def test_defaults_least_privilege(mgr: PermissionManager):
    assert mgr.config.microphone.granted is False
    assert mgr.config.browser_opening_actions.granted is False
    assert mgr.config.application_launch_actions.granted is False
    assert mgr.config.administrator_required_operations.granted is False
    assert mgr.config.selected_user_folders.granted is False
    # Own app files allowed so RA-ONE can persist data
    assert mgr.config.raone_application_files.granted is True


def test_save_and_reload(mgr: PermissionManager):
    mgr.grant(PermissionCategory.MICROPHONE, notes="user approved")
    mgr2 = PermissionManager(home=mgr.home)
    assert mgr2.config.microphone.granted is True
    assert mgr2.config.microphone.notes == "user approved"


def test_revoke_clears_allowlists(mgr: PermissionManager):
    mgr.set_allowed_applications(["calculator", "notepad"])
    assert mgr.config.application_launch_actions.granted is True
    mgr.revoke(PermissionCategory.APP_LAUNCH)
    assert mgr.config.application_launch_actions.granted is False
    assert mgr.config.allowed_applications == []


def test_config_alone_does_not_authorize_admin(mgr: PermissionManager):
    mgr.grant(PermissionCategory.ADMIN_OPS)
    result = mgr.is_allowed(PermissionCategory.ADMIN_OPS)
    # Unless the pytest process is elevated (it should not be), this must fail
    if not mgr.is_process_elevated():
        assert result.ok is False
        assert "elevation" in result.detail.lower() or "UAC" in result.detail


def test_app_storage_ok(mgr: PermissionManager):
    result = mgr.check_app_storage()
    assert result.ok is True
    assert (mgr.data_dir).is_dir()


def test_folder_allowlist(mgr: PermissionManager, tmp_path: Path):
    docs = tmp_path / "Docs"
    docs.mkdir()
    nested = docs / "notes" / "a.txt"
    nested.parent.mkdir(parents=True)
    nested.write_text("hi", encoding="utf-8")

    mgr.set_allowed_user_folders([str(docs)])
    allowed = mgr.is_allowed(PermissionCategory.USER_FOLDERS, target=str(nested))
    assert allowed.ok is True

    outside = tmp_path / "other" / "x.txt"
    outside.parent.mkdir()
    outside.write_text("nope", encoding="utf-8")
    denied = mgr.is_allowed(PermissionCategory.USER_FOLDERS, target=str(outside))
    assert denied.ok is False


def test_browser_host_allowlist(mgr: PermissionManager):
    mgr.set_allowed_browser_hosts(["example.com"])
    assert mgr.is_allowed(PermissionCategory.BROWSER_OPEN, target="https://example.com/path").ok
    assert mgr.is_allowed(PermissionCategory.BROWSER_OPEN, target="https://www.example.com").ok
    assert mgr.is_allowed(PermissionCategory.BROWSER_OPEN, target="https://evil.test").ok is False


def test_app_launch_allowlist(mgr: PermissionManager):
    mgr.set_allowed_applications(["calculator"])
    assert mgr.is_allowed(PermissionCategory.APP_LAUNCH, target="calculator").ok
    assert mgr.is_allowed(PermissionCategory.APP_LAUNCH, target="cmd").ok is False


def test_status_report_shape(mgr: PermissionManager):
    report = mgr.status_report()
    assert report["module"] == "permission_manager"
    assert report["process_elevated"] is False or isinstance(report["process_elevated"], bool)
    assert len(report["categories"]) == len(PermissionCategory)
    assert "security_notes" in report


def test_api_status(client, tmp_path: Path, monkeypatch):
    # Use isolated manager via app state
    from app.main import create_app
    from app.config import Settings
    from app.services.assistant_state import AssistantStateService
    from app.websocket.manager import ConnectionManager
    from fastapi.testclient import TestClient

    settings = Settings(APP_ENV="development", DEV_MODE=True, CORS_ORIGINS="http://localhost:5173")
    pm = PermissionManager(home=tmp_path / "RAONE")
    application = create_app(
        settings,
        assistant_state=AssistantStateService(),
        ws_manager=ConnectionManager(),
        permission_manager=pm,
    )
    with TestClient(application) as c:
        r = c.get("/api/permissions/status")
        assert r.status_code == 200
        body = r.json()
        assert body["config_path"].endswith("permissions.json")

        r2 = c.post("/api/permissions/grant", json={"category": "microphone", "notes": "test"})
        assert r2.status_code == 200
        assert r2.json()["config"]["microphone"]["granted"] is True

        r3 = c.post("/api/permissions/revoke", json={"category": "microphone"})
        assert r3.status_code == 200
        assert r3.json()["config"]["microphone"]["granted"] is False

        r4 = c.post("/api/permissions/check", json={"category": "application_launch_actions", "target": "calc"})
        assert r4.status_code == 200
        assert r4.json()["ok"] is False
