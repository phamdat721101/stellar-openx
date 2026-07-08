/**
 * uiFlags — single source of truth for frontend feature flags.
 *
 * PRD-U (2026-07-08). `NEXT_PUBLIC_*` env vars are compile-time inlined by
 * Next.js so the boolean is identical on server + client → no hydration
 * mismatch. Read once, export as a constant; consumers import the constant
 * rather than reading env in-place (SRP + easier to override in tests).
 */

export const FEATURE_UI_V2: boolean =
  process.env.NEXT_PUBLIC_FEATURE_UI_V2 === 'true';
