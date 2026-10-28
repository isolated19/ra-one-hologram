"""
Online lookups for what a local model can't know: weather, news, current facts.

Only questions that clearly need live data come here; everything else stays local.
Sources need no API key:
- weather: wttr.in JSON (city from the question, else the PC's IP location)
- news:    Google News RSS
- facts:   Wikipedia search + page summary
Every call fails soft: no internet → None, and the local LLM answers on its own.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

# Wikipedia answers 403 to agents without a URL/contact (meta.wikimedia.org/wiki/User-Agent_policy)
USER_AGENT = "RA-ONE-Assistant/0.1 (personal desktop assistant; +https://meta.wikimedia.org/wiki/User-Agent_policy)"

_WEATHER = re.compile(
    r"\b(weather|forecast|temperature outside|how (hot|cold) is it|is it (going to )?rain(ing)?|"
    r"will it rain|humidity)\b",
    re.I,
)
_PLACE = re.compile(
    r"\b(?:in|at|for)\s+([a-z][a-z .'\-]{1,40}?)\s*(?:today|tomorrow|now|right now|this week|tonight)?\s*[?.!]*$",
    re.I,
)
_TOMORROW = re.compile(r"\btomorrow\b", re.I)
_NEWS = re.compile(r"\b(news|headlines|what'?s happening|latest updates?)\b", re.I)
_NEWS_TOPIC = re.compile(r"\b(?:about|on|regarding|in)\s+(.+?)\s*[?.!]*$", re.I)
_SEARCH_EXPLICIT = re.compile(
    r"^(?:please\s+)?(?:search(?: the web| online| google)?(?: for)?|google|look up|find out(?: about)?)\s+(.+?)\s*[?.!]*$",
    re.I,
)
_SEARCH_FACT = re.compile(
    r"^(?:who\s+(?:is|was|are)|tell\s+me\s+about|when\s+(?:is|was|did)|where\s+is|"
    r"what\s+(?:is|are)\s+the\s+(?:latest|current))\s+(.+?)\s*[?.!]*$",
    re.I,
)
# Things the user does on the PC, not questions for the web
_LOCAL_COMMAND = re.compile(r"^(open|launch|start|remember|forget|create|make|write|note|go to sleep|sleep)\b", re.I)


@dataclass
class WebQuery:
    kind: str  # weather | news | search
    query: str = ""
    tomorrow: bool = False


@dataclass
class WebAnswer:
    kind: str
    text: str  # ready to speak as-is
    context: list[str] = field(default_factory=list)  # raw snippets for the LLM
    source: str = ""
    direct: bool = True  # speak `text` directly; False → let the LLM phrase it from `context`


def classify(text: str) -> WebQuery | None:
    """Return a WebQuery when the question needs live data, else None."""
    t = (text or "").strip()
    if not t or _LOCAL_COMMAND.match(t):
        return None
    if _WEATHER.search(t):
        m = _PLACE.search(t)
        place = m.group(1).strip() if m else ""
        if place.lower() in {"here", "my area", "my city", "today", "tomorrow"}:
            place = ""
        return WebQuery(kind="weather", query=place, tomorrow=bool(_TOMORROW.search(t)))
    if _NEWS.search(t):
        m = _NEWS_TOPIC.search(t)
        topic = m.group(1).strip() if m else ""
        if topic.lower() in {"today", "the world", "general"}:
            topic = ""
        return WebQuery(kind="news", query=topic)
    m = _SEARCH_EXPLICIT.match(t) or _SEARCH_FACT.match(t)
    if m:
        return WebQuery(kind="search", query=m.group(1).strip())
    return None


class WebLookup:
    def __init__(self, *, timeout_sec: float = 6.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.timeout_sec = timeout_sec
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.timeout_sec,
                follow_redirects=True,
                headers={"User-Agent": USER_AGENT},
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def answer(self, q: WebQuery) -> WebAnswer | None:
        try:
            if q.kind == "weather":
                return await self._weather(q)
            if q.kind == "news":
                return await self._news(q)
            if q.kind == "search":
                return await self._wikipedia(q)
        except (httpx.HTTPError, ValueError, KeyError, IndexError, ET.ParseError) as exc:
            logger.warning("web lookup %s failed: %s", q.kind, exc)
        return None

    async def _weather(self, q: WebQuery) -> WebAnswer | None:
        client = await self._get_client()
        r = await client.get(f"https://wttr.in/{quote(q.query)}", params={"format": "j1"})
        r.raise_for_status()
        data = r.json()
        area = data["nearest_area"][0]["areaName"][0]["value"] if data.get("nearest_area") else (q.query or "your area")
        place = q.query.title() if q.query else area
        if q.tomorrow and len(data.get("weather") or []) > 1:
            day = data["weather"][1]
            desc = day["hourly"][4]["weatherDesc"][0]["value"].lower()  # around midday
            text = (
                f"Tomorrow in {place}, expect {desc}, with a high of {day['maxtempC']} "
                f"and a low of {day['mintempC']} degrees."
            )
        else:
            cur = data["current_condition"][0]
            today = data["weather"][0]
            desc = cur["weatherDesc"][0]["value"].lower()
            text = (
                f"Right now in {place} it's {cur['temp_C']} degrees and {desc}, "
                f"feels like {cur['FeelsLikeC']}. Today's high is {today['maxtempC']}, "
                f"low {today['mintempC']}."
            )
        return WebAnswer(kind="weather", text=text, context=[text], source="wttr.in")

    async def _news(self, q: WebQuery) -> WebAnswer | None:
        client = await self._get_client()
        params = {"hl": "en-IN", "gl": "IN", "ceid": "IN:en"}
        if q.query:
            r = await client.get("https://news.google.com/rss/search", params={"q": q.query, **params})
        else:
            r = await client.get("https://news.google.com/rss", params=params)
        r.raise_for_status()
        root = ET.fromstring(r.text)
        titles = []
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            # "Headline - Publisher" → "Headline"
            title = re.sub(r"\s+-\s+[^-]+$", "", title)
            if title:
                titles.append(title)
            if len(titles) >= 3:
                break
        if not titles:
            return None
        lead = f"Here's the latest on {q.query}" if q.query else "Here are the top headlines"
        text = f"{lead}. " + ". ".join(titles) + "."
        return WebAnswer(kind="news", text=text, context=titles, source="Google News")

    async def _wikipedia(self, q: WebQuery) -> WebAnswer | None:
        client = await self._get_client()
        r = await client.get(
            "https://en.wikipedia.org/w/rest.php/v1/search/page",
            params={"q": q.query, "limit": 1},
        )
        r.raise_for_status()
        pages = r.json().get("pages") or []
        if not pages:
            return None
        key = pages[0]["key"]
        s = await client.get(f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(key)}")
        s.raise_for_status()
        extract = (s.json().get("extract") or "").strip()
        if not extract:
            return None
        sentences = re.split(r"(?<=[.!?])\s+", extract)
        text = " ".join(sentences[:2])
        return WebAnswer(kind="search", text=text, context=[extract[:1200]], source="Wikipedia", direct=False)
