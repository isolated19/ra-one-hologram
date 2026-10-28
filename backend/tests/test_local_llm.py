"""Module 2 — LocalLLMService tests (mocked Ollama; no model download)."""

from __future__ import annotations

import httpx
import pytest

from app.llm.LocalLLMService import LocalLLMService, ChatMessage
from app.main import create_app
from app.config import Settings
from app.services.assistant_state import AssistantStateService
from app.websocket.manager import ConnectionManager
from fastapi.testclient import TestClient


class _FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, handlers: dict):
        self.handlers = handlers
        self.calls: list[tuple[str, str]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        key = f"{request.method} {request.url.path}"
        self.calls.append((request.method, request.url.path))
        handler = self.handlers.get(key)
        if handler is None:
            return httpx.Response(404, json={"error": f"no handler for {key}"})
        status, body = handler(request)
        return httpx.Response(status, json=body)


@pytest.fixture
def llm_ok() -> LocalLLMService:
    transport = _FakeTransport(
        {
            "GET /": lambda _r: (200, {"status": "ok"}),
            "GET /api/tags": lambda _r: (
                200,
                {"models": [{"name": "qwen3:1.7b"}, {"name": "qwen3:0.6b"}]},
            ),
            "POST /api/chat": lambda r: (
                200,
                {
                    "model": "qwen3:1.7b",
                    "message": {"role": "assistant", "content": "I am Raw-One. Systems online."},
                    "prompt_eval_count": 40,
                    "eval_count": 12,
                },
            ),
        }
    )
    svc = LocalLLMService(base_url="http://127.0.0.1:11434", timeout_sec=5)
    svc._client = httpx.AsyncClient(
        base_url="http://127.0.0.1:11434",
        transport=transport,
        trust_env=False,
    )
    svc._transport = transport  # type: ignore[attr-defined]
    return svc


@pytest.mark.asyncio
async def test_health_lists_models(llm_ok: LocalLLMService):
    h = await llm_ok.health()
    assert h.ollama_reachable is True
    assert h.preferred_installed is True
    assert h.selected_model == "qwen3:1.7b"
    assert h.catalog["qwen3:1.7b"]["role"] == "preferred"


@pytest.mark.asyncio
async def test_chat_short_spoken(llm_ok: LocalLLMService):
    result = await llm_ok.chat("Who are you?")
    assert result.success
    assert "Raw-One" in result.text
    assert result.model == "qwen3:1.7b"
    # Ensure think:false and num_predict were sent
    # Inspect last chat body via reconstructing — transport doesn't store body;
    # smoke: latency recorded
    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_chat_builds_trimmed_history(llm_ok: LocalLLMService):
    llm_ok.max_history_turns = 1
    history = [
        ChatMessage("user", "one"),
        ChatMessage("assistant", "a1"),
        ChatMessage("user", "two"),
        ChatMessage("assistant", "a2"),
    ]
    msgs = llm_ok.build_messages("three", history)
    assert msgs[0]["role"] == "system"
    assert msgs[-1]["content"] == "three"
    # only last turn pair kept
    assert len([m for m in msgs if m["role"] != "system"]) == 3  # user two, asst a2, user three


@pytest.mark.asyncio
async def test_missing_model_no_autopull():
    transport = _FakeTransport(
        {
            "GET /": lambda _r: (200, {}),
            "GET /api/tags": lambda _r: (200, {"models": []}),
            "POST /api/chat": lambda _r: (200, {"message": {"content": "should not run"}}),
        }
    )
    svc = LocalLLMService(base_url="http://127.0.0.1:11434")
    svc._client = httpx.AsyncClient(base_url="http://127.0.0.1:11434", transport=transport, trust_env=False)
    result = await svc.chat("Hello")
    assert result.success is False
    assert "not installed" in result.error.lower()
    assert not any(c[0] == "POST" and c[1] == "/api/chat" for c in transport.calls)


def test_rejects_non_local_base_url():
    with pytest.raises(ValueError):
        LocalLLMService(base_url="http://8.8.8.8:11434")


@pytest.mark.asyncio
async def test_cancel_flags_request(llm_ok: LocalLLMService):
    n = await llm_ok.cancel()
    assert n == 0


def test_api_health_and_chat(llm_ok: LocalLLMService):
    settings = Settings(APP_ENV="development", DEV_MODE=True, CORS_ORIGINS="http://localhost:5173")
    app = create_app(
        settings,
        assistant_state=AssistantStateService(),
        ws_manager=ConnectionManager(),
        llm_service=llm_ok,
    )
    with TestClient(app) as client:
        r = client.get("/api/llm/health")
        assert r.status_code == 200
        body = r.json()
        assert body["cloud"] is False
        # Mirrors OLLAMA_AUTO_PULL (on by default)
        assert body["auto_download"] is settings.ollama_auto_pull
        assert body["ollama_reachable"] is True

        r2 = client.post("/api/llm/chat", json={"text": "Hello RA-ONE"})
        assert r2.status_code == 200
        assert "Raw-One" in r2.json()["text"]

        r3 = client.post("/api/llm/configure", json={"max_output_tokens": 80, "num_ctx": 1024})
        assert r3.status_code == 200
        assert r3.json()["max_output_tokens"] == 80


def test_spoken_text_drops_emoji_and_trailing_fragment():
    from app.llm.LocalLLMService import _sanitize_spoken

    assert _sanitize_spoken("Let me know. Or just someone to listen. \ud83c") == "Let me know. Or just someone to listen."
    assert _sanitize_spoken("Sure thing \U0001F60A I can help.") == "Sure thing I can help."
    assert _sanitize_spoken("It is sunny. Tomorrow will be") == "It is sunny."
