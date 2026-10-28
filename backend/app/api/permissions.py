"""Module 1 — localhost permissions API (app consent + OS checks)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.permissions.PermissionManager import PermissionManager, get_permission_manager
from app.permissions.categories import PermissionCategory

router = APIRouter(prefix="/api/permissions", tags=["permissions"])


def _mgr(request: Request) -> PermissionManager:
    existing = getattr(request.app.state, "permission_manager", None)
    if existing is not None:
        return existing
    return get_permission_manager()


class GrantBody(BaseModel):
    category: PermissionCategory
    notes: str = ""


class RevokeBody(BaseModel):
    category: PermissionCategory


class FoldersBody(BaseModel):
    paths: list[str] = Field(default_factory=list)


class HostsBody(BaseModel):
    hosts: list[str] = Field(default_factory=list)


class AppsBody(BaseModel):
    applications: list[str] = Field(default_factory=list)


class CheckBody(BaseModel):
    category: PermissionCategory
    target: str | None = None


class AdminOpBody(BaseModel):
    """Describe a one-shot elevated operation. Never silently elevates the main app."""

    operation_description: str = Field(min_length=3, max_length=500)
    command: list[str] = Field(min_length=1)


@router.get("/status")
async def permissions_status(request: Request) -> dict[str, Any]:
    return _mgr(request).status_report()


@router.get("/settings")
async def permissions_settings(request: Request) -> dict[str, Any]:
    return _mgr(request).settings_interface()


@router.post("/grant")
async def grant_permission(body: GrantBody, request: Request) -> dict[str, Any]:
    mgr = _mgr(request)
    cfg = mgr.grant(body.category, notes=body.notes)
    return {"ok": True, "config": cfg.to_dict(), "status": mgr.status_report()}


@router.post("/revoke")
async def revoke_permission(body: RevokeBody, request: Request) -> dict[str, Any]:
    mgr = _mgr(request)
    cfg = mgr.revoke(body.category)
    return {"ok": True, "config": cfg.to_dict(), "status": mgr.status_report()}


@router.put("/allowlists/folders")
async def set_folders(body: FoldersBody, request: Request) -> dict[str, Any]:
    mgr = _mgr(request)
    cfg = mgr.set_allowed_user_folders(body.paths)
    return {"ok": True, "allowed_user_folders": cfg.allowed_user_folders}


@router.put("/allowlists/browser-hosts")
async def set_hosts(body: HostsBody, request: Request) -> dict[str, Any]:
    mgr = _mgr(request)
    cfg = mgr.set_allowed_browser_hosts(body.hosts)
    return {"ok": True, "allowed_browser_hosts": cfg.allowed_browser_hosts}


@router.put("/allowlists/applications")
async def set_apps(body: AppsBody, request: Request) -> dict[str, Any]:
    mgr = _mgr(request)
    cfg = mgr.set_allowed_applications(body.applications)
    return {"ok": True, "allowed_applications": cfg.allowed_applications}


@router.post("/check")
async def check_permission(body: CheckBody, request: Request) -> dict[str, Any]:
    result = _mgr(request).is_allowed(body.category, target=body.target)
    return {"ok": result.ok, "detail": result.detail, "evidence": result.evidence}


@router.post("/open/microphone-settings")
async def open_mic_settings(request: Request) -> dict[str, Any]:
    result = _mgr(request).open_microphone_settings()
    return {"ok": result.ok, "detail": result.detail}


@router.post("/open/privacy-settings")
async def open_privacy_settings(request: Request) -> dict[str, Any]:
    result = _mgr(request).open_general_privacy_settings()
    return {"ok": result.ok, "detail": result.detail}


@router.post("/admin/request-elevation")
async def request_elevation(body: AdminOpBody, request: Request) -> dict[str, Any]:
    """
    Triggers a standard Windows UAC prompt for a one-shot command.
    Rejects if admin category is not approved in app settings.
    """
    # Block obviously dangerous patterns at the API boundary (Module 4 will harden further)
    joined = " ".join(body.command).lower()
    blocked = ("format ", "shutdown", "del /s", "rm -rf", "reg delete", "net user")
    if any(b in joined for b in blocked):
        raise HTTPException(status_code=400, detail="Command blocked by safety filter")
    result = _mgr(request).request_admin_operation(body.operation_description, body.command)
    return {"ok": result.ok, "detail": result.detail, "evidence": result.evidence}
