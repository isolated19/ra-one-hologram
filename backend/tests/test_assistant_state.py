def test_status_defaults_to_idle(client):
    response = client.get("/api/assistant/status")
    assert response.status_code == 200
    data = response.json()
    assert data["state"] == "idle"
    assert data["connected_clients"] == 0


def test_valid_state_transition(client):
    response = client.post(
        "/api/assistant/state",
        json={"state": "thinking", "source": "test"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["state"] == "thinking"
    assert data["previous_state"] == "idle"

    status = client.get("/api/assistant/status").json()
    assert status["state"] == "thinking"


def test_invalid_state_rejection(client):
    response = client.post(
        "/api/assistant/state",
        json={"state": "dancing"},
    )
    assert response.status_code == 422


def test_state_mutation_forbidden_in_production(prod_client):
    response = prod_client.post(
        "/api/assistant/state",
        json={"state": "listening"},
    )
    assert response.status_code == 403
    assert prod_client.get("/api/assistant/status").json()["state"] == "idle"


def test_all_supported_states(client):
    for name in ("idle", "listening", "thinking", "speaking"):
        response = client.post("/api/assistant/state", json={"state": name})
        assert response.status_code == 200
        assert response.json()["state"] == name
