#!/usr/bin/env bash
set -e

echo "==> Running backend tests..."
(cd backend && source .venv/bin/activate && python -m pytest tests/ -v)

echo "==> Running ruff check..."
(cd backend && source .venv/bin/activate && ruff check app/ tests/)

echo "==> Building frontend..."
(cd frontend && npm run build)

echo "==> All checks passed!"
