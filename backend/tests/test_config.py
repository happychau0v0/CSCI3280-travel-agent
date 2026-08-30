from app.config import parse_cors_origins
from app.main import app
from fastapi.testclient import TestClient


client = TestClient(app)


def test_parse_cors_origins_uses_local_development_defaults():
    assert parse_cors_origins(None) == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_parse_cors_origins_strips_empty_values_and_whitespace():
    assert parse_cors_origins(" https://demo.example , ,https://review.example ") == [
        "https://demo.example",
        "https://review.example",
    ]


def test_cors_allows_only_configured_local_development_origins():
    response = client.options(
        "/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"

    blocked = client.options(
        "/health",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert blocked.status_code == 400
