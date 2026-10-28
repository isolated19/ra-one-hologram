"""
Wait for Ollama to become reachable after Windows login (Module 6).

At boot, Ollama's own autostart may lag behind RA-ONE. Poll /api/tags without
blocking the FastAPI lifespan forever — call from a background task.
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

from app.core.logging import get_logger

if TYPE_CHECKING:
    from app.llm.LocalLLMService import LLMHealth, LocalLLMService

logger = get_logger(__name__)


async def wait_for_ollama(
    llm: LocalLLMService,
    *,
    interval_sec: float = 5.0,
    timeout_sec: float = 60.0,
) -> LLMHealth:
    """
    Poll Ollama until reachable or timeout.

    Returns the last health snapshot. Never downloads models.
    """
    deadline = time.monotonic() + max(0.0, timeout_sec)
    attempt = 0
    last = await llm.health()
    if last.ollama_reachable:
        logger.info(
            "Ollama already reachable (selected=%s preferred=%s fallback=%s)",
            last.selected_model,
            last.preferred_installed,
            last.fallback_installed,
        )
        return last

    logger.warning(
        "Ollama not reachable at %s — retrying every %.0fs for %.0fs (Windows boot lag)",
        last.base_url,
        interval_sec,
        timeout_sec,
    )
    while time.monotonic() < deadline:
        await asyncio.sleep(interval_sec)
        attempt += 1
        last = await llm.health()
        if last.ollama_reachable:
            logger.info(
                "Ollama became reachable after %d poll(s) (selected=%s preferred=%s fallback=%s)",
                attempt,
                last.selected_model,
                last.preferred_installed,
                last.fallback_installed,
            )
            return last
        logger.debug("Ollama poll %d: still unreachable", attempt)

    logger.warning(
        "Ollama still unreachable after %.0fs — conversation will use offline error until it starts",
        timeout_sec,
    )
    return last
