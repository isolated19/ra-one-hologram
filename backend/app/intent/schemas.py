"""Structured intent schema — validated before any downstream use."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class IntentType(str, Enum):
    GENERAL_QUESTION = "general_question"
    CONVERSATION = "conversation"
    COMPUTER_ACTION = "computer_action"
    MEMORY_REQUEST = "memory_request"
    REMEMBER_INFORMATION = "remember_information"
    RETRIEVE_INFORMATION = "retrieve_information"
    SLEEP_COMMAND = "sleep_command"
    WAKE_COMMAND = "wake_command"
    UNKNOWN = "unknown"


# Only these action ids may leave the analyzer for Module 4.
# Arbitrary LLM-invented shell/commands are rejected.
ALLOWED_ACTIONS = frozenset(
    {
        "open_application",
        "open_url",
        "read_text_file",
        "create_note",
        "report_system_info",
        "none",
    }
)

# Canonical app targets for open_application (Module 4 will map to real binaries)
ALLOWED_APP_TARGETS = frozenset(
    {
        "calculator",
        "notepad",
        "browser",
        "settings",
        "explorer",
    }
)


class IntentResult(BaseModel):
    """Classifier output. Intent is NOT authorization to act."""

    intent: IntentType = IntentType.UNKNOWN
    action: str | None = None
    target: str | None = None
    query: str | None = None
    memory_content: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    cleaned_text: str = ""
    remainder: str = ""
    wake_matched: bool = False
    sleep_matched: bool = False
    source: str = "rules"  # rules | llm | hybrid
    # Explicit: analyzer never grants permission
    authorized: bool = False
    executable: bool = False
    notes: str = ""
    raw_text: str = ""

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        key = str(v).strip().lower()
        if key not in ALLOWED_ACTIONS:
            return None  # drop unsafe / unknown actions
        return key

    @field_validator("target")
    @classmethod
    def normalize_target(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        return str(v).strip().lower()[:200]

    def to_public_dict(self) -> dict[str, Any]:
        d = self.model_dump()
        # Always reinforce safety flags in API responses
        d["authorized"] = False
        d["executable"] = False
        d["authorization_note"] = (
            "Recognized intent is not authorization. "
            "Only Module 4 ActionExecutor may run allowlisted actions after permission checks."
        )
        return d


class LLMIntentDraft(BaseModel):
    """Strict subset expected from the LLM JSON response."""

    intent: IntentType
    action: str | None = None
    target: str | None = None
    query: str | None = None
    memory_content: str | None = None
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
