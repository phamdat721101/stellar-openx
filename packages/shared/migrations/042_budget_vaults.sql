-- 042_budget_vaults.sql — PRD-M2 (BudgetVault deposit-once-hire-many tier).
--
-- Table `budget_vaults` mirrors the on-chain Soroban BudgetVault contract:
-- one row per deployed vault contract. Off-chain analytics + UX surface
-- only — trust anchor is the Soroban contract (see budget-vault crate).
--
-- Life-cycle (mirrored in `status` column):
--   deploying  ─▶  active  ─▶  paused  ─▶  active  ─▶  closed
--
-- `paid_calls.vault_id` FK: NULL for direct-x402/private/escrow hires,
-- non-null when the hire consumed vault balance via the `budget_vault`
-- method.
--
-- Additive migration only. No destructive schema changes. Every DDL is
-- idempotent so re-running is safe.
--
-- SOLID (SRP): this file owns the BudgetVault mirror schema. On-chain
-- state lives in Soroban; this table is the analytics + UX surface.

CREATE TABLE IF NOT EXISTS budget_vaults (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_address     TEXT NOT NULL,
  contract_address  TEXT UNIQUE NOT NULL,                                -- Soroban C-address after deploy
  asset_code        TEXT NOT NULL,                                       -- 'USDC' | 'MGUSD' | 'TMGUSD'
  sac_contract      TEXT NOT NULL,                                       -- SEP-41 SAC address (denormalised for read-hot paths)
  network           TEXT NOT NULL CHECK (network IN ('testnet','mainnet')),
  total_cap         NUMERIC(20,7),                                       -- NULL = unlimited
  per_hire_cap      NUMERIC(20,7),                                       -- NULL = no per-hire cap
  allowlist_mode    TEXT NOT NULL CHECK (allowlist_mode IN ('any','slugs','sellers')),
  allowlist         JSONB NOT NULL DEFAULT '[]'::jsonb,                  -- ["slug1","slug2"] or ["G…","G…"]
  balance_cache     NUMERIC(20,7),                                       -- last known on-chain balance (60s TTL)
  balance_cached_at TIMESTAMPTZ,
  total_spent       NUMERIC(20,7) NOT NULL DEFAULT 0,
  hire_count        INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'deploying'
                    CHECK (status IN ('deploying','active','paused','closed')),
  auto_topup        JSONB NOT NULL DEFAULT '{"enabled":false}'::jsonb,   -- reserved for v0.31 M2.6
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS budget_vaults_buyer_idx    ON budget_vaults (buyer_address);
CREATE INDEX IF NOT EXISTS budget_vaults_status_idx   ON budget_vaults (status);
CREATE INDEX IF NOT EXISTS budget_vaults_network_idx  ON budget_vaults (network);
CREATE INDEX IF NOT EXISTS budget_vaults_contract_idx ON budget_vaults (contract_address);

-- Auto-bump updated_at on any UPDATE (mirrors the pattern used by hire_escrows).
CREATE OR REPLACE FUNCTION budget_vaults_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_vaults_touch_updated_at ON budget_vaults;
CREATE TRIGGER budget_vaults_touch_updated_at
  BEFORE UPDATE ON budget_vaults
  FOR EACH ROW EXECUTE FUNCTION budget_vaults_touch_updated_at();

-- Extend paid_calls with the vault FK — nullable so direct-x402/private/escrow
-- hires carry NULL (unchanged behaviour for every pre-v0.30 rail).
ALTER TABLE paid_calls
  ADD COLUMN IF NOT EXISTS vault_id UUID REFERENCES budget_vaults(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS paid_calls_vault_idx ON paid_calls (vault_id) WHERE vault_id IS NOT NULL;

-- Extend the `method` enum to include 'budget_vault'. Additive only.
ALTER TABLE paid_calls DROP CONSTRAINT IF EXISTS paid_calls_method_check;
ALTER TABLE paid_calls
  ADD CONSTRAINT paid_calls_method_check
  CHECK (method IN ('stellar_x402','privacy_pool','escrow','budget_vault','credit','free','demo'));
