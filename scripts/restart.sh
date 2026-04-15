#!/usr/bin/env bash
# Restart both backend and frontend dev servers.
#
# Both backend and frontend start with proxy env stripped:
#   - xAI (api.x.ai) is directly reachable from HK — no proxy needed
#   - Google Maps tool clients already use trust_env=False
#   - fast-flights uses primp with direct HTTP
#   - Vite only serves static assets
# Keeping the proxy in-process routed LLM calls through Clash and added
# latency / hang risk when the proxy was slow.
#
# Usage:   ./scripts/restart.sh
# Options:
#   BACKEND_PORT=8000   (default)
#   FRONTEND_PORT=5173  (default)
#   HOST=0.0.0.0        (default — listens on all interfaces)
#   NO_RELOAD=1         (backend skips --reload, use for prod-style runs)
#   BACKEND_ONLY=1      (skip frontend restart)
#   FRONTEND_ONLY=1     (skip backend restart)
#   NO_TAILSCALE=1      (skip Tailscale serve setup even if tailscale is installed)

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

  # Kill every process holding port BACKEND_PORT and wait until it's free.
  # Use SIGKILL directly — uvicorn worker processes ignore SIGTERM when the
  # reloader is in a low-priority sleep state (seen with Python 3.14 on macOS).
  local port_pids
  port_pids="$(lsof -ti ":$BACKEND_PORT" 2>/dev/null || true)"
  if [[ -n "$port_pids" ]]; then
    echo "→ killing processes on port $BACKEND_PORT (PIDs: $(echo "$port_pids" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill -9 $port_pids 2>/dev/null || true
    # Wait up to 5 s for the port to become free.
    for _ in $(seq 1 10); do
      sleep 0.5
      if ! lsof -ti ":$BACKEND_PORT" &>/dev/null; then break; fi
    done
  fi

  echo "→ starting uvicorn on ${HOST}:${BACKEND_PORT}${RELOAD_FLAG:+ with --reload}, proxy env stripped (xAI + Google both direct)"

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
    if .venv/bin/python - <<EOF 2>/dev/null
import urllib.request, sys
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    r = opener.open("http://127.0.0.1:${BACKEND_PORT}/health", timeout=2)
    sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
EOF
    then
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

  # Kill everything holding FRONTEND_PORT (includes any VS Code Live Preview
  # process that may shadow Vite on the same port, causing health checks to fail).
  local port_pids
  port_pids="$(lsof -ti ":$FRONTEND_PORT" 2>/dev/null || true)"
  if [[ -n "$port_pids" ]]; then
    echo "→ killing processes on port $FRONTEND_PORT (PIDs: $(echo "$port_pids" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill -9 $port_pids 2>/dev/null || true
    for _ in $(seq 1 6); do
      sleep 0.5
      if ! lsof -ti ":$FRONTEND_PORT" &>/dev/null; then break; fi
    done
  fi

  echo "→ starting vite on port ${FRONTEND_PORT}, proxy env stripped"

  nohup "${NO_PROXY_ENV[@]}" \
    npm run dev -- --host --port "$FRONTEND_PORT" \
    > /tmp/frontend.log 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true

  for _ in $(seq 1 30); do
    sleep 0.5
    if "$ROOT/backend/.venv/bin/python" - <<EOF 2>/dev/null
import urllib.request, sys
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    r = opener.open("http://127.0.0.1:${FRONTEND_PORT}/", timeout=2)
    sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
EOF
    then
      echo "✅ frontend healthy (PID $pid) — logs: /tmp/frontend.log"
      return 0
    fi
  done

  echo "⚠  frontend didn't respond within 15s. Last 30 log lines:" >&2
  tail -30 /tmp/frontend.log >&2
  return 1
}

# ─── Tailscale ────────────────────────────────────────────────────────
setup_tailscale() {
  if [[ -n "${NO_TAILSCALE:-}" ]]; then return 0; fi
  if ! command -v tailscale &>/dev/null; then return 0; fi

  local ts_host
  ts_host="$(tailscale status --json 2>/dev/null | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','').rstrip('.'))" \
    2>/dev/null || true)"
  if [[ -z "$ts_host" ]]; then return 0; fi

  echo "→ configuring Tailscale HTTPS serve for ${ts_host}"
  sudo tailscale serve --bg --https=443  / "http://localhost:${FRONTEND_PORT}" &>/dev/null || true
  sudo tailscale serve --bg --https="${BACKEND_PORT}" / "http://localhost:${BACKEND_PORT}" &>/dev/null || true
  echo "✅ Tailscale serve active"
  echo "   frontend → https://${ts_host}/"
  echo "   backend  → https://${ts_host}:${BACKEND_PORT}/"
}

# ─── Run ──────────────────────────────────────────────────────────────
if [[ -z "${FRONTEND_ONLY:-}" ]]; then
  restart_backend
fi
if [[ -z "${BACKEND_ONLY:-}" ]]; then
  restart_frontend
fi
setup_tailscale

echo ""
echo "→ open http://localhost:${FRONTEND_PORT}"
