def test_health_ok(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "ra-one-backend"
    assert "version" in data
    assert data["environment"] == "development"
    assert data["dev_mode"] is True
    assert "timestamp" in data
