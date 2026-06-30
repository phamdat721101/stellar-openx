-- 038_strip_fhe_add_stellar.sql
-- Locks the v3.0.0 Stellar-native schema.
--
-- 1. Drop FHE / EVM columns (idempotent).
-- 2. Add Stellar columns to agents, sellers, paid_calls.
-- 3. Drop legacy check constraints that bake in EVM/FHE semantics.
-- 4. Widen the paid_calls.method check to the new method names.

BEGIN;

-- ─── agents — drop EVM/FHE-era columns ──────────────────────────────────
ALTER TABLE agents
  DROP COLUMN IF EXISTS accept_private_payment,
  DROP COLUMN IF EXISTS fhe_permit_hash,
  DROP COLUMN IF EXISTS arbitrum_tx_hash,
  DROP COLUMN IF EXISTS phala_attestation_hash,
  DROP COLUMN IF EXISTS chain,
  DROP COLUMN IF EXISTS kya_required,
  DROP COLUMN IF EXISTS verification_tier;

-- Add Stellar columns
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS soroban_agent_id      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stellar_tx_hash       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stellar_payout_address VARCHAR(56);

CREATE INDEX IF NOT EXISTS agents_soroban_id_idx ON agents (soroban_agent_id);

-- ─── agents — drop legacy constraints that block Stellar publishes ──────
-- The marketplace v3.0.0 stores agents with no brain_id and kind='api'/'public';
-- the legacy constraints assumed Fhenix-mode + brain-or-public + slug ≤30 chars.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_brain_or_public_chk';
  EXECUTE 'ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check';
  EXECUTE 'ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_privacy_mode_check';
  EXECUTE 'ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_slug_check';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Widen slug to 3-40 chars to match the new sellerPublishService.
ALTER TABLE agents
  ADD CONSTRAINT agents_slug_check
  CHECK (slug ~ '^[a-z0-9-]{3,40}$') NOT VALID;

-- Make privacy_mode default safe under any remaining check.
ALTER TABLE agents ALTER COLUMN privacy_mode SET DEFAULT 'off';

-- ─── sellers ────────────────────────────────────────────────────────────
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS stellar_account_id VARCHAR(56);

-- ─── paid_calls ─────────────────────────────────────────────────────────
ALTER TABLE paid_calls
  ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS stellar_tx_hash VARCHAR(64);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'paid_calls' AND constraint_name = 'paid_calls_method_check'
  ) THEN
    ALTER TABLE paid_calls DROP CONSTRAINT paid_calls_method_check;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

ALTER TABLE paid_calls
  ADD CONSTRAINT paid_calls_method_check
  CHECK (method IN ('stellar_x402', 'privacy_pool', 'credit', 'free', 'demo'));

-- ─── chain_ops_queue (legacy gasless EVM relayer) ──────────────────────
DROP TABLE IF EXISTS chain_ops_queue CASCADE;

COMMIT;
