from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import chat, itinerary

app = FastAPI(title="AI Travel Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(itinerary.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
