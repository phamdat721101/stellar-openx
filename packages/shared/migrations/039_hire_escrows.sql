-- 039_hire_escrows.sql — PRD-T (Escrow-Protected Hire Tier via Trustless Work).
--
-- Mirrors the on-chain single-release escrow lifecycle deployed by Trustless
-- Work into a Supabase table so the UI, gate, and cron can reason about
-- state transitions cheaply without hitting the TW API on every read.
--
-- Statuses (one-way transitions enforced in code):
--   deploying → funded → answered → approved → released
--                                 ↘ disputed → resolved (or refunded)
--
-- SOLID:
--   • SRP — this table only tracks escrow lifecycle. Chain trust anchor is
--     the on-chain contract; this table is the analytics + UX surface.

CREATE TABLE IF NOT EXISTS hire_escrows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address  TEXT UNIQUE NOT NULL,
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,
  buyer_address     TEXT NOT NULL,
  seller_address    TEXT NOT NULL,
  question          TEXT,
  answer            TEXT,
  amount_usdc       NUMERIC(20,7) NOT NULL,
  platform_fee_bps  INT NOT NULL DEFAULT 500,
  status            TEXT NOT NULL CHECK (status IN (
    'deploying', 'funded', 'answered',
    'approved', 'released',
    'disputed', 'resolved', 'refunded'
  )),
  deploy_tx_hash    TEXT,
  fund_tx_hash      TEXT,
  approve_tx_hash   TEXT,
  release_tx_hash   TEXT,
  dispute_tx_hash   TEXT,
  resolve_tx_hash   TEXT,
  answered_at       TIMESTAMPTZ,
  approved_at       TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  disputed_at       TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  timeout_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hire_escrows_agent_idx  ON hire_escrows (agent_id);
CREATE INDEX IF NOT EXISTS hire_escrows_buyer_idx  ON hire_escrows (buyer_address);
CREATE INDEX IF NOT EXISTS hire_escrows_seller_idx ON hire_escrows (seller_address);
CREATE INDEX IF NOT EXISTS hire_escrows_status_idx ON hire_escrows (status);
CREATE INDEX IF NOT EXISTS hire_escrows_stale_idx  ON hire_escrows (timeout_at)
                                                   WHERE status = 'answered';

-- Auto-bump updated_at on any UPDATE.
CREATE OR REPLACE FUNCTION hire_escrows_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hire_escrows_touch_updated_at ON hire_escrows;
CREATE TRIGGER hire_escrows_touch_updated_at
  BEFORE UPDATE ON hire_escrows
  FOR EACH ROW EXECUTE FUNCTION hire_escrows_touch_updated_at();
