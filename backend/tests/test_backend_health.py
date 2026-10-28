"""TC-02 style health checks retained for Module 2."""


def test_health_endpoint_success(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_voice_capabilities(client):
    r = client.get("/api/voice/capabilities")
    assert r.status_code == 200
    data = r.json()
    assert "2" in data["module"]
    assert data["mock_responses"] is True
    assert data["server_stt"] is True
    assert data["server_tts"] is True
    assert data["cloud_tts"] is False
    assert data["tts_engine"] == "piper"
