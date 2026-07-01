#!/usr/bin/env bash
#
# scripts/deploy-soroban.sh — build + deploy all OpenX-S Soroban contracts.
#
# Usage:
#   bash scripts/deploy-soroban.sh all testnet
#   bash scripts/deploy-soroban.sh agent-registry testnet
#
# Notes on the build chain (Jun 29 2026):
#   Stellar Soroban testnet currently runs Protocol 22 which only accepts wasm
#   MVP modules. Rust ≥1.82 emits reference-types in std/core for the
#   wasm32-unknown-unknown target by default, so we must:
#     1. use nightly toolchain (for -Z build-std)
#     2. recompile core/alloc/panic_abort with -C target-cpu=mvp
#     3. disable all post-MVP target features
#
# Writes contract ids back to .env.local in the repo root so the API picks
# them up on the next `npm run dev`.

set -euo pipefail

TARGETS="${1:-all}"
NETWORK="${2:-testnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
WORKSPACE="$ROOT/packages/soroban-contracts"
WASM_DIR="$WORKSPACE/target/wasm32-unknown-unknown/release"

if ! command -v stellar >/dev/null 2>&1; then
  echo "stellar CLI not installed. See https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup" >&2
  exit 1
fi
if ! rustup toolchain list 2>/dev/null | grep -q nightly; then
  echo "installing nightly toolchain…"
  rustup install nightly --profile minimal
  rustup component add rust-src --toolchain nightly
fi

case "$NETWORK" in
  testnet) ;;
  mainnet) ;;
  *) echo "Unknown network: $NETWORK" >&2; exit 1 ;;
esac

if [ -n "${STELLAR_PLATFORM_SECRET_KEY:-}" ]; then
  stellar keys add platform --secret-key 2>/dev/null <<< "$STELLAR_PLATFORM_SECRET_KEY" || true
fi
SRC_FLAG="--source platform"

echo "🔨 building soroban contracts (MVP wasm via nightly + build-std)..."
( cd "$WORKSPACE" && \
    RUSTFLAGS="-C target-cpu=mvp -C target-feature=-reference-types,-multivalue,-bulk-memory,-mutable-globals,-sign-ext,-nontrapping-fptoint" \
    cargo +nightly build --release --target wasm32-unknown-unknown \
      -Z build-std=core,alloc,panic_abort \
      --quiet )

set_env() {
  local key="$1" val="$2"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^$key=.*|$key=$val|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}

deploy_one() {
  local crate="$1"
  local key="$2"
  local wasm="$WASM_DIR/$(echo "$crate" | tr - _).wasm"
  [ -f "$wasm" ] || { echo "❌ wasm not found: $wasm" >&2; exit 1; }
  for attempt in 1 2 3; do
    local out id
    out=$(stellar contract deploy --wasm "$wasm" --network "$NETWORK" $SRC_FLAG 2>&1)
    id=$(echo "$out" | grep -oE 'C[A-Z0-9]{55}' | tail -1)
    if [ -n "$id" ]; then
      echo "✅ $crate → $id"
      set_env "$key" "$id"
      sleep 5
      return 0
    fi
    echo "retry $crate (attempt $attempt)…"
    sleep 8
  done
  echo "❌ $crate deploy failed: $out" >&2
  exit 1
}

if [ "$TARGETS" = "all" ]; then
  deploy_one agent-registry   STELLAR_AGENT_REGISTRY_ID
  deploy_one paid-call-ledger STELLAR_PAID_CALL_LEDGER_ID
  deploy_one paywall-router   STELLAR_PAYWALL_ROUTER_ID
  # privacy-pool is consumed as an external cross-contract (Nethermind's
  # audited deployment). Run `bash scripts/deploy-privacy-pool.sh` to pin
  # its addresses into .env.local — no wasm build/deploy needed here.
else
  for t in $TARGETS; do
    case "$t" in
      agent-registry)   deploy_one agent-registry   STELLAR_AGENT_REGISTRY_ID ;;
      paid-call-ledger) deploy_one paid-call-ledger STELLAR_PAID_CALL_LEDGER_ID ;;
      paywall-router)   deploy_one paywall-router   STELLAR_PAYWALL_ROUTER_ID ;;
      *) echo "Unknown target: $t (privacy-pool is external — see scripts/deploy-privacy-pool.sh)" >&2; exit 1 ;;
    esac
  done
fi

echo
echo "🎉 deploys complete; contract ids written to $ENV_FILE"
