from typing import Literal, TypedDict

from fastapi import FastAPI


class HealthResponse(TypedDict):
    service: Literal["ml-service"]
    status: Literal["ok"]


app = FastAPI(title="Dingjiang ML Service", version="0.1.0")


@app.get("/health")
def health() -> HealthResponse:
    return {"service": "ml-service", "status": "ok"}
