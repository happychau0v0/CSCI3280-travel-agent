import logging
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import chat, geo, itinerary, photo, speech, status
from app.routers.directions import router as directions_router

# ─── Logging setup ──────────────────────────────────────────────────
# Logs to both stderr (visible in terminal) and backend/logs/app.log
# (persistent, survives terminal close). Each line includes timestamp,
# level, module, and message — enough to trace tool calls and errors.
_log_dir = Path(__file__).resolve().parent.parent / "logs"
_log_dir.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stderr),
        logging.FileHandler(_log_dir / "app.log", encoding="utf-8"),
    ],
)

app = FastAPI(title="AI Travel Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=3600,  # cache preflight for 1 hour — eliminates per-request OPTIONS round-trips
)

app.include_router(chat.router)
app.include_router(itinerary.router)
app.include_router(photo.router)
app.include_router(geo.router)
app.include_router(speech.router)
app.include_router(status.router)
app.include_router(directions_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
