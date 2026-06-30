#!/usr/bin/env bash
#
# Dev runner: build the SDK, start the API on :3001, start the frontend on :3000.
# Stops on Ctrl-C and tears both children down.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load env if present.
if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi

echo "🔨 build sdk..."
npm run sdk:build --silent

API_LOG="/tmp/openx-s-api.log"
FRONT_LOG="/tmp/openx-s-frontend.log"

echo "🚀 starting API (logs: $API_LOG)..."
npm run api:dev --silent >"$API_LOG" 2>&1 &
API_PID=$!

echo "🌐 starting frontend (logs: $FRONT_LOG)..."
npm run frontend:dev --silent >"$FRONT_LOG" 2>&1 &
FRONT_PID=$!

cleanup() {
  echo "💀 shutting down..."
  kill "$API_PID" "$FRONT_PID" 2>/dev/null || true
  wait "$API_PID" "$FRONT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "✅ both running. tail -f $API_LOG  /  $FRONT_LOG"
wait "$API_PID" "$FRONT_PID"
