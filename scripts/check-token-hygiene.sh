#!/usr/bin/env bash
# check-token-hygiene.sh — PRD-U regression guard.
#
# Ensures the frontend never regresses back to the legacy emerald/zinc/slate/
# amber/purple/red-hardcoded palette. The Luminous Utility token set
# (packages/frontend/tailwind.config.ts) is the single source of truth; every
# component must consume names like `primary-container`, `on-surface-variant`,
# `outline-variant`.
#
# The legacy UI has been fully removed — the entire frontend now consumes the
# token set, so there is no allowlist. Any legacy palette hit fails CI.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/frontend/src"

PATTERN='(emerald-|zinc-|purple-|amber-|red-4|red-5|red-6|red-7|red-8|red-9|slate-|bg-white\b)'

HITS=$(grep -rEn "$PATTERN" "$SRC" 2>/dev/null | grep -v 'translate-y-\|translate-x-\|top-1/2\|top-2/\|bottom-1/2' || true)

if [ -n "$HITS" ]; then
  echo "❌ token-hygiene FAILED — legacy Tailwind palette hits found:"
  echo "$HITS"
  echo ""
  echo "Fix: consume semantic tokens from tailwind.config.ts instead"
  echo "     (primary-container, on-surface, outline-variant, error, tertiary-container, …)"
  exit 1
fi

echo "✅ token-hygiene passed — no legacy palette hits in the frontend"
