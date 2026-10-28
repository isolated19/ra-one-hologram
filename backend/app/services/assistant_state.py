"""In-memory assistant state store with validated transitions."""

from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock

from app.core.logging import get_logger
from app.models.schemas import ASSISTANT_STATES, AssistantState, AssistantStateEvent

logger = get_logger(__name__)


class InvalidAssistantStateError(ValueError):
    """Raised when a requested state is not in the supported set."""


class AssistantStateService:
    """Single source of truth for assistant mode (Module 1)."""

    def __init__(self, initial: AssistantState = "idle") -> None:
        if initial not in ASSISTANT_STATES:
            raise InvalidAssistantStateError(f"Invalid initial state: {initial}")
        self._lock = Lock()
        self._state: AssistantState = initial
        self._previous: AssistantState | None = None
        self._updated_at = datetime.now(timezone.utc)

    @property
    def state(self) -> AssistantState:
        with self._lock:
            return self._state

    @property
    def previous_state(self) -> AssistantState | None:
        with self._lock:
            return self._previous

    @property
    def updated_at(self) -> datetime:
        with self._lock:
            return self._updated_at

    def get_status(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "previous_state": self._previous,
                "updated_at": self._updated_at,
            }

    def snapshot_event(self, *, source: str = "ws.sync") -> AssistantStateEvent:
        """Current state as a WebSocket event without mutating."""
        with self._lock:
            return AssistantStateEvent(
                state=self._state,
                previous_state=self._previous,
                timestamp=self._updated_at,
                source=source,
            )

    def set_state(
        self,
        new_state: str,
        *,
        source: str = "api",
    ) -> AssistantStateEvent:
        if new_state not in ASSISTANT_STATES:
            raise InvalidAssistantStateError(
                f"Invalid assistant state '{new_state}'. "
                f"Allowed: {', '.join(ASSISTANT_STATES)}"
            )

        with self._lock:
            previous = self._state
            changed = new_state != previous
            if changed:
                self._previous = previous
                self._state = new_state  # type: ignore[assignment]
                self._updated_at = datetime.now(timezone.utc)
            event = AssistantStateEvent(
                state=self._state,
                previous_state=previous if changed else self._previous,
                timestamp=self._updated_at,
                source=source,
            )

        if changed:
            logger.info(
                "Assistant state %s -> %s (source=%s)",
                previous,
                new_state,
                source,
            )
        return event


# Process-wide singleton used by API + WebSocket layers
assistant_state_service = AssistantStateService()
