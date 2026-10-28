"""
RA-ONE Backend — Module 1: foundation (health, assistant state, WebSocket).

Run from the backend/ directory:
  py -3.12 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
Desktop / packaged: `python run_server.py` (127.0.0.1, file logging, optional RAONE_STATIC_DIR UI).
"""

from __future__ import annotations

import asyncio
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.actions.ActionExecutor import ActionExecutor
from app.api import actions as actions_api
from app.api import assistant as assistant_api
from app.api import conversation as conversation_api
from app.api import health as health_api
from app.api import intent as intent_api
from app.api import llm as llm_api
from app.api import permissions as permissions_api
from app.api import stt as stt_api
from app.api import voice as voice_api
from app.config import Settings, get_settings
from app.conversation.ConversationService import ConversationService
from app.core.logging import configure_logging, get_logger
from app.core.paths import STATIC_DIR
from app.intent.IntentAnalyzer import IntentAnalyzer
from app.llm.LocalLLMService import LocalLLMService
from app.permissions.PermissionManager import PermissionManager, get_permission_manager
from app.services.assistant_state import AssistantStateService
from app.stt.OfflineSTTEngine import OfflineSTTEngine, get_stt_engine
from app.web.WebLookup import WebLookup
from app.websocket.manager import ConnectionManager, websocket_receive_loop

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    configure_logging(settings.log_level)
    logger.info(
        "RA-ONE backend v%s starting (env=%s, dev_mode=%s, cors=%s)",
        __version__,
        settings.app_env,
        settings.state_mutation_allowed,
        settings.cors_origins,
    )
    # Load models in the background so the server listens at once (Piper voices take 5–10 s
    # each). Order = order of need: STT first (clap / "Hey RA-ONE" can wake), then the default
    # voice + TTS warm-up (first reply), then the other preset voices.
    # Sequential on purpose: run concurrently they fight over the same 4 cores.
    stt: OfflineSTTEngine = app.state.stt_engine
    if not stt.available:
        logger.warning("Offline STT models missing — run scripts/download_stt_models.py")

    def _background_warm() -> None:
        t0 = time.perf_counter()
        if stt.available and stt.preload():
            logger.info("Wake/STT ready %.1f s after startup", time.perf_counter() - t0)
        try:
            from app.voice.OfflineTTSEngine import get_tts_engine

            engine = get_tts_engine()
            engine.preload([engine.presets.default_voice])
            engine.warm_up()
            loaded = engine.preload()
            logger.info(
                "Offline TTS ready %.1f s after startup (piper=%s, voices=%s)",
                time.perf_counter() - t0,
                engine.piper_version,
                loaded or "none-installed",
            )
        except Exception as exc:
            logger.warning("Offline TTS preload skipped: %s", exc)

    threading.Thread(target=_background_warm, name="raone-warmup", daemon=True).start()
    # Module 6: Ollama may lag behind Windows login — poll in the background (never blocks listen)
    ollama_task: asyncio.Task | None = None

    async def _ollama_boot_wait() -> None:
        from app.llm.ollama_bootstrap import ensure_ollama, set_status
        from app.llm.ollama_wait import wait_for_ollama

        try:
            llm: LocalLLMService = app.state.llm_service
            # Not answering → install it if missing, then start it
            if settings.ollama_auto_install and not (await llm.health(force=True)).ollama_reachable:
                await asyncio.to_thread(ensure_ollama, llm.base_url)
            health = await wait_for_ollama(llm, interval_sec=5.0, timeout_sec=60.0)
            if health.ollama_reachable and not health.preferred_installed:
                if settings.ollama_auto_pull:
                    # The small fallback keeps answering meanwhile, if it is installed
                    set_status("pulling-model", llm.preferred_model)
                    ok = await llm.pull_model(llm.preferred_model)
                    set_status("ready" if ok else "failed", f"model {llm.preferred_model}" + ("" if ok else " download failed"))
                    await llm.health(force=True)
                elif not health.fallback_installed:
                    logger.warning(
                        "No Qwen3 models installed. Run scripts/setup_ollama.ps1 and confirm before download."
                    )
            if health.ollama_reachable:
                # Load the model into RAM now so the first question doesn't wait ~1 min for it
                health = await llm.health(force=True)
                if health.preferred_installed or health.fallback_installed:
                    warm = await llm.warm()
                    logger.info("LLM warm-up %s in %.0f ms (%s)", "ok" if warm.success else "failed",
                                warm.latency_ms, warm.model)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Offline LLM boot wait skipped: %s", exc)

    ollama_task = asyncio.create_task(_ollama_boot_wait(), name="raone-ollama-wait")
    yield
    if ollama_task and not ollama_task.done():
        ollama_task.cancel()
        try:
            await ollama_task
        except (asyncio.CancelledError, Exception):
            pass
    try:
        from app.voice.OfflineTTSEngine import get_tts_engine

        get_tts_engine().shutdown()
    except Exception:
        pass
    try:
        await app.state.llm_service.aclose()
    except Exception:
        pass
    if app.state.web_lookup is not None:
        await app.state.web_lookup.aclose()
    logger.info("RA-ONE backend shutting down")


class _WebFiles(StaticFiles):
    """Built UI. index.html must never be cached (it names the hashed bundles), or an
    updated install keeps running the previous UI."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        if str(full_path).endswith(".html"):
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(
    settings: Settings | None = None,
    *,
    assistant_state: AssistantStateService | None = None,
    ws_manager: ConnectionManager | None = None,
    permission_manager: PermissionManager | None = None,
    llm_service: LocalLLMService | None = None,
    intent_analyzer: IntentAnalyzer | None = None,
    action_executor: ActionExecutor | None = None,
    conversation_service: ConversationService | None = None,
    stt_engine: OfflineSTTEngine | None = None,
    static_dir: Path | None = STATIC_DIR,
) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(
        title="RA-ONE Backend",
        description="FastAPI backend for the cosmic hologram frontend (permissions, voice, LLM, state).",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.assistant_state = assistant_state or AssistantStateService()
    app.state.ws_manager = ws_manager or ConnectionManager()
    app.state.permission_manager = permission_manager or get_permission_manager()
    if llm_service is None:
        llm_service = LocalLLMService(
            base_url=settings.ollama_base_url,
            preferred_model=settings.ollama_preferred_model,
            fallback_model=settings.ollama_fallback_model,
            num_ctx=settings.ollama_num_ctx,
            max_output_tokens=settings.ollama_max_output_tokens,
            num_thread=settings.ollama_num_thread,
            timeout_sec=settings.ollama_timeout_sec,
            keep_alive=settings.ollama_keep_alive,
        )
    app.state.llm_service = llm_service
    app.state.stt_engine = stt_engine or get_stt_engine()
    app.state.intent_analyzer = intent_analyzer or IntentAnalyzer(
        llm=llm_service, use_llm=settings.intent_use_llm
    )
    app.state.action_executor = action_executor or ActionExecutor(
        permissions=app.state.permission_manager
    )
    app.state.web_lookup = WebLookup() if settings.web_lookup_enabled else None
    app.state.conversation_service = conversation_service or ConversationService(
        llm=app.state.llm_service,
        intent=app.state.intent_analyzer,
        actions=app.state.action_executor,
        allow_mock=settings.dev_mode and not settings.is_production,
        web=app.state.web_lookup,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["*"],
    )

    app.include_router(health_api.router)
    app.include_router(assistant_api.router)
    app.include_router(voice_api.router)
    app.include_router(stt_api.router)
    app.include_router(permissions_api.router)
    app.include_router(llm_api.router)
    app.include_router(intent_api.router)
    app.include_router(actions_api.router)
    app.include_router(conversation_api.router)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(_request, exc: Exception):
        logger.exception("Unhandled error: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    @app.websocket("/ws/assistant")
    async def assistant_ws(websocket: WebSocket) -> None:
        """Stream assistant.state events; send current state on connect."""
        manager = app.state.ws_manager
        service = app.state.assistant_state
        await manager.connect(websocket)
        try:
            # Sync client immediately so reconnect recovers UI state
            snapshot = service.snapshot_event(source="ws.sync")
            await manager.send_json(websocket, snapshot.to_ws_dict())
            await websocket_receive_loop(websocket)
        except WebSocketDisconnect:
            pass
        finally:
            await manager.disconnect(websocket)

    # Desktop build: serve the built frontend at "/" so UI and API share one origin (no CORS).
    # Mounted last, so every /api and /ws route above still wins.
    if static_dir is not None:
        if (static_dir / "index.html").is_file():
            app.mount("/", _WebFiles(directory=static_dir, html=True), name="web")
            logger.info("Serving frontend from %s", static_dir)
        else:
            logger.warning("RAONE_STATIC_DIR=%s has no index.html — UI not served", static_dir)

    return app


app = create_app()
