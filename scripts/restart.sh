#!/usr/bin/env bash
# Restart both backend and frontend dev servers with proxy env vars
# stripped. fast-flights' direct Google Flights endpoint 401s when
# requests come through a VPN/datacenter proxy (Clash/Shadowsocks),
# so every outbound call must bypass the local proxy.
#
# Usage:   ./scripts/restart.sh
# Options:
#   BACKEND_PORT=8000   (default)
#   FRONTEND_PORT=5173  (default)
#   HOST=0.0.0.0        (default — listens on all interfaces)
#   NO_RELOAD=1         (backend skips --reload, use for prod-style runs)
#   BACKEND_ONLY=1      (skip frontend restart)
#   FRONTEND_ONLY=1     (skip backend restart)

set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
HOST="${HOST:-0.0.0.0}"
RELOAD_FLAG="--reload"
[[ -n "${NO_RELOAD:-}" ]] && RELOAD_FLAG=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NO_PROXY_ENV=(
  env
  -u HTTP_PROXY -u HTTPS_PROXY
  -u http_proxy -u https_proxy
  -u ALL_PROXY  -u all_proxy
  -u NO_PROXY   -u no_proxy
)

# ─── Backend ──────────────────────────────────────────────────────────
restart_backend() {
  cd "$ROOT/backend"

  if [[ ! -x .venv/bin/uvicorn ]]; then
    echo "❌ .venv/bin/uvicorn not found. Run 'python -m venv .venv && .venv/bin/pip install -r requirements.txt' first." >&2
    return 1
  fi

  # Kill uvicorn processes matching this port only.
  local existing
  existing="$(pgrep -af "uvicorn app.main:app.*--port $BACKEND_PORT" | awk '{print $1}' || true)"
  if [[ -n "$existing" ]]; then
    echo "→ stopping existing backend (PIDs: $(echo "$existing" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $existing 2>/dev/null || true
    sleep 1
  fi

  echo "→ starting uvicorn on ${HOST}:${BACKEND_PORT}${RELOAD_FLAG:+ with --reload}, proxy env stripped"

  nohup "${NO_PROXY_ENV[@]}" \
    .venv/bin/uvicorn app.main:app \
      --host "$HOST" \
      --port "$BACKEND_PORT" \
      $RELOAD_FLAG \
    > /tmp/backend.log 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true

  for _ in $(seq 1 20); do
    sleep 0.5
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${BACKEND_PORT}/health" 2>/dev/null | grep -q "^200$"; then
      echo "✅ backend healthy (PID $pid) — logs: /tmp/backend.log"
      return 0
    fi
  done

  echo "⚠  backend didn't respond within 10s. Last 30 log lines:" >&2
  tail -30 /tmp/backend.log >&2
  return 1
}

# ─── Frontend ─────────────────────────────────────────────────────────
restart_frontend() {
  cd "$ROOT/frontend"

  if [[ ! -d node_modules ]]; then
    echo "❌ frontend/node_modules not found. Run 'npm install' first." >&2
    return 1
  fi

  # Kill any vite process tied to this repo (match the binary path).
  local existing
  existing="$(pgrep -af "node.*frontend/node_modules/\.bin/vite|sh -c vite" | awk '{print $1}' || true)"
  if [[ -n "$existing" ]]; then
    echo "→ stopping existing frontend (PIDs: $(echo "$existing" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $existing 2>/dev/null || true
    sleep 1
  fi

  echo "→ starting vite on port ${FRONTEND_PORT}, proxy env stripped"

  nohup "${NO_PROXY_ENV[@]}" \
    npm run dev -- --host --port "$FRONTEND_PORT" \
    > /tmp/frontend.log 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true

  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${FRONTEND_PORT}/" 2>/dev/null | grep -q "^200$"; then
      echo "✅ frontend healthy (PID $pid) — logs: /tmp/frontend.log"
      return 0
    fi
  done

  echo "⚠  frontend didn't respond within 15s. Last 30 log lines:" >&2
  tail -30 /tmp/frontend.log >&2
  return 1
}

# ─── Run ──────────────────────────────────────────────────────────────
if [[ -z "${FRONTEND_ONLY:-}" ]]; then
  restart_backend
fi
if [[ -z "${BACKEND_ONLY:-}" ]]; then
  restart_frontend
fi

echo ""
echo "→ open http://localhost:${FRONTEND_PORT}"
