"""
Offline LLM engine for RA-ONE using the local Ollama HTTP API.

- Endpoint default: http://127.0.0.1:11434 (never public)
- Preferred: qwen3:1.7b — fallback: qwen3:0.6b
- Downloads a model only via pull_model (boot task, when OLLAMA_AUTO_PULL is on)
- Optimized for short spoken replies on CPU
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Sequence

import httpx

from app.core.logging import get_logger
from app.llm.models_info import (
    FALLBACK_MODEL,
    MODEL_CATALOG,
    PREFERRED_MODEL,
    SYSTEM_PROMPT_SPOKEN,
)

logger = get_logger(__name__)


@dataclass
class ChatMessage:
    role: str  # system | user | assistant
    content: str

    def to_api(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass
class GenerationResult:
    success: bool
    text: str = ""
    model: str = ""
    error: str = ""
    latency_ms: float = 0.0
    prompt_tokens: int | None = None
    eval_tokens: int | None = None
    cancelled: bool = False
    request_id: str = ""


@dataclass
class LLMHealth:
    ollama_reachable: bool
    base_url: str
    preferred_installed: bool
    fallback_installed: bool
    selected_model: str
    installed_models: list[str] = field(default_factory=list)
    detail: str = ""
    catalog: dict[str, Any] = field(default_factory=dict)


class LocalLLMService:
    """Async client for Ollama chat with cancellation, timeouts, and context trim."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:11434",
        preferred_model: str = PREFERRED_MODEL,
        fallback_model: str = FALLBACK_MODEL,
        timeout_sec: float = 90.0,
        connect_timeout_sec: float = 5.0,
        max_output_tokens: int = 120,
        num_ctx: int = 2048,
        # Warm enough to sound like a person, low enough to stay on topic
        temperature: float = 0.7,
        num_thread: int | None = 4,
        keep_alive: str = "10m",
        max_history_turns: int = 6,
        system_prompt: str = SYSTEM_PROMPT_SPOKEN,
    ) -> None:
        # Hard-bind expectation: loopback only
        if not (
            base_url.startswith("http://127.0.0.1")
            or base_url.startswith("http://localhost")
        ):
            raise ValueError(
                "Ollama base_url must be localhost/127.0.0.1 — refusing non-local endpoint"
            )
        self.base_url = base_url.rstrip("/")
        self.preferred_model = preferred_model
        self.fallback_model = fallback_model
        self.selected_model = preferred_model
        self.timeout_sec = timeout_sec
        self.connect_timeout_sec = connect_timeout_sec
        self.max_output_tokens = max_output_tokens
        self.num_ctx = num_ctx
        self.temperature = temperature
        self.num_thread = num_thread
        self.keep_alive = keep_alive
        self.max_history_turns = max_history_turns
        self.system_prompt = system_prompt

        self._client: httpx.AsyncClient | None = None
        self._active: dict[str, asyncio.Event] = {}
        self._lock = asyncio.Lock()
        self._health_cache: LLMHealth | None = None
        self._health_cache_at: float = 0.0
        self._health_cache_ttl_sec: float = 15.0

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            timeout=self.timeout_sec,
            connect=self.connect_timeout_sec,
        )

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self._timeout(),
                trust_env=False,  # ignore HTTP_PROXY — stay local
            )
        return self._client

    async def aclose(self) -> None:
        for ev in list(self._active.values()):
            ev.set()
        self._active.clear()
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    # ------------------------------------------------------------------ health / models

    async def list_models(self) -> list[str]:
        client = await self._get_client()
        try:
            r = await client.get("/api/tags")
            r.raise_for_status()
            data = r.json()
            names = []
            for m in data.get("models") or []:
                name = m.get("name") or m.get("model")
                if name:
                    names.append(str(name))
            return names
        except httpx.HTTPError as exc:
            logger.warning("Ollama list_models failed: %s", exc)
            return []

    def _model_installed(self, installed: Sequence[str], want: str) -> bool:
        want_l = want.lower()
        for name in installed:
            n = name.lower()
            if n == want_l or n.startswith(want_l + ":") or n.startswith(want_l + "-"):
                return True
            # tags like qwen3:1.7b-q8_0
            if want_l.split(":")[0] in n and want_l.split(":")[-1] in n:
                return True
        return want_l in {n.lower() for n in installed}

    async def health(self, *, force: bool = False) -> LLMHealth:
        now = time.monotonic()
        if (
            not force
            and self._health_cache is not None
            and (now - self._health_cache_at) < self._health_cache_ttl_sec
        ):
            return self._health_cache

        installed = await self.list_models()
        reachable = False
        detail = ""
        try:
            client = await self._get_client()
            r = await client.get("/")
            reachable = r.status_code < 500
            detail = "Ollama reachable" if reachable else f"Unexpected status {r.status_code}"
        except httpx.HTTPError as exc:
            detail = f"Ollama unreachable at {self.base_url}: {exc}"
            reachable = False

        pref = self._model_installed(installed, self.preferred_model)
        fall = self._model_installed(installed, self.fallback_model)
        # Auto-select installed preferred, else fallback — never pulls
        if pref:
            self.selected_model = self.preferred_model
        elif fall:
            self.selected_model = self.fallback_model
        else:
            self.selected_model = self.preferred_model

        if reachable and not pref and not fall:
            detail += (
                f". Neither {self.preferred_model} nor {self.fallback_model} installed. "
                "Run scripts/setup_ollama.ps1 and confirm before downloading."
            )

        health = LLMHealth(
            ollama_reachable=reachable,
            base_url=self.base_url,
            preferred_installed=pref,
            fallback_installed=fall,
            selected_model=self.selected_model,
            installed_models=list(installed),
            detail=detail,
            catalog=MODEL_CATALOG,
        )
        self._health_cache = health
        self._health_cache_at = now
        return health

    async def pull_model(self, model: str) -> bool:
        """Download a model through Ollama. Blocks until done (minutes) — run from a background task."""
        client = await self._get_client()
        try:
            r = await client.post(
                "/api/pull",
                json={"model": model, "stream": False},
                timeout=httpx.Timeout(None, connect=self.connect_timeout_sec),
            )
            r.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("Ollama pull %s failed: %s", model, exc)
            return False
        self._health_cache = None
        return True

    def set_model(self, model: str) -> None:
        model = (model or "").strip()
        if not model:
            raise ValueError("model required")
        self.selected_model = model

    def configure(
        self,
        *,
        max_output_tokens: int | None = None,
        num_ctx: int | None = None,
        temperature: float | None = None,
        num_thread: int | None = None,
        max_history_turns: int | None = None,
        timeout_sec: float | None = None,
    ) -> dict[str, Any]:
        if max_output_tokens is not None:
            self.max_output_tokens = max(16, min(512, int(max_output_tokens)))
        if num_ctx is not None:
            self.num_ctx = max(512, min(8192, int(num_ctx)))
        if temperature is not None:
            self.temperature = max(0.0, min(1.5, float(temperature)))
        if num_thread is not None:
            self.num_thread = max(1, min(16, int(num_thread)))
        if max_history_turns is not None:
            self.max_history_turns = max(0, min(20, int(max_history_turns)))
        if timeout_sec is not None:
            self.timeout_sec = max(5.0, float(timeout_sec))
        return self.runtime_config()

    def runtime_config(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "preferred_model": self.preferred_model,
            "fallback_model": self.fallback_model,
            "selected_model": self.selected_model,
            "max_output_tokens": self.max_output_tokens,
            "num_ctx": self.num_ctx,
            "temperature": self.temperature,
            "num_thread": self.num_thread,
            "keep_alive": self.keep_alive,
            "max_history_turns": self.max_history_turns,
            "timeout_sec": self.timeout_sec,
            "local_only": True,
            "auto_download": False,
        }

    # ------------------------------------------------------------------ context

    def build_messages(
        self,
        user_text: str,
        history: Sequence[ChatMessage] | Sequence[dict[str, str]] | None = None,
        *,
        extra_system: str | None = None,
        system_override: str | None = None,
    ) -> list[dict[str, str]]:
        if system_override:
            system = system_override.strip()
        else:
            system = self.system_prompt
            if extra_system:
                system = f"{system}\n{extra_system.strip()}"

        msgs: list[dict[str, str]] = [{"role": "system", "content": system}]
        turns: list[dict[str, str]] = []
        if history:
            for item in history:
                if isinstance(item, ChatMessage):
                    turns.append(item.to_api())
                elif isinstance(item, dict) and item.get("role") and item.get("content") is not None:
                    turns.append({"role": str(item["role"]), "content": str(item["content"])})
        # Keep last N user/assistant pairs (2 messages per turn approx)
        max_msgs = max(0, self.max_history_turns * 2)
        if max_msgs and len(turns) > max_msgs:
            turns = list(turns[-max_msgs:])
        msgs.extend(turns)
        msgs.append({"role": "user", "content": user_text.strip()})
        return msgs

    # ------------------------------------------------------------------ generate

    def _options(self) -> dict[str, Any]:
        opts: dict[str, Any] = {
            "temperature": self.temperature,
            "num_ctx": self.num_ctx,
            "num_predict": self.max_output_tokens,
            # Reduce rambling for speech
            "repeat_penalty": 1.1,
        }
        if self.num_thread is not None:
            opts["num_thread"] = self.num_thread
        return opts

    async def chat(
        self,
        user_text: str,
        *,
        history: Sequence[ChatMessage] | Sequence[dict[str, str]] | None = None,
        extra_system: str | None = None,
        system_override: str | None = None,
        model: str | None = None,
        request_id: str | None = None,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> GenerationResult:
        rid = request_id or str(uuid.uuid4())
        cancel = asyncio.Event()
        async with self._lock:
            self._active[rid] = cancel

        text = (user_text or "").strip()
        if not text:
            async with self._lock:
                self._active.pop(rid, None)
            return GenerationResult(success=False, error="Empty prompt", request_id=rid)

        # Refresh selection if needed
        health = await self.health()
        if not health.ollama_reachable:
            async with self._lock:
                self._active.pop(rid, None)
            return GenerationResult(
                success=False,
                error=health.detail,
                request_id=rid,
            )
        use_model = model or self.selected_model
        if not self._model_installed(health.installed_models, use_model):
            if health.fallback_installed:
                use_model = self.fallback_model
            else:
                async with self._lock:
                    self._active.pop(rid, None)
                return GenerationResult(
                    success=False,
                    error=(
                        f"Model {use_model!r} is not installed. "
                        "Confirm download via scripts/setup_ollama.ps1 (no auto-pull)."
                    ),
                    request_id=rid,
                    model=use_model,
                )

        messages = self.build_messages(
            text,
            history,
            extra_system=extra_system,
            system_override=system_override,
        )
        opts = self._options()
        if max_output_tokens is not None:
            opts["num_predict"] = max(16, min(512, int(max_output_tokens)))
        if temperature is not None:
            opts["temperature"] = max(0.0, min(1.5, float(temperature)))
        payload: dict[str, Any] = {
            "model": use_model,
            "messages": messages,
            "stream": False,
            "keep_alive": self.keep_alive,
            "options": opts,
            # Qwen3: disable thinking mode for short spoken answers
            "think": False,
        }

        t0 = time.perf_counter()
        try:
            client = await self._get_client()
            # Race request against cancel flag via polling task
            req_task = asyncio.create_task(client.post("/api/chat", json=payload))
            while not req_task.done():
                if cancel.is_set():
                    req_task.cancel()
                    try:
                        await req_task
                    except (asyncio.CancelledError, httpx.HTTPError):
                        pass
                    return GenerationResult(
                        success=False,
                        error="Generation cancelled",
                        cancelled=True,
                        request_id=rid,
                        model=use_model,
                        latency_ms=(time.perf_counter() - t0) * 1000,
                    )
                await asyncio.sleep(0.05)
            response = req_task.result()
            response.raise_for_status()
            data = response.json()
        except httpx.TimeoutException:
            return GenerationResult(
                success=False,
                error=f"LLM timed out after {self.timeout_sec}s",
                request_id=rid,
                model=use_model,
                latency_ms=(time.perf_counter() - t0) * 1000,
            )
        except httpx.HTTPError as exc:
            return GenerationResult(
                success=False,
                error=f"Ollama HTTP error: {exc}",
                request_id=rid,
                model=use_model,
                latency_ms=(time.perf_counter() - t0) * 1000,
            )
        finally:
            async with self._lock:
                self._active.pop(rid, None)

        msg = (data.get("message") or {})
        content = str(msg.get("content") or "").strip()
        # Strip accidental thinking tags if any leaked
        content = _sanitize_spoken(content)
        return GenerationResult(
            success=bool(content),
            text=content or "",
            model=str(data.get("model") or use_model),
            error="" if content else "Empty model response",
            latency_ms=(time.perf_counter() - t0) * 1000,
            prompt_tokens=data.get("prompt_eval_count"),
            eval_tokens=data.get("eval_count"),
            request_id=rid,
        )

    async def cancel(self, request_id: str | None = None) -> int:
        """Cancel one or all in-flight generations."""
        count = 0
        async with self._lock:
            if request_id:
                ev = self._active.get(request_id)
                if ev:
                    ev.set()
                    count = 1
            else:
                for ev in self._active.values():
                    ev.set()
                    count += 1
        return count

    async def warm(self, model: str | None = None) -> GenerationResult:
        """Lightweight keep-alive load without auto-pulling missing models."""
        return await self.chat(
            "Reply with exactly: Online.",
            history=[],
            model=model,
            extra_system="One word only if possible.",
        )


def _sanitize_spoken(text: str) -> str:
    import re

    t = text.strip()
    # Never read Qwen/model internal reasoning aloud
    t = re.sub(r"<think>[\s\S]*?</think>", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"</?think>", " ", t, flags=re.IGNORECASE)
    # Remove common markdown leftovers for TTS
    for ch in ("**", "__", "`"):
        t = t.replace(ch, "")
    # Emoji / pictographs (and halves of ones cut off by num_predict) are read aloud as junk
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿️‍\ud800-\udfff]", "", t)
    # Collapse whitespace
    t = " ".join(t.split())
    # Hit the token cap mid-sentence → end on the last full sentence instead of trailing off
    if t and t[-1] not in ".!?\"')":
        cut = max(t.rfind(". "), t.rfind("! "), t.rfind("? "))
        if cut > 0:
            t = t[: cut + 1]
    return t


@lru_cache
def get_llm_service() -> LocalLLMService:
    return LocalLLMService()
