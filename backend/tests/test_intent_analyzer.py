"""Module 3 — IntentAnalyzer tests (rules + schema; mocked LLM)."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.intent.IntentAnalyzer import IntentAnalyzer, _parse_llm_json
from app.intent.schemas import IntentResult, IntentType
from app.llm.LocalLLMService import LocalLLMService
from app.main import create_app
from app.services.assistant_state import AssistantStateService
from app.websocket.manager import ConnectionManager


@pytest.fixture
def analyzer() -> IntentAnalyzer:
    return IntentAnalyzer(use_llm=False)


def test_open_calculator(analyzer: IntentAnalyzer):
    r = analyzer.analyze_sync_rules_only("Hey RA-ONE, open Calculator.")
    assert r.intent == IntentType.COMPUTER_ACTION
    assert r.action == "open_application"
    assert r.target == "calculator"
    assert r.authorized is False
    assert r.executable is False
    assert r.wake_matched is True


def test_wake_only(analyzer: IntentAnalyzer):
    r = analyzer.analyze_sync_rules_only("Hey RA-ONE")
    assert r.intent == IntentType.WAKE_COMMAND
    assert r.confidence >= 0.9


def test_sleep_command(analyzer: IntentAnalyzer):
    r = analyzer.analyze_sync_rules_only("RA-ONE, go to sleep")
    assert r.intent == IntentType.SLEEP_COMMAND


def test_remember(analyzer: IntentAnalyzer):
    r = analyzer.analyze_sync_rules_only("RA-ONE remember that I prefer short answers")
    assert r.intent == IntentType.REMEMBER_INFORMATION
    assert "short answers" in (r.memory_content or "")


def test_retrieve(analyzer: IntentAnalyzer):
    r = analyzer.analyze_sync_rules_only("what do you remember about me")
    assert r.intent == IntentType.RETRIEVE_INFORMATION


def test_general_question(analyzer: IntentAnalyzer):
    r = analyzer.analyze_sync_rules_only("Hey RA-ONE, what is artificial intelligence?")
    assert r.intent == IntentType.GENERAL_QUESTION
    assert "artificial" in (r.query or r.cleaned_text)


def test_rejects_unsafe_action_in_schema():
    result = IntentResult(
        intent=IntentType.COMPUTER_ACTION,
        action="rm -rf /",  # type: ignore[arg-type]
        target="disk",
    )
    assert result.action is None  # validator drops unsafe actions


def test_parse_llm_json_valid():
    draft = _parse_llm_json(
        '{"intent":"computer_action","action":"open_application","target":"notepad","confidence":0.9}'
    )
    assert draft is not None
    assert draft.intent == IntentType.COMPUTER_ACTION
    assert draft.target == "notepad"


def test_parse_llm_json_invalid():
    assert _parse_llm_json("not json") is None


@pytest.mark.asyncio
async def test_llm_path_with_mock():
    class _T(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "qwen3:1.7b"}]})
            if request.url.path == "/":
                return httpx.Response(200, json={})
            if request.url.path == "/api/chat":
                return httpx.Response(
                    200,
                    json={
                        "model": "qwen3:1.7b",
                        "message": {
                            "role": "assistant",
                            "content": (
                                '{"intent":"computer_action","action":"open_application",'
                                '"target":"calculator","confidence":0.91}'
                            ),
                        },
                    },
                )
            return httpx.Response(404)

    llm = LocalLLMService(base_url="http://127.0.0.1:11434")
    llm._client = httpx.AsyncClient(
        base_url="http://127.0.0.1:11434",
        transport=_T(),
        trust_env=False,
    )
    analyzer = IntentAnalyzer(llm=llm, use_llm=True)
    # Ambiguous text so rules confidence < 0.85 and LLM is used
    result = await analyzer.analyze("please start the calc app for me", force_llm=True)
    assert result.intent == IntentType.COMPUTER_ACTION
    assert result.target == "calculator"
    assert result.source == "llm"
    assert result.authorized is False


@pytest.mark.asyncio
async def test_llm_rejects_unknown_app_target():
    class _T(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path in ("/", "/api/tags"):
                body = {} if request.url.path == "/" else {"models": [{"name": "qwen3:1.7b"}]}
                return httpx.Response(200, json=body)
            return httpx.Response(
                200,
                json={
                    "model": "qwen3:1.7b",
                    "message": {
                        "content": (
                            '{"intent":"computer_action","action":"open_application",'
                            '"target":"powershell","confidence":0.99}'
                        )
                    },
                },
            )

    llm = LocalLLMService(base_url="http://127.0.0.1:11434")
    llm._client = httpx.AsyncClient(base_url="http://127.0.0.1:11434", transport=_T(), trust_env=False)
    analyzer = IntentAnalyzer(llm=llm, use_llm=True)
    result = await analyzer.analyze("open powershell", force_llm=True)
    assert result.intent == IntentType.UNKNOWN
    assert "rejected" in result.notes


def test_api_analyze():
    settings = Settings(APP_ENV="development", DEV_MODE=True, CORS_ORIGINS="http://localhost:5173")
    analyzer = IntentAnalyzer(use_llm=False)
    app = create_app(
        settings,
        assistant_state=AssistantStateService(),
        ws_manager=ConnectionManager(),
        intent_analyzer=analyzer,
    )
    with TestClient(app) as client:
        r = client.get("/api/intent/schema")
        assert r.status_code == 200
        assert "computer_action" in r.json()["intents"]

        r2 = client.post(
            "/api/intent/analyze",
            json={"text": "Hey RA-ONE, open Notepad", "rules_only": True},
        )
        assert r2.status_code == 200
        body = r2.json()
        assert body["intent"] == "computer_action"
        assert body["target"] == "notepad"
        assert body["authorized"] is False
        assert body["executable"] is False
