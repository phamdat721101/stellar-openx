#!/bin/bash
#
# deploy.sh — production deploy via docker-compose. Assumes Soroban contracts
# are already deployed (`npm run soroban:deploy`).
set -e

echo "==> OpenX-S v3.0.0 — Production Deploy"

if [ ! -f .env.local ]; then
  echo "No .env.local found. Run: cp .env.example .env.local && edit"
  exit 1
fi

# shellcheck disable=SC1091
source .env.local

for var in DATABASE_URL STELLAR_NETWORK STELLAR_PLATFORM_SECRET_KEY \
           STELLAR_AGENT_REGISTRY_ID STELLAR_PAYWALL_ROUTER_ID \
           STELLAR_PAID_CALL_LEDGER_ID; do
  if [ -z "${!var}" ]; then
    echo "✗ Missing required: $var"
    exit 1
  fi
done

git pull origin main 2>/dev/null || true

echo "==> Building docker images..."
docker compose build --parallel

echo "==> Starting services..."
docker compose up -d --remove-orphans

echo "==> Applying database migrations..."
for f in packages/shared/migrations/*.sql; do
  docker compose exec -T api psql "$DATABASE_URL" -f "$f" 2>/dev/null || true
done

echo "==> Health check..."
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
    echo "✓ API healthy"
    break
  fi
  sleep 3
done

echo
echo "=== OpenX-S v3.0.0 running ==="
echo "  Frontend:   http://localhost:3000"
echo "  API:        http://localhost:3001"
echo "  Health:     http://localhost:3001/health"
echo "  Metrics:    http://localhost:3001/metrics"
echo
echo "Logs: docker compose logs -f"
