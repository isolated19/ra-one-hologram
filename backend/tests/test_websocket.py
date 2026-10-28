"""WebSocket assistant.state streaming and reconnect snapshot."""

from __future__ import annotations

import json


def test_websocket_receives_state_on_connect(client):
    with client.websocket_connect("/ws/assistant") as ws:
        raw = ws.receive_text()
        payload = json.loads(raw)
        assert payload["type"] == "assistant.state"
        assert payload["state"] == "idle"
        assert "timestamp" in payload
        assert payload["timestamp"].endswith("Z")


def test_websocket_broadcasts_state_change(client):
    with client.websocket_connect("/ws/assistant") as ws:
        # drain connect snapshot
        ws.receive_text()

        response = client.post(
            "/api/assistant/state",
            json={"state": "listening", "source": "test"},
        )
        assert response.status_code == 200

        event = json.loads(ws.receive_text())
        assert event["type"] == "assistant.state"
        assert event["state"] == "listening"


def test_websocket_reconnect_receives_current_state(client):
    client.post("/api/assistant/state", json={"state": "speaking"})

    with client.websocket_connect("/ws/assistant") as ws:
        event = json.loads(ws.receive_text())
        assert event["state"] == "speaking"


def test_websocket_connection_count(client):
    assert client.get("/api/assistant/status").json()["connected_clients"] == 0
    with client.websocket_connect("/ws/assistant") as ws:
        ws.receive_text()
        assert client.get("/api/assistant/status").json()["connected_clients"] == 1
    assert client.get("/api/assistant/status").json()["connected_clients"] == 0
