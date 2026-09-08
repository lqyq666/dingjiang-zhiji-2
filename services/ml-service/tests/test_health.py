from app.main import health


def test_health() -> None:
    assert health() == {"service": "ml-service", "status": "ok"}
