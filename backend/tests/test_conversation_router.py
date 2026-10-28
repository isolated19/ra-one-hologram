"""Conversation router prefers real LLM; mock only when explicitly allowed."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.conversation.AssistantResponseRouter import AssistantResponseRouter
from app.intent.IntentAnalyzer import IntentAnalyzer
from app.intent.schemas import IntentResult, IntentType


@dataclass
class FakeGen:
    success: bool
    text: str = ""
    error: str = ""
    model: str = "qwen3:1.7b"
    latency_ms: float = 10.0
    prompt_tokens: int = 1
    eval_tokens: int = 1
    request_id: str = "x"


class FakeLLM:
    def __init__(self, reachable=True, installed=True):
        self.reachable = reachable
        self.installed = installed

    async def health(self):
        from app.llm.LocalLLMService import LLMHealth

        return LLMHealth(
            ollama_reachable=self.reachable,
            base_url="http://127.0.0.1:11434",
            preferred_installed=self.installed,
            fallback_installed=self.installed,
            selected_model="qwen3:1.7b",
            installed_models=["qwen3:1.7b"] if self.installed else [],
            detail="ok" if self.reachable else "down",
            catalog={},
        )

    async def chat(self, text, history=None, **kwargs):
        return FakeGen(success=True, text=f"Answer about: {text[:40]}")


@pytest.mark.asyncio
async def test_router_uses_llm_for_questions():
    router = AssistantResponseRouter(
        FakeLLM(),
        IntentAnalyzer(use_llm=False),
        allow_mock=False,
    )
    result = await router.route("What is artificial intelligence?")
    assert result.success
    assert result.source == "llm"
    assert result.simulated is False
    assert "Answer about" in result.text


@pytest.mark.asyncio
async def test_router_errors_when_ollama_down():
    router = AssistantResponseRouter(
        FakeLLM(reachable=False),
        IntentAnalyzer(use_llm=False),
    )
    result = await router.route("What is Python?")
    assert result.success is False
    assert result.source == "error"
    assert "Ollama" in (result.error or "")
