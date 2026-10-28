"""Module 6 — Ollama boot wait (poll until reachable or timeout)."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.llm.ollama_wait import wait_for_ollama


@dataclass
class FakeHealth:
    ollama_reachable: bool
    base_url: str = "http://127.0.0.1:11434"
    selected_model: str = "qwen3:0.6b"
    preferred_installed: bool = False
    fallback_installed: bool = True


class FakeLLM:
    def __init__(self, results: list[FakeHealth]):
        self._results = list(results)
        self.calls = 0

    async def health(self) -> FakeHealth:
        self.calls += 1
        if not self._results:
            return FakeHealth(ollama_reachable=False)
        return self._results.pop(0)


@pytest.mark.asyncio
async def test_wait_returns_immediately_when_already_up():
    llm = FakeLLM([FakeHealth(ollama_reachable=True)])
    health = await wait_for_ollama(llm, interval_sec=0.01, timeout_sec=1.0)
    assert health.ollama_reachable is True
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_wait_polls_until_reachable():
    llm = FakeLLM(
        [
            FakeHealth(ollama_reachable=False),
            FakeHealth(ollama_reachable=False),
            FakeHealth(ollama_reachable=True, preferred_installed=True),
        ]
    )
    health = await wait_for_ollama(llm, interval_sec=0.02, timeout_sec=2.0)
    assert health.ollama_reachable is True
    assert health.preferred_installed is True
    assert llm.calls == 3


@pytest.mark.asyncio
async def test_wait_times_out_still_unreachable():
    llm = FakeLLM(
        [
            FakeHealth(ollama_reachable=False),
            FakeHealth(ollama_reachable=False),
            FakeHealth(ollama_reachable=False),
            FakeHealth(ollama_reachable=False),
        ]
    )
    health = await wait_for_ollama(llm, interval_sec=0.02, timeout_sec=0.05)
    assert health.ollama_reachable is False
    assert llm.calls >= 1
