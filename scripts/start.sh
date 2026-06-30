#!/usr/bin/env bash
#
# scripts/start.sh — one-command bootstrap for OpenX-S.
#
# Idempotent. Run from repo root. Picks up where it left off:
#   1. Ensures .env.local exists (copies from .env.example if missing).
#   2. Installs node + sdk + frontend workspaces if node_modules is absent.
#   3. Applies Supabase migrations if DATABASE_URL is set.
#   4. Builds + deploys the 4 Soroban contracts to testnet if any contract id
#      env var is unset. Initialises them too.
#   5. Builds the SDK + API + Frontend.
#   6. Starts API on :3001 and frontend on :3000 in the foreground.
#
# Usage:
#   ./scripts/start.sh              # full dev loop (API + frontend)
#   ./scripts/start.sh --deploy     # only build + deploy contracts
#   ./scripts/start.sh --migrate    # only apply migrations
#   ./scripts/start.sh --api        # only run API
#   ./scripts/start.sh --frontend   # only run frontend

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ─── 1. env ────────────────────────────────────────────────────────────────
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    echo "✨ created .env.local from .env.example — fill in DATABASE_URL + STELLAR_PLATFORM_SECRET_KEY then rerun."
    exit 1
  else
    echo "❌ neither .env.local nor .env.example present" >&2
    exit 1
  fi
fi
set -a; source .env.local; set +a

MODE="${1:-all}"

# ─── 2. install deps ───────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "📦 installing workspaces…"
  npm install --silent
fi

# ─── 3. migrate ────────────────────────────────────────────────────────────
migrate() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "⚠ DATABASE_URL unset — skipping migrations"
    return 0
  fi
  echo "🗄  applying migrations…"
  local applied=0 failed=0
  for f in packages/shared/migrations/*.sql; do
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -q -f "$f" >/dev/null 2>&1; then
      applied=$((applied + 1))
    else
      failed=$((failed + 1))
    fi
  done
  echo "   applied $applied; failed $failed (migrations are idempotent — re-runs are OK)"
}

# ─── 4. deploy contracts ───────────────────────────────────────────────────
deploy_contracts() {
  if [ -n "${STELLAR_AGENT_REGISTRY_ID:-}" ] \
     && [ -n "${STELLAR_PAID_CALL_LEDGER_ID:-}" ] \
     && [ -n "${STELLAR_PAYWALL_ROUTER_ID:-}" ] \
     && [ -n "${STELLAR_PRIVACY_POOL_ID:-}" ]; then
    echo "✅ contracts already deployed — skipping"
    return 0
  fi
  echo "🚀 deploying Soroban contracts to ${STELLAR_NETWORK:-testnet}…"
  bash scripts/deploy-soroban.sh all "${STELLAR_NETWORK:-testnet}"
  # Re-load env after deploy writes new ids.
  set -a; source .env.local; set +a
  init_contracts
}

init_contracts() {
  : "${STELLAR_PLATFORM_ACCOUNT_ID:?platform account id required}"
  : "${STELLAR_USDC_SAC_ID:?usdc sac id required}"
  local NET="${STELLAR_NETWORK:-testnet}"
  echo "⚙  initialising contracts (idempotent — second runs are no-ops)…"
  stellar contract invoke --id "$STELLAR_AGENT_REGISTRY_ID" --source platform --network "$NET" -- \
    init --admin "$STELLAR_PLATFORM_ACCOUNT_ID" 2>&1 | tail -1 || true
  sleep 4
  stellar contract invoke --id "$STELLAR_PAID_CALL_LEDGER_ID" --source platform --network "$NET" -- \
    init --admin "$STELLAR_PLATFORM_ACCOUNT_ID" \
         --router "$STELLAR_PAYWALL_ROUTER_ID" \
         --usdc_sac "$STELLAR_USDC_SAC_ID" 2>&1 | tail -1 || true
  sleep 4
  stellar contract invoke --id "$STELLAR_PAYWALL_ROUTER_ID" --source platform --network "$NET" -- \
    init --admin "$STELLAR_PLATFORM_ACCOUNT_ID" \
         --registry "$STELLAR_AGENT_REGISTRY_ID" \
         --ledger "$STELLAR_PAID_CALL_LEDGER_ID" \
         --usdc_sac "$STELLAR_USDC_SAC_ID" \
         --treasury "$STELLAR_PLATFORM_ACCOUNT_ID" \
         --platform_bp 500 2>&1 | tail -1 || true
  sleep 4
  stellar contract invoke --id "$STELLAR_PRIVACY_POOL_ID" --source platform --network "$NET" -- \
    init --admin "$STELLAR_PLATFORM_ACCOUNT_ID" \
         --usdc_sac "$STELLAR_USDC_SAC_ID" \
         --verifier "${STELLAR_GROTH16_VERIFIER_ID:-$STELLAR_PRIVACY_POOL_ID}" 2>&1 | tail -1 || true
}

# ─── 5. build ──────────────────────────────────────────────────────────────
build_stack() {
  echo "🔨 building sdk + api + frontend…"
  npm run sdk:build
  npm run api:build
}

# ─── 6. run ────────────────────────────────────────────────────────────────
run_dev() {
  local api_log="/tmp/openx-s-api.log"
  local front_log="/tmp/openx-s-frontend.log"
  local api_port="${API_PORT:-${PORT:-3001}}"
  local front_port="${FRONTEND_PORT:-3000}"

  # Unset PORT so Next.js (which honours PORT) doesn't inherit the API's port
  # from .env.local. Each child gets its own port via explicit env.
  unset PORT

  echo "🚀 API → http://localhost:${api_port}   (logs: $api_log)"
  PORT="$api_port" npm run api:dev --silent >"$api_log" 2>&1 &
  local API_PID=$!

  echo "🌐 frontend → http://localhost:${front_port}   (logs: $front_log)"
  PORT="$front_port" npm run frontend:dev --silent >"$front_log" 2>&1 &
  local FRONT_PID=$!

  cleanup() {
    echo
    echo "🛑 stopping..."
    kill "$API_PID" "$FRONT_PID" 2>/dev/null || true
    wait "$API_PID" "$FRONT_PID" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  echo "✅ both running. tail -f $api_log /  $front_log"
  wait
}

case "$MODE" in
  all)         migrate; deploy_contracts; build_stack; run_dev ;;
  --migrate)   migrate ;;
  --deploy)    deploy_contracts ;;
  --build)     build_stack ;;
  --api)       npm run api:dev ;;
  --frontend)  npm run frontend:dev ;;
  *) echo "usage: $0 [--migrate|--deploy|--build|--api|--frontend]"; exit 1 ;;
esac
