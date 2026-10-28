"""WebSocket connection manager for assistant state fan-out."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.core.logging import get_logger

logger = get_logger(__name__)


class ConnectionManager:
    """Tracks live `/ws/assistant` clients and broadcasts JSON events."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)
        logger.info("WebSocket connected (%s clients)", self.connection_count)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)
        logger.info("WebSocket disconnected (%s clients)", self.connection_count)

    async def send_json(self, websocket: WebSocket, payload: dict[str, Any]) -> bool:
        if websocket.client_state != WebSocketState.CONNECTED:
            return False
        try:
            await websocket.send_text(json.dumps(payload))
            return True
        except Exception:
            logger.exception("Failed to send WebSocket message")
            return False

    async def broadcast(self, payload: dict[str, Any]) -> int:
        """Send to all clients; drop dead sockets. Returns successful send count."""
        async with self._lock:
            targets = list(self._connections)

        dead: list[WebSocket] = []
        sent = 0
        for ws in targets:
            ok = await self.send_json(ws, payload)
            if ok:
                sent += 1
            else:
                dead.append(ws)

        if dead:
            async with self._lock:
                for ws in dead:
                    self._connections.discard(ws)
        return sent


connection_manager = ConnectionManager()


async def websocket_receive_loop(websocket: WebSocket) -> None:
    """Keep the socket open; ignore client payloads in Module 1 (server → client)."""
    try:
        while True:
            # Accept pings / future client messages without crashing
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        return
