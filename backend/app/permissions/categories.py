"""Permission categories — defaults are deny / empty (least privilege)."""

from __future__ import annotations

from enum import Enum


class PermissionCategory(str, Enum):
    MICROPHONE = "microphone"
    LOCAL_VOICE_PLAYBACK = "local_voice_playback"
    APP_FILES = "raone_application_files"
    USER_FOLDERS = "selected_user_folders"
    BROWSER_OPEN = "browser_opening_actions"
    APP_LAUNCH = "application_launch_actions"
    ADMIN_OPS = "administrator_required_operations"


# Human-readable labels for settings UI
CATEGORY_LABELS: dict[PermissionCategory, str] = {
    PermissionCategory.MICROPHONE: "Microphone",
    PermissionCategory.LOCAL_VOICE_PLAYBACK: "Local voice playback",
    PermissionCategory.APP_FILES: "RA-ONE application files",
    PermissionCategory.USER_FOLDERS: "Selected user folders",
    PermissionCategory.BROWSER_OPEN: "Browser-opening actions",
    PermissionCategory.APP_LAUNCH: "Application-launch actions",
    PermissionCategory.ADMIN_OPS: "Administrator-required operations",
}

# Categories that are RA-ONE app consent only (still re-checked against OS where possible)
APP_CONSENT_CATEGORIES = frozenset(PermissionCategory)
