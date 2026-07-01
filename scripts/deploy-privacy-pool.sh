#!/usr/bin/env bash
#
# scripts/deploy-privacy-pool.sh — idempotent env-writer for the ZK tier.
#
# The Privacy Pool premium tier consumes Nethermind's audited external
# deployment (see docs/runbooks/ZK_DEPLOY.md). This script does NOT deploy
# any wasm — it just pins the operator-chosen Nethermind addresses into
# .env.local so the API + FE pick them up on next boot.
#
# Usage:
#   bash scripts/deploy-privacy-pool.sh testnet          # native XLM pool
#   bash scripts/deploy-privacy-pool.sh testnet eurc     # EURC pool
#   bash scripts/deploy-privacy-pool.sh testnet custom \
#     POOL=C... TOKEN=C... ASP=C... ASP_NM=C... VERIFIER=C...
#
# Idempotent: re-runs replace the existing values in-place.

set -euo pipefail

NETWORK="${1:-testnet}"
POOL_CHOICE="${2:-native}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

case "$NETWORK" in
  testnet)
    # Source of truth: NethermindEth/stellar-private-payments
    # deployments/testnet/deployments.json (Jun 2026 snapshot).
    ASP="CAN4INFN4G3Z265I5DNUBLW3B2NJW2VBLKVWSVMX3MNJNDUEXI7QETAZ"
    ASP_NM="CDXYPQEC3VP5C5MYICD3J66TAVPVDVY5WCYB43APXOB2BCZPB6YDNDBW"
    VERIFIER="CBDFLMVYC7YNMGVYNCSNNAOYBKUWFG4CFSOGY6JM6K77YIECZFWJXHK5"
    case "$POOL_CHOICE" in
      native)
        POOL="CDRC5PLTTIIC7KJ4MFEE3NMLQ3YFWDX4GFPVT4ONMIDJC3KGRWLNFC2Z"
        TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
        ;;
      eurc)
        POOL="CAFK5WKEZ257GWJP6A2PCLTOS4443D5K3H6YUODGCKNRGYHYNNEPO2QA"
        TOKEN="CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ"
        ;;
      custom)
        # Read from remaining KEY=VAL args.
        shift 2 || true
        for kv in "$@"; do
          case "$kv" in
            POOL=*)     POOL="${kv#POOL=}" ;;
            TOKEN=*)    TOKEN="${kv#TOKEN=}" ;;
            ASP=*)      ASP="${kv#ASP=}" ;;
            ASP_NM=*)   ASP_NM="${kv#ASP_NM=}" ;;
            VERIFIER=*) VERIFIER="${kv#VERIFIER=}" ;;
            *) echo "unknown override: $kv" >&2; exit 1 ;;
          esac
        done
        ;;
      *) echo "pool choice: native | eurc | custom (got: $POOL_CHOICE)" >&2; exit 1 ;;
    esac
    ;;
  mainnet)
    echo "mainnet ZK tier not yet audited — refuse to pin addresses" >&2
    exit 1
    ;;
  *) echo "network must be testnet | mainnet (got: $NETWORK)" >&2; exit 1 ;;
esac

set_env() {
  local key="$1" val="$2"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s|^$key=.*|$key=$val|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}

touch "$ENV_FILE"
set_env STELLAR_PRIVACY_POOL_ID          "$POOL"
set_env STELLAR_PRIVACY_POOL_TOKEN_ID    "$TOKEN"
set_env STELLAR_ASP_MEMBERSHIP_ID        "$ASP"
set_env STELLAR_ASP_NON_MEMBERSHIP_ID    "$ASP_NM"
set_env STELLAR_GROTH16_VERIFIER_ID      "$VERIFIER"
set_env STELLAR_ZK_POOL_LEVELS           "10"
set_env NEXT_PUBLIC_PRIVACY_POOL_ID      "$POOL"
set_env NEXT_PUBLIC_PRIVACY_POOL_TOKEN_ID "$TOKEN"

echo "✅ Privacy Pool tier pinned in $ENV_FILE ($NETWORK, $POOL_CHOICE)"
echo "   pool             $POOL"
echo "   pool token       $TOKEN"
echo "   asp membership   $ASP"
echo "   asp non-member   $ASP_NM"
echo "   verifier         $VERIFIER"
echo
echo "Next: host circuit assets under packages/frontend/public/circuits/"
echo "      and seed the ASP allowlist — see docs/runbooks/ZK_DEPLOY.md"
