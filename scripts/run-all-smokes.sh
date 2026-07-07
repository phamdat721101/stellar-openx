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

echo "▶︎ smoke: trustless-work escrow (PRD-T)"
npx tsx scripts/smoke-trustless-escrow-e2e.ts

# v0.30 — MGUSD × x402 v2 + BudgetVault suites gated behind RUN_MGUSD=1
# so CI stays green when the M0 testnet faucet is unavailable.
if [ "${RUN_MGUSD:-0}" = "1" ]; then
  echo "▶︎ smoke: MGUSD × x402 v2 challenge shape (PRD-M1)"
  npx tsx scripts/smoke-mgusd-x402-e2e.ts

  if [ -f scripts/smoke-budget-vault-e2e.ts ]; then
    echo "▶︎ smoke: BudgetVault deposit → hire → withdraw (PRD-M2)"
    npx tsx scripts/smoke-budget-vault-e2e.ts
  fi
fi

# v0.31 — BudgetVault yield-rewards (PRD-N) gated behind RUN_YIELD=1.
# Pure math kernel + HTTP route shape assertions — no on-chain funds required.
if [ "${RUN_YIELD:-0}" = "1" ]; then
  if [ -f scripts/smoke-vault-rewards-e2e.ts ]; then
    echo "▶︎ smoke: BudgetVault yield-rewards (PRD-N)"
    npx tsx scripts/smoke-vault-rewards-e2e.ts
  fi
fi

echo "✅ all smokes green"
