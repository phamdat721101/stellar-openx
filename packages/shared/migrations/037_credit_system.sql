-- 037_credit_system.sql — buyer credit accounts + ledger + seller balances
--
-- Per PRD-G. Three additive tables, one idempotent backfill, zero changes
-- to existing tables. Safe to re-run.
--
-- SOLID:
--   * SRP — schema for the credit system only. paid_calls keeps its job.
--   * OCP — `credit_ledger.kind` is the extension point; new event types
--     are CHECK-list entries, no schema migration needed.
--
-- Rollback (only if flag-off plus DB-clean rollback is required):
--   DROP TABLE IF EXISTS credit_ledger;
--   DROP TABLE IF EXISTS credit_accounts;
--   DROP TABLE IF EXISTS seller_balances;
-- Existing tables are NEVER touched, so flag-off rollback alone is enough.

-- 1) Buyer credit accounts. Keyed by Privy user (Sybil-resistant); wallet
--    is denormalised for non-Privy fallback + display. Lazy welcome grant
--    happens on first authenticated request — see services/creditService.ts.
CREATE TABLE IF NOT EXISTS credit_accounts (
  id                BIGSERIAL PRIMARY KEY,
  privy_user_id     TEXT UNIQUE,            -- null until buyer surfaces a Privy token
  wallet_address    TEXT UNIQUE NOT NULL,   -- lowercased
  balance_usdc      NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (balance_usdc >= 0),
  welcome_granted   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_accounts_privy_idx
  ON credit_accounts (privy_user_id)
  WHERE privy_user_id IS NOT NULL;

-- 2) Append-only ledger. Every grant/spend/payout/refund writes one row.
--    `tx_hash` carries the on-chain hash for purchase + payout rows, a
--    synthetic `credit-<id>` for spends, and NULL for welcome grants.
--    UNIQUE(kind, tx_hash) makes top-up and payout retries idempotent.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
  kind          TEXT   NOT NULL CHECK (kind IN ('welcome','purchase','spend','refund','payout')),
  amount_usdc   NUMERIC(18,6) NOT NULL,        -- signed: +grant/+refund, -spend/-payout
  agent_id      UUID   REFERENCES agents(id) ON DELETE SET NULL,
  tx_hash       TEXT,
  network       TEXT,
  meta          JSONB  NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_ledger_account_idx
  ON credit_ledger (account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_kind_txhash_uidx
  ON credit_ledger (kind, tx_hash)
  WHERE tx_hash IS NOT NULL;

-- 3) Seller accrual + withdraw bookkeeping. One row per seller.
CREATE TABLE IF NOT EXISTS seller_balances (
  seller_id        BIGINT PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  accrued_usdc     NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (accrued_usdc >= 0),
  withdrawn_usdc   NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (withdrawn_usdc >= 0),
  last_withdraw_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4) Backfill: every wallet ever seen gets an account row WITHOUT the
--    welcome grant. The grant fires on first authenticated request once
--    we know the Privy user id (so the bonus is Sybil-resistant).
INSERT INTO credit_accounts (wallet_address)
SELECT DISTINCT lower(buyer) FROM paid_calls
 WHERE buyer IS NOT NULL AND buyer <> 'anonymous'
UNION
SELECT DISTINCT lower(wallet_address) FROM sellers
ON CONFLICT (wallet_address) DO NOTHING;
