"""Online lookups (weather / news / facts) and camera-mood context in the router."""

from __future__ import annotations

import httpx
import pytest

from app.conversation.AssistantResponseRouter import AssistantResponseRouter
from app.intent.IntentAnalyzer import IntentAnalyzer
from app.web.WebLookup import WebLookup, classify
from tests.test_conversation_router import FakeGen, FakeLLM

WTTR = {
    "nearest_area": [{"areaName": [{"value": "Pune"}]}],
    "current_condition": [
        {"temp_C": "27", "FeelsLikeC": "29", "weatherDesc": [{"value": "Partly cloudy"}]}
    ],
    "weather": [
        {"maxtempC": "31", "mintempC": "22", "hourly": []},
        {"maxtempC": "30", "mintempC": "21", "hourly": [{}] * 4 + [{"weatherDesc": [{"value": "Light rain"}]}]},
    ],
}
RSS = """<rss><channel>
<item><title>Big launch today - The Daily</title></item>
<item><title>Markets rally - Finance Now</title></item>
<item><title>Rain expected - Weather Desk</title></item>
<item><title>Fourth story - X</title></item>
</channel></rss>"""


def _transport(calls: list[str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        host, path = request.url.host, request.url.path
        if host == "wttr.in":
            return httpx.Response(200, json=WTTR)
        if host == "news.google.com":
            return httpx.Response(200, text=RSS)
        if path.endswith("/search/page"):
            return httpx.Response(200, json={"pages": [{"key": "Ada_Lovelace"}]})
        if "/page/summary/" in path:
            return httpx.Response(
                200,
                json={"extract": "Ada Lovelace was a mathematician. She wrote the first program. Third."},
            )
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.mark.parametrize(
    "text,kind,query",
    [
        ("what's the weather in Pune", "weather", "Pune"),
        ("will it rain tomorrow", "weather", ""),
        ("tell me the latest news", "news", ""),
        ("any news about cricket?", "news", "cricket"),
        ("who is Ada Lovelace", "search", "Ada Lovelace"),
        ("search the web for quantum computing", "search", "quantum computing"),
    ],
)
def test_classify_live_questions(text, kind, query):
    q = classify(text)
    assert q is not None and q.kind == kind and q.query == query


@pytest.mark.parametrize("text", ["what is Python?", "open notepad", "remember my keys are in the car", "hi"])
def test_classify_leaves_local_questions_alone(text):
    assert classify(text) is None


@pytest.mark.asyncio
async def test_weather_answer_is_spoken_directly():
    calls: list[str] = []
    web = WebLookup(transport=_transport(calls))
    ans = await web.answer(classify("what's the weather in Pune"))
    assert ans.direct and "27 degrees" in ans.text and "Pune" in ans.text
    tomorrow = await web.answer(classify("will it rain tomorrow"))
    assert "light rain" in tomorrow.text


@pytest.mark.asyncio
async def test_news_strips_publishers_and_keeps_three():
    web = WebLookup(transport=_transport([]))
    ans = await web.answer(classify("latest news"))
    assert ans.context == ["Big launch today", "Markets rally", "Rain expected"]


@pytest.mark.asyncio
async def test_offline_returns_none():
    def boom(request):
        raise httpx.ConnectError("no internet")

    web = WebLookup(transport=httpx.MockTransport(boom))
    assert await web.answer(classify("what's the weather in Pune")) is None


class RecordingLLM(FakeLLM):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.extra_system = None

    async def chat(self, text, history=None, extra_system=None, **kwargs):
        self.extra_system = extra_system
        return FakeGen(success=True, text="ok")


@pytest.mark.asyncio
async def test_router_answers_weather_from_web():
    router = AssistantResponseRouter(
        FakeLLM(), IntentAnalyzer(use_llm=False), web=WebLookup(transport=_transport([]))
    )
    result = await router.route("what's the weather in Pune")
    assert result.source == "web" and "27 degrees" in result.text


@pytest.mark.asyncio
async def test_router_feeds_facts_to_llm():
    llm = RecordingLLM()
    router = AssistantResponseRouter(llm, IntentAnalyzer(use_llm=False), web=WebLookup(transport=_transport([])))
    result = await router.route("who is Ada Lovelace")
    assert result.source == "llm"
    assert "mathematician" in llm.extra_system


@pytest.mark.asyncio
async def test_router_uses_web_when_ollama_is_down():
    router = AssistantResponseRouter(
        FakeLLM(reachable=False), IntentAnalyzer(use_llm=False), web=WebLookup(transport=_transport([]))
    )
    result = await router.route("who is Ada Lovelace")
    assert result.success and result.source == "web"
    assert result.text.startswith("Ada Lovelace was a mathematician.")


@pytest.mark.asyncio
async def test_router_passes_camera_mood_to_llm():
    llm = RecordingLLM()
    router = AssistantResponseRouter(llm, IntentAnalyzer(use_llm=False))
    await router.route("I had a long day", emotion={"label": "sad", "confidence": 0.82})
    assert "looks sad" in llm.extra_system and "82%" in llm.extra_system

    await router.route("I had a long day", emotion={"label": "neutral", "confidence": 0.9})
    assert llm.extra_system is None
