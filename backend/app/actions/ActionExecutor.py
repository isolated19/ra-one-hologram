"""
Safe Computer Action Executor (Module 4).

- Small allowlist only
- Permission checks via PermissionManager
- Input schema validation
- Audit logging
- Confirmation required for consequential writes / URL opens
- No arbitrary shell, no silent admin elevation
- Does not execute instructions found in files or model text
"""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from pydantic import ValidationError

from app.actions.schemas import (
    APP_LAUNCH_MAP,
    ActionId,
    ActionRequest,
    ActionResult,
    AppTarget,
    CreateNoteInput,
    OpenApplicationInput,
    OpenUrlInput,
    ReadTextFileInput,
    ReportSystemInfoInput,
)
from app.core.logging import get_logger
from app.permissions.PermissionManager import PermissionManager, get_permission_manager
from app.permissions.categories import PermissionCategory

logger = get_logger(__name__)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ActionExecutor:
    def __init__(
        self,
        permissions: PermissionManager | None = None,
        *,
        home: Path | None = None,
    ) -> None:
        self.permissions = permissions or get_permission_manager()
        self.home = Path(home) if home else self.permissions.home
        self.notes_dir = self.home / "data" / "notes"
        self.audit_path = self.home / "logs" / "actions.jsonl"
        self.notes_dir.mkdir(parents=True, exist_ok=True)
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ public

    def execute(self, request: ActionRequest | dict[str, Any]) -> ActionResult:
        if isinstance(request, dict):
            try:
                request = ActionRequest.model_validate(request)
            except ValidationError as exc:
                return ActionResult(
                    success=False,
                    action="invalid",
                    message=f"Invalid action request: {exc.errors()[0].get('msg', exc)}",
                )

        # Intent is never authorization
        if getattr(request, "intent_authorized", False):
            return ActionResult(
                success=False,
                action=request.action.value,
                message="intent_authorized must be false; intent is not permission",
                permission_denied=True,
            )

        handlers = {
            ActionId.OPEN_APPLICATION: self._open_application,
            ActionId.OPEN_URL: self._open_url,
            ActionId.READ_TEXT_FILE: self._read_text_file,
            ActionId.CREATE_NOTE: self._create_note,
            ActionId.REPORT_SYSTEM_INFO: self._report_system_info,
        }
        handler = handlers.get(request.action)
        if not handler:
            return ActionResult(
                success=False,
                action=str(request.action),
                message="Action not on allowlist",
                permission_denied=True,
            )

        try:
            result = handler(request)
        except ValidationError as exc:
            result = ActionResult(
                success=False,
                action=request.action.value,
                message=f"Input validation failed: {exc}",
            )
        except Exception as exc:
            logger.exception("Action failed: %s", request.action)
            result = ActionResult(
                success=False,
                action=request.action.value,
                message=f"Action error: {exc}",
            )

        result.dry_run = request.dry_run
        result.audit_id = self._audit(request, result)
        return result

    def execute_from_intent(
        self,
        *,
        action: str | None,
        target: str | None = None,
        query: str | None = None,
        memory_content: str | None = None,
        confirm: bool = False,
        dry_run: bool = False,
        source: str = "intent",
    ) -> ActionResult:
        """Map validated intent fields → ActionRequest. Still requires permissions + confirm."""
        if not action or action == "none":
            return ActionResult(success=False, action="none", message="No executable action")
        try:
            aid = ActionId(action)
        except ValueError:
            return ActionResult(
                success=False,
                action=str(action),
                message="Action not allowlisted",
                permission_denied=True,
            )

        params: dict[str, Any] = {"confirm": confirm}
        if aid == ActionId.OPEN_APPLICATION:
            params["target"] = target or ""
        elif aid == ActionId.OPEN_URL:
            params["url"] = target or query or ""
        elif aid == ActionId.READ_TEXT_FILE:
            params["path"] = target or ""
        elif aid == ActionId.CREATE_NOTE:
            params["title"] = (target or "note")[:80]
            params["content"] = memory_content or query or ""
        elif aid == ActionId.REPORT_SYSTEM_INFO:
            pass

        return self.execute(
            ActionRequest(action=aid, params=params, dry_run=dry_run, source=source)
        )

    # ------------------------------------------------------------------ tools

    def _open_application(self, request: ActionRequest) -> ActionResult:
        inp = OpenApplicationInput.model_validate(request.params)
        target = inp.target.value

        perm = self.permissions.is_allowed(PermissionCategory.APP_LAUNCH, target=target)
        if not perm.ok:
            # Also require app consent category explicitly in message
            consent = self.permissions.config.application_launch_actions.granted
            return ActionResult(
                success=False,
                action=ActionId.OPEN_APPLICATION.value,
                message=(
                    f"Permission denied for launching {target}: {perm.detail}. "
                    f"App consent={consent}. Grant application_launch_actions and allowlist the app."
                ),
                permission_denied=True,
                data={"target": target},
            )

        cmdline = APP_LAUNCH_MAP.get(target)
        if not cmdline:
            return ActionResult(
                success=False,
                action=ActionId.OPEN_APPLICATION.value,
                message=f"No launch mapping for {target}",
                permission_denied=True,
            )

        if request.dry_run:
            return ActionResult(
                success=True,
                action=ActionId.OPEN_APPLICATION.value,
                message=f"Dry-run: would launch {target}",
                data={"cmdline": cmdline, "target": target},
                dry_run=True,
            )

        self._spawn(cmdline)
        return ActionResult(
            success=True,
            action=ActionId.OPEN_APPLICATION.value,
            message=f"Launched {target}",
            data={"target": target},
        )

    def _open_url(self, request: ActionRequest) -> ActionResult:
        inp = OpenUrlInput.model_validate(request.params)
        parsed = urlparse(inp.url)
        host = (parsed.hostname or "").lower()
        if not host:
            return ActionResult(
                success=False,
                action=ActionId.OPEN_URL.value,
                message="URL host missing",
            )

        perm = self.permissions.is_allowed(PermissionCategory.BROWSER_OPEN, target=inp.url)
        if not perm.ok:
            return ActionResult(
                success=False,
                action=ActionId.OPEN_URL.value,
                message=f"Permission denied: {perm.detail}",
                permission_denied=True,
                data={"host": host},
            )

        if not inp.confirm:
            return ActionResult(
                success=False,
                action=ActionId.OPEN_URL.value,
                message="Opening a URL requires confirm=true",
                requires_confirmation=True,
                data={"url": inp.url, "host": host},
            )

        if request.dry_run:
            return ActionResult(
                success=True,
                action=ActionId.OPEN_URL.value,
                message=f"Dry-run: would open {inp.url}",
                data={"url": inp.url},
                dry_run=True,
            )

        # Use os.startfile / webbrowser — no shell interpolation of URL into cmd with unchecked args
        import webbrowser

        webbrowser.open(inp.url, new=2)
        return ActionResult(
            success=True,
            action=ActionId.OPEN_URL.value,
            message=f"Opened browser URL for host {host}",
            data={"host": host},
        )

    def _read_text_file(self, request: ActionRequest) -> ActionResult:
        inp = ReadTextFileInput.model_validate(request.params)
        path = Path(inp.path).expanduser()
        try:
            path = path.resolve()
        except OSError as exc:
            return ActionResult(
                success=False,
                action=ActionId.READ_TEXT_FILE.value,
                message=f"Invalid path: {exc}",
            )

        perm = self.permissions.is_allowed(PermissionCategory.USER_FOLDERS, target=str(path))
        # Also allow files under RA-ONE home via APP_FILES
        if not perm.ok:
            home_ok = self.permissions.is_allowed(PermissionCategory.APP_FILES)
            try:
                path.relative_to(self.home.resolve())
                in_home = True
            except ValueError:
                in_home = False
            if not (home_ok.ok and in_home):
                return ActionResult(
                    success=False,
                    action=ActionId.READ_TEXT_FILE.value,
                    message=f"Permission denied: {perm.detail}",
                    permission_denied=True,
                    data={"path": str(path)},
                )

        if not path.is_file():
            return ActionResult(
                success=False,
                action=ActionId.READ_TEXT_FILE.value,
                message="File not found",
                data={"path": str(path)},
            )
        if path.suffix.lower() not in {".txt", ".md", ".log", ".json", ".csv"}:
            return ActionResult(
                success=False,
                action=ActionId.READ_TEXT_FILE.value,
                message="Only .txt/.md/.log/.json/.csv files may be read",
                data={"path": str(path)},
            )

        if request.dry_run:
            return ActionResult(
                success=True,
                action=ActionId.READ_TEXT_FILE.value,
                message="Dry-run: would read file",
                data={"path": str(path)},
                dry_run=True,
            )

        data = path.read_bytes()[: inp.max_bytes]
        # Do not execute file contents — return as text only
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("utf-8", errors="replace")

        # Strip control chars that could confuse downstream consumers
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
        return ActionResult(
            success=True,
            action=ActionId.READ_TEXT_FILE.value,
            message=f"Read {len(text)} characters (not executed)",
            data={
                "path": str(path),
                "content": text,
                "truncated": len(path.read_bytes()) > inp.max_bytes if path.exists() else False,
                "executable_content": False,
            },
        )

    def _create_note(self, request: ActionRequest) -> ActionResult:
        inp = CreateNoteInput.model_validate(request.params)
        storage = self.permissions.is_allowed(PermissionCategory.APP_FILES)
        if not storage.ok:
            return ActionResult(
                success=False,
                action=ActionId.CREATE_NOTE.value,
                message=f"Permission denied: {storage.detail}",
                permission_denied=True,
            )
        if not inp.confirm:
            return ActionResult(
                success=False,
                action=ActionId.CREATE_NOTE.value,
                message="Creating a note requires confirm=true",
                requires_confirmation=True,
                data={"title": inp.title, "preview": inp.content[:120]},
            )

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe = re.sub(r"[^\w\-]+", "_", inp.title).strip("_")[:60] or "note"
        path = self.notes_dir / f"{stamp}_{safe}.txt"

        if request.dry_run:
            return ActionResult(
                success=True,
                action=ActionId.CREATE_NOTE.value,
                message="Dry-run: would create note",
                data={"path": str(path)},
                dry_run=True,
            )

        # Write only into RA-ONE notes directory
        path.write_text(inp.content, encoding="utf-8")
        return ActionResult(
            success=True,
            action=ActionId.CREATE_NOTE.value,
            message="Note saved inside RA-ONE data directory",
            data={"path": str(path)},
        )

    def _report_system_info(self, request: ActionRequest) -> ActionResult:
        ReportSystemInfoInput.model_validate(request.params or {})
        # Read-only info — no special permission beyond existing process
        info = {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "python": platform.python_version(),
            "elevated": self.permissions.is_process_elevated(),
            "raone_home": str(self.home),
        }
        try:
            import psutil  # optional

            vm = psutil.virtual_memory()
            info["ram_total_gb"] = round(vm.total / (1024**3), 2)
            info["ram_available_gb"] = round(vm.available / (1024**3), 2)
            info["cpu_percent"] = psutil.cpu_percent(interval=0.1)
        except Exception:
            info["ram_total_gb"] = None
            info["cpu_percent"] = None

        if request.dry_run:
            return ActionResult(
                success=True,
                action=ActionId.REPORT_SYSTEM_INFO.value,
                message="Dry-run: would report system info",
                data=info,
                dry_run=True,
            )
        return ActionResult(
            success=True,
            action=ActionId.REPORT_SYSTEM_INFO.value,
            message="System information collected",
            data=info,
        )

    # ------------------------------------------------------------------ helpers

    def _spawn(self, cmdline: list[str]) -> None:
        """Launch allowlisted process without shell=True (except the fixed settings/browser starters)."""
        if os.name == "nt" and cmdline[0].lower() in {"calc.exe", "notepad.exe", "explorer.exe"}:
            subprocess.Popen(cmdline, shell=False, close_fds=True)
            return
        # Fixed cmd.exe /c start patterns from APP_LAUNCH_MAP only
        subprocess.Popen(cmdline, shell=False, close_fds=True)

    def _audit(self, request: ActionRequest, result: ActionResult) -> str:
        audit_id = str(uuid.uuid4())
        entry = {
            "id": audit_id,
            "ts": _utc_now(),
            "source": request.source,
            "action": request.action.value,
            "params_redacted": _redact_params(request.params),
            "dry_run": request.dry_run,
            "success": result.success,
            "message": result.message,
            "permission_denied": result.permission_denied,
            "requires_confirmation": result.requires_confirmation,
        }
        try:
            with self.audit_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as exc:
            logger.warning("Audit log write failed: %s", exc)
        return audit_id

    def recent_audit(self, limit: int = 20) -> list[dict[str, Any]]:
        if not self.audit_path.exists():
            return []
        lines = self.audit_path.read_text(encoding="utf-8").splitlines()
        out: list[dict[str, Any]] = []
        for line in lines[-max(1, limit) :]:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out


def _redact_params(params: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(params or {})
    if "content" in redacted and isinstance(redacted["content"], str):
        redacted["content"] = redacted["content"][:80] + ("…" if len(redacted["content"]) > 80 else "")
    return redacted


@lru_cache
def get_action_executor() -> ActionExecutor:
    return ActionExecutor()
