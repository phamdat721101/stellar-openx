#!/usr/bin/env bash
# check-token-hygiene.sh — PRD-U regression guard.
#
# Ensures the frontend never regresses back to the legacy emerald/zinc/slate/
# amber/purple/red-hardcoded palette. The Luminous Utility token set
# (packages/frontend/tailwind.config.ts) is the single source of truth; every
# component must consume names like `primary-container`, `on-surface-variant`,
# `outline-variant`.
#
# Exception: the pre-PRD-U legacy code paths inside `AppShell.tsx` and
# `page.tsx` (guarded by FEATURE_UI_V2=false) are intentionally preserved
# byte-identically for one-release rollback. Those two files are skipped.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/frontend/src"

# Files with intentionally-preserved legacy code paths — allowlisted.
ALLOWLIST=(
  "packages/frontend/src/app/page.tsx"
  "packages/frontend/src/components/AppShell.tsx"
)

PATTERN='(emerald-|zinc-|purple-|amber-|red-4|red-5|red-6|red-7|red-8|red-9|slate-|bg-white\b)'

# Find hits outside the allowlist.
HITS=$(grep -rEn "$PATTERN" "$SRC" 2>/dev/null | grep -v 'translate-y-\|translate-x-\|top-1/2\|top-2/\|bottom-1/2' | grep -v -F "$(printf '%s\n' "${ALLOWLIST[@]}")" || true)

if [ -n "$HITS" ]; then
  echo "❌ token-hygiene FAILED — legacy Tailwind palette hits found:"
  echo "$HITS"
  echo ""
  echo "Fix: consume semantic tokens from tailwind.config.ts instead"
  echo "     (primary-container, on-surface, outline-variant, error, tertiary-container, …)"
  exit 1
fi

echo "✅ token-hygiene passed — no legacy palette hits outside allowlisted legacy paths"
