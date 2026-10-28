"""
Windows Permission Manager for RA-ONE (Module 1).

- Least privilege by default
- Local config stores *app* consent only — never substitutes for OS checks
- Never disables UAC / AV / firewall
- Never bypasses consent dialogs
- Does not keep the assistant elevated; admin ops require explicit Windows elevation
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.core.paths import raone_home
from app.permissions.categories import (
    CATEGORY_LABELS,
    PermissionCategory,
)

logger = get_logger(__name__)

CONFIG_VERSION = 1


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_raone_home() -> Path:
    """Persistent RA-ONE data root under the user profile (not Program Files)."""
    return raone_home()


@dataclass
class CategoryConsent:
    """App-level consent. OS checks remain mandatory at use time."""

    granted: bool = False
    granted_at: str | None = None
    notes: str = ""


@dataclass
class PermissionConfig:
    version: int = CONFIG_VERSION
    updated_at: str = field(default_factory=_utc_now)
    # App consent flags (defaults: deny)
    microphone: CategoryConsent = field(default_factory=CategoryConsent)
    local_voice_playback: CategoryConsent = field(default_factory=CategoryConsent)
    raone_application_files: CategoryConsent = field(
        default_factory=lambda: CategoryConsent(granted=True, granted_at=_utc_now(), notes="Own data directory")
    )
    selected_user_folders: CategoryConsent = field(default_factory=CategoryConsent)
    browser_opening_actions: CategoryConsent = field(default_factory=CategoryConsent)
    application_launch_actions: CategoryConsent = field(default_factory=CategoryConsent)
    administrator_required_operations: CategoryConsent = field(default_factory=CategoryConsent)
    # Explicit allowlists (empty = nothing allowed beyond built-in deny)
    allowed_user_folders: list[str] = field(default_factory=list)
    allowed_browser_hosts: list[str] = field(default_factory=list)
    allowed_applications: list[str] = field(default_factory=list)

    def consent_for(self, category: PermissionCategory) -> CategoryConsent:
        mapping = {
            PermissionCategory.MICROPHONE: self.microphone,
            PermissionCategory.LOCAL_VOICE_PLAYBACK: self.local_voice_playback,
            PermissionCategory.APP_FILES: self.raone_application_files,
            PermissionCategory.USER_FOLDERS: self.selected_user_folders,
            PermissionCategory.BROWSER_OPEN: self.browser_opening_actions,
            PermissionCategory.APP_LAUNCH: self.application_launch_actions,
            PermissionCategory.ADMIN_OPS: self.administrator_required_operations,
        }
        return mapping[category]

    def set_consent(self, category: PermissionCategory, granted: bool, notes: str = "") -> None:
        c = self.consent_for(category)
        c.granted = bool(granted)
        c.granted_at = _utc_now() if granted else None
        if notes:
            c.notes = notes
        self.updated_at = _utc_now()

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "updated_at": self.updated_at,
            "microphone": asdict(self.microphone),
            "local_voice_playback": asdict(self.local_voice_playback),
            "raone_application_files": asdict(self.raone_application_files),
            "selected_user_folders": asdict(self.selected_user_folders),
            "browser_opening_actions": asdict(self.browser_opening_actions),
            "application_launch_actions": asdict(self.application_launch_actions),
            "administrator_required_operations": asdict(self.administrator_required_operations),
            "allowed_user_folders": list(self.allowed_user_folders),
            "allowed_browser_hosts": list(self.allowed_browser_hosts),
            "allowed_applications": list(self.allowed_applications),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PermissionConfig:
        def _c(key: str, default_granted: bool = False) -> CategoryConsent:
            raw = data.get(key) or {}
            if not isinstance(raw, dict):
                raw = {}
            return CategoryConsent(
                granted=bool(raw.get("granted", default_granted)),
                granted_at=raw.get("granted_at"),
                notes=str(raw.get("notes") or ""),
            )

        return cls(
            version=int(data.get("version") or CONFIG_VERSION),
            updated_at=str(data.get("updated_at") or _utc_now()),
            microphone=_c("microphone"),
            local_voice_playback=_c("local_voice_playback"),
            raone_application_files=_c("raone_application_files", default_granted=True),
            selected_user_folders=_c("selected_user_folders"),
            browser_opening_actions=_c("browser_opening_actions"),
            application_launch_actions=_c("application_launch_actions"),
            administrator_required_operations=_c("administrator_required_operations"),
            allowed_user_folders=[str(p) for p in data.get("allowed_user_folders") or []],
            allowed_browser_hosts=[str(h).lower() for h in data.get("allowed_browser_hosts") or []],
            allowed_applications=[str(a).lower() for a in data.get("allowed_applications") or []],
        )


@dataclass
class OsCheckResult:
    ok: bool
    detail: str
    evidence: dict[str, Any] = field(default_factory=dict)


class PermissionManager:
    """
    Checks Windows / process capabilities and stores RA-ONE app consent.

    Important: `is_allowed()` requires BOTH app consent AND a fresh OS check
    where applicable. A JSON flag alone never authorizes hardware or admin ops.
    """

    def __init__(self, home: Path | None = None, config_path: Path | None = None) -> None:
        self.home = Path(home) if home else default_raone_home()
        self.data_dir = self.home / "data"
        self.logs_dir = self.home / "logs"
        self.models_dir = self.home / "models"
        self.exports_dir = self.home / "exports"
        self.config_path = Path(config_path) if config_path else (self.data_dir / "permissions.json")
        self._ensure_dirs()
        self.config = self.load_config()

    def _ensure_dirs(self) -> None:
        for d in (self.data_dir, self.logs_dir, self.models_dir, self.exports_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ config

    def load_config(self) -> PermissionConfig:
        if not self.config_path.exists():
            cfg = PermissionConfig()
            self.save_config(cfg)
            return cfg
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            return PermissionConfig.from_dict(raw if isinstance(raw, dict) else {})
        except Exception as exc:
            logger.warning("Corrupt permissions.json (%s); resetting to defaults", exc)
            cfg = PermissionConfig()
            self.save_config(cfg)
            return cfg

    def save_config(self, cfg: PermissionConfig | None = None) -> Path:
        cfg = cfg or self.config
        cfg.updated_at = _utc_now()
        self.config = cfg
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.config_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cfg.to_dict(), indent=2), encoding="utf-8")
        tmp.replace(self.config_path)
        return self.config_path

    def reload(self) -> PermissionConfig:
        self.config = self.load_config()
        return self.config

    # ------------------------------------------------------------------ OS checks

    def is_process_elevated(self) -> bool:
        """True if the current process runs with admin token (UAC elevated)."""
        if sys.platform != "win32":
            return os.geteuid() == 0  # type: ignore[attr-defined]
        try:
            import ctypes

            return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
        except Exception:
            return False

    def check_microphone_os(self) -> OsCheckResult:
        """
        Best-effort OS microphone privacy / device presence.
        Browser getUserMedia is still required for the Three.js frontend.
        """
        evidence: dict[str, Any] = {"platform": sys.platform}
        if sys.platform != "win32":
            return OsCheckResult(True, "Non-Windows: defer to browser/OS mic APIs", evidence)

        # CapabilityAccessManager consent store (user-level)
        privacy = self._read_mic_privacy_value()
        evidence["windows_mic_privacy"] = privacy
        if privacy == "Deny":
            return OsCheckResult(
                False,
                "Windows microphone privacy is Deny. Open settings and allow access.",
                evidence,
            )

        devices = self._list_audio_input_names()
        evidence["input_devices"] = devices
        if devices is not None and len(devices) == 0:
            return OsCheckResult(False, "No audio input devices detected.", evidence)

        detail = "Microphone privacy allows access"
        if privacy == "Allow":
            detail += " (Allow)"
        elif privacy is None:
            detail += " (privacy value unavailable — verify in Settings)"
        if devices:
            detail += f"; {len(devices)} input device(s) seen"
        return OsCheckResult(True, detail, evidence)

    def _read_mic_privacy_value(self) -> str | None:
        if sys.platform != "win32":
            return None
        try:
            import winreg

            key_path = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                value, _ = winreg.QueryValueEx(key, "Value")
                return str(value)
        except OSError:
            return None

    def _list_audio_input_names(self) -> list[str] | None:
        """Optional enumeration; returns None if tooling unavailable."""
        try:
            import sounddevice  # type: ignore

            names: list[str] = []
            for i, d in enumerate(sounddevice.query_devices()):
                if int(d.get("max_input_channels") or 0) > 0:
                    names.append(str(d.get("name") or f"input-{i}"))
            return names
        except Exception:
            pass
        # Fallback: PowerShell PnP audio endpoints (best-effort, no elevation)
        if sys.platform != "win32":
            return None
        try:
            ps = (
                "Get-PnpDevice -Class AudioEndpoint -Status OK -ErrorAction SilentlyContinue "
                "| Select-Object -ExpandProperty FriendlyName"
            )
            completed = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            if completed.returncode != 0:
                return None
            lines = [ln.strip() for ln in completed.stdout.splitlines() if ln.strip()]
            return lines
        except Exception:
            return None

    def check_app_storage(self) -> OsCheckResult:
        """Verify RA-ONE can create/read/write under its data directory."""
        evidence = {"home": str(self.home), "data_dir": str(self.data_dir)}
        try:
            self._ensure_dirs()
            probe = self.data_dir / ".raone_write_probe"
            probe.write_text("ok", encoding="utf-8")
            text = probe.read_text(encoding="utf-8")
            probe.unlink(missing_ok=True)
            if text != "ok":
                return OsCheckResult(False, "Write probe mismatch", evidence)
            return OsCheckResult(True, "RA-ONE application directory is writable", evidence)
        except OSError as exc:
            return OsCheckResult(False, f"Storage check failed: {exc}", evidence)

    def check_voice_playback(self) -> OsCheckResult:
        """Local TTS playback does not need special Windows privacy toggles."""
        return OsCheckResult(
            True,
            "Local audio playback uses standard user-mode APIs (no elevation).",
            {"elevated": self.is_process_elevated()},
        )

    # ------------------------------------------------------------------ settings helpers

    def open_microphone_settings(self) -> OsCheckResult:
        """Open Windows microphone privacy settings (user must enable access)."""
        if sys.platform != "win32":
            return OsCheckResult(False, "Microphone settings UI is Windows-only", {})
        try:
            # ms-settings URI — does not grant access; user decides
            subprocess.Popen(["cmd", "/c", "start", "", "ms-settings:privacy-microphone"], shell=False)
            return OsCheckResult(True, "Opened Windows microphone privacy settings", {})
        except OSError as exc:
            return OsCheckResult(False, f"Could not open settings: {exc}", {})

    def open_general_privacy_settings(self) -> OsCheckResult:
        if sys.platform != "win32":
            return OsCheckResult(False, "Privacy settings UI is Windows-only", {})
        try:
            subprocess.Popen(["cmd", "/c", "start", "", "ms-settings:privacy"], shell=False)
            return OsCheckResult(True, "Opened Windows privacy settings", {})
        except OSError as exc:
            return OsCheckResult(False, f"Could not open settings: {exc}", {})

    # ------------------------------------------------------------------ consent API

    def grant(self, category: PermissionCategory, notes: str = "") -> PermissionConfig:
        self.config.set_consent(category, True, notes=notes)
        self.save_config()
        logger.info("App consent granted: %s", category.value)
        return self.config

    def revoke(self, category: PermissionCategory) -> PermissionConfig:
        self.config.set_consent(category, False)
        # Clear related allowlists when revoking
        if category == PermissionCategory.USER_FOLDERS:
            self.config.allowed_user_folders = []
        if category == PermissionCategory.BROWSER_OPEN:
            self.config.allowed_browser_hosts = []
        if category == PermissionCategory.APP_LAUNCH:
            self.config.allowed_applications = []
        self.save_config()
        logger.info("App consent revoked: %s", category.value)
        return self.config

    def set_allowed_user_folders(self, paths: list[str]) -> PermissionConfig:
        cleaned: list[str] = []
        for p in paths:
            resolved = str(Path(p).expanduser().resolve())
            if resolved not in cleaned:
                cleaned.append(resolved)
        self.config.allowed_user_folders = cleaned
        if cleaned and not self.config.selected_user_folders.granted:
            self.config.set_consent(PermissionCategory.USER_FOLDERS, True, notes="folders updated")
        self.save_config()
        return self.config

    def set_allowed_browser_hosts(self, hosts: list[str]) -> PermissionConfig:
        self.config.allowed_browser_hosts = sorted({h.strip().lower() for h in hosts if h.strip()})
        if self.config.allowed_browser_hosts and not self.config.browser_opening_actions.granted:
            self.config.set_consent(PermissionCategory.BROWSER_OPEN, True)
        self.save_config()
        return self.config

    def set_allowed_applications(self, apps: list[str]) -> PermissionConfig:
        self.config.allowed_applications = sorted({a.strip().lower() for a in apps if a.strip()})
        if self.config.allowed_applications and not self.config.application_launch_actions.granted:
            self.config.set_consent(PermissionCategory.APP_LAUNCH, True)
        self.save_config()
        return self.config

    # ------------------------------------------------------------------ authorization

    def is_allowed(self, category: PermissionCategory, *, target: str | None = None) -> OsCheckResult:
        """
        Combined gate: app consent + OS/path checks.
        Config alone is never sufficient for microphone or admin ops.
        """
        consent = self.config.consent_for(category)
        if not consent.granted:
            return OsCheckResult(False, f"App consent denied for {category.value}", {"consent": False})

        if category == PermissionCategory.MICROPHONE:
            os_check = self.check_microphone_os()
            if not os_check.ok:
                return OsCheckResult(
                    False,
                    f"App consent present but OS microphone check failed: {os_check.detail}",
                    {"consent": True, **os_check.evidence},
                )
            return OsCheckResult(True, "Microphone allowed (consent + OS)", {"consent": True, **os_check.evidence})

        if category == PermissionCategory.LOCAL_VOICE_PLAYBACK:
            return self.check_voice_playback()

        if category == PermissionCategory.APP_FILES:
            return self.check_app_storage()

        if category == PermissionCategory.USER_FOLDERS:
            if not target:
                return OsCheckResult(False, "User folder target required", {"consent": True})
            return self._folder_allowed(target)

        if category == PermissionCategory.BROWSER_OPEN:
            if not target:
                return OsCheckResult(False, "Browser host/URL required", {"consent": True})
            return self._browser_host_allowed(target)

        if category == PermissionCategory.APP_LAUNCH:
            if not target:
                return OsCheckResult(False, "Application id required", {"consent": True})
            key = target.strip().lower()
            if key not in self.config.allowed_applications:
                return OsCheckResult(False, f"Application {target!r} not in allowlist", {"consent": True})
            return OsCheckResult(True, f"Application {key} allowlisted", {"consent": True})

        if category == PermissionCategory.ADMIN_OPS:
            # Never treat JSON as elevation. Caller must use Windows elevation UX.
            if self.is_process_elevated():
                return OsCheckResult(
                    True,
                    "Process is elevated — still confirm each admin operation with the user.",
                    {"consent": True, "elevated": True},
                )
            return OsCheckResult(
                False,
                "Admin operation requires Windows elevation (UAC). Config consent is not enough.",
                {"consent": True, "elevated": False},
            )

        return OsCheckResult(False, f"Unknown category {category}", {})

    def _folder_allowed(self, target: str) -> OsCheckResult:
        try:
            path = Path(target).expanduser().resolve()
        except OSError as exc:
            return OsCheckResult(False, f"Invalid path: {exc}", {})
        # Always allow RA-ONE home
        try:
            path.relative_to(self.home.resolve())
            return OsCheckResult(True, "Path is inside RA-ONE home", {"path": str(path)})
        except ValueError:
            pass
        for allowed in self.config.allowed_user_folders:
            try:
                path.relative_to(Path(allowed).resolve())
                return OsCheckResult(True, "Path is under an approved user folder", {"path": str(path), "root": allowed})
            except ValueError:
                continue
        return OsCheckResult(False, "Path is outside approved folders", {"path": str(path)})

    def _browser_host_allowed(self, target: str) -> OsCheckResult:
        from urllib.parse import urlparse

        raw = target.strip()
        if "://" not in raw:
            raw = "https://" + raw
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
        if not host:
            return OsCheckResult(False, "Could not parse host", {"target": target})
        if host in self.config.allowed_browser_hosts:
            return OsCheckResult(True, f"Host {host} allowlisted", {"host": host})
        # Exact suffix match for subdomains of allowlisted roots
        for allowed in self.config.allowed_browser_hosts:
            if host == allowed or host.endswith("." + allowed):
                return OsCheckResult(True, f"Host {host} matches {allowed}", {"host": host})
        return OsCheckResult(False, f"Host {host} not allowlisted", {"host": host})

    def request_admin_operation(self, operation_description: str, command: list[str]) -> OsCheckResult:
        """
        Launch a one-shot elevated process via ShellExecute 'runas' (UAC prompt).
        Does not elevate the main assistant process.
        """
        if not self.config.administrator_required_operations.granted:
            return OsCheckResult(
                False,
                "Administrator-required operations are not approved in RA-ONE settings.",
                {"operation": operation_description},
            )
        if not command:
            return OsCheckResult(False, "Empty command", {})
        if sys.platform != "win32":
            return OsCheckResult(False, "Elevation helper is Windows-only", {})

        logger.info("Requesting UAC elevation for: %s | %s", operation_description, command)
        try:
            import ctypes

            # ShellExecuteW runas shows the standard Windows consent dialog
            exe = command[0]
            params = subprocess.list2cmdline(command[1:]) if len(command) > 1 else ""
            rc = ctypes.windll.shell32.ShellExecuteW(  # type: ignore[attr-defined]
                None,
                "runas",
                exe,
                params,
                None,
                1,
            )
            # Per MSDN, >32 means success
            if int(rc) <= 32:
                return OsCheckResult(
                    False,
                    f"Elevation cancelled or failed (ShellExecute={rc}). Operation: {operation_description}",
                    {"operation": operation_description, "shell_execute": int(rc)},
                )
            return OsCheckResult(
                True,
                f"Elevation prompted for: {operation_description}",
                {"operation": operation_description, "shell_execute": int(rc)},
            )
        except Exception as exc:
            return OsCheckResult(False, f"Elevation failed: {exc}", {"operation": operation_description})

    # ------------------------------------------------------------------ status / audit

    def status_report(self) -> dict[str, Any]:
        """Full snapshot for administration UI / diagnostics."""
        elevated = self.is_process_elevated()
        mic = self.check_microphone_os()
        storage = self.check_app_storage()
        playback = self.check_voice_playback()
        categories = []
        for cat in PermissionCategory:
            consent = self.config.consent_for(cat)
            categories.append(
                {
                    "id": cat.value,
                    "label": CATEGORY_LABELS[cat],
                    "app_consent": consent.granted,
                    "granted_at": consent.granted_at,
                    "notes": consent.notes,
                }
            )
        return {
            "module": "permission_manager",
            "version": CONFIG_VERSION,
            "raone_home": str(self.home),
            "config_path": str(self.config_path),
            "process_elevated": elevated,
            "warning_if_elevated": (
                "Main assistant should not run continuously as Administrator."
                if elevated
                else None
            ),
            "os_checks": {
                "microphone": asdict(mic),
                "app_storage": asdict(storage),
                "local_voice_playback": asdict(playback),
            },
            "categories": categories,
            "allowlists": {
                "user_folders": list(self.config.allowed_user_folders),
                "browser_hosts": list(self.config.allowed_browser_hosts),
                "applications": list(self.config.allowed_applications),
            },
            "updated_at": self.config.updated_at,
            "security_notes": [
                "Local permissions.json is app consent only — not a Windows permission substitute.",
                "Never disable UAC, antivirus, or firewall for RA-ONE.",
                "Browser microphone access still requires a user gesture / site permission.",
                "Admin actions must use Windows UAC prompts, not silent elevation.",
            ],
        }

    def settings_interface(self) -> dict[str, Any]:
        """Shape consumed by a settings UI (Module 10 will reuse)."""
        report = self.status_report()
        return {
            "title": "RA-ONE Permissions",
            "least_privilege": True,
            "categories": report["categories"],
            "allowlists": report["allowlists"],
            "actions": [
                {"id": "open_mic_settings", "label": "Open Windows microphone settings"},
                {"id": "open_privacy_settings", "label": "Open Windows privacy settings"},
                {"id": "grant", "label": "Grant category"},
                {"id": "revoke", "label": "Revoke category"},
                {"id": "refresh", "label": "Re-check OS permissions"},
            ],
            "os_checks": report["os_checks"],
            "process_elevated": report["process_elevated"],
            "security_notes": report["security_notes"],
        }


@lru_cache
def get_permission_manager() -> PermissionManager:
    return PermissionManager()
