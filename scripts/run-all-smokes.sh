#!/usr/bin/env bash
# Stellar smoke suite. Boot the API first (`npm run api:dev`) and seed an agent
# before running (`npm run seed:translator`).

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶︎ smoke: cargo unit tests (offline; no Stellar network)"
cargo test --manifest-path packages/soroban-contracts/Cargo.toml --quiet

echo "▶︎ smoke: marketplace e2e"
npx tsx scripts/smoke-stellar-marketplace-e2e.ts

echo "▶︎ smoke: privacy-pool 402 envelope"
npx tsx scripts/smoke-stellar-privacy-pool-e2e.ts

echo "▶︎ smoke: zk private hire pipeline (skips gracefully when unconfigured)"
npx tsx scripts/smoke-zk-e2e.ts

echo "▶︎ smoke: coinflow stellar session"
npx tsx scripts/smoke-coinflow-stellar-e2e.ts

echo "✅ all smokes green"
