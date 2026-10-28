"""TC-03 WebSocket state events."""

from __future__ import annotations

import json


def test_ws_connect_and_state_event(client):
    with client.websocket_connect("/ws/assistant") as ws:
        snap = json.loads(ws.receive_text())
        assert snap["type"] == "assistant.state"
        assert snap["state"] in ("idle", "listening", "thinking", "speaking")

        client.post("/api/assistant/state", json={"state": "thinking", "source": "test"})
        ev = json.loads(ws.receive_text())
        assert ev["type"] == "assistant.state"
        assert ev["state"] == "thinking"
