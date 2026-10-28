"""Module 1 — Windows permission manager (least privilege, no UAC bypass)."""

from .PermissionManager import PermissionManager, get_permission_manager

__all__ = ["PermissionManager", "get_permission_manager"]
