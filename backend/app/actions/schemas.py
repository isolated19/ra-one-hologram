"""Explicit input schemas for allowlisted tools."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class ActionId(str, Enum):
    OPEN_APPLICATION = "open_application"
    OPEN_URL = "open_url"
    READ_TEXT_FILE = "read_text_file"
    CREATE_NOTE = "create_note"
    REPORT_SYSTEM_INFO = "report_system_info"


class AppTarget(str, Enum):
    CALCULATOR = "calculator"
    NOTEPAD = "notepad"
    BROWSER = "browser"
    SETTINGS = "settings"
    EXPLORER = "explorer"


# Windows launch map — fixed binaries/URIs only (no user-supplied exe paths)
APP_LAUNCH_MAP: dict[str, list[str]] = {
    "calculator": ["calc.exe"],
    "notepad": ["notepad.exe"],
    "explorer": ["explorer.exe"],
    "settings": ["cmd.exe", "/c", "start", "", "ms-settings:"],
    # browser without URL just opens default browser home via Windows
    "browser": ["cmd.exe", "/c", "start", "", "https://"],
}


class OpenApplicationInput(BaseModel):
    target: AppTarget
    confirm: bool = False


class OpenUrlInput(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    confirm: bool = True  # consequential: opens external content

    @field_validator("url")
    @classmethod
    def http_only(cls, v: str) -> str:
        u = v.strip()
        lower = u.lower()
        if not (lower.startswith("https://") or lower.startswith("http://")):
            raise ValueError("Only http(s) URLs are allowed")
        # Block local file / dangerous schemes smuggled in
        if any(x in lower for x in ("file:", "javascript:", "data:", "vbscript:")):
            raise ValueError("Blocked URL scheme")
        return u


class ReadTextFileInput(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    max_bytes: int = Field(default=32_000, ge=1, le=200_000)
    confirm: bool = False


class CreateNoteInput(BaseModel):
    title: str = Field(default="note", max_length=80)
    content: str = Field(min_length=1, max_length=20_000)
    confirm: bool = True  # writes a file — require confirmation

    @field_validator("title")
    @classmethod
    def safe_title(cls, v: str) -> str:
        cleaned = "".join(c for c in v if c.isalnum() or c in (" ", "-", "_")).strip()
        return (cleaned or "note")[:80]


class ReportSystemInfoInput(BaseModel):
    confirm: bool = False


class ActionRequest(BaseModel):
    """Envelope used by the API / orchestrator."""

    action: ActionId
    # Loose payload validated per-action
    params: dict[str, Any] = Field(default_factory=dict)
    # Intent recognition alone is never enough; caller must acknowledge
    intent_authorized: Literal[False] = False
    dry_run: bool = False
    source: str = "api"


class ActionResult(BaseModel):
    success: bool
    action: str
    message: str
    data: dict[str, Any] = Field(default_factory=dict)
    requires_confirmation: bool = False
    permission_denied: bool = False
    audit_id: str | None = None
    dry_run: bool = False
