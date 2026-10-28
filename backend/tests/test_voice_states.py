"""Voice-related assistant state transitions (server mirrors visual states)."""


def test_voice_pipeline_states(client):
    for name in ("idle", "listening", "thinking", "speaking", "idle"):
        r = client.post("/api/assistant/state", json={"state": name, "source": "voice"})
        assert r.status_code == 200
        assert r.json()["state"] == name


def test_invalid_voice_state_rejected(client):
    r = client.post("/api/assistant/state", json={"state": "standby"})
    assert r.status_code == 422
