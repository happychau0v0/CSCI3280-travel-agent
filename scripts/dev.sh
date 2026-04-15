#!/usr/bin/env bash
set -e

trap 'kill 0' EXIT

# Clear stale processes from a previous run so uvicorn/vite can bind immediately.
echo "Clearing ports 8000 and 5173..."
lsof -ti :8000 | xargs kill -9 2>/dev/null || true
lsof -ti :5173 | xargs kill -9 2>/dev/null || true

echo "Starting backend..."
(cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) &

echo "Starting frontend..."
(cd frontend && npm run dev) &

wait
