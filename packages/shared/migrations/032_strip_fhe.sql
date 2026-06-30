-- 032_strip_fhe.sql
--
-- PRD-F (homepage simplification + FHE strip) — Hard cutover per Q4=a.
-- Drops the FHE/encryption columns + relaxes the chain/rail/privacy CHECK
-- constraints so the app can stop emitting Fhenix-specific values.
--
-- Idempotent: every clause uses IF EXISTS / IF NOT EXISTS. Second run = no-op.
-- Reversible only via pg_dump — take a backup before running on production.

BEGIN;

-- ─── agents ────────────────────────────────────────────────────────────────
-- Relax chain to allow only the EVM rails we still ship. Anything still
-- written as 'fhenix' is rewritten to 'arbitrum-sepolia' (the FHE deploy
-- targeted Arbitrum Sepolia anyway, so this is a safe collapse).
UPDATE agents SET chain = 'arbitrum-sepolia' WHERE chain = 'fhenix';

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_chain_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_chain_check
  CHECK (chain IN ('arbitrum-sepolia', 'base-sepolia'));

-- Drop the FHE privacy mode. The remaining modes are 'metadata-only' + 'off';
-- existing 'fhe' rows collapse to 'off' (no special path anymore).
UPDATE agents SET privacy_mode = 'off' WHERE privacy_mode = 'fhe';

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_privacy_mode_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_privacy_mode_check
  CHECK (privacy_mode IN ('metadata-only', 'off'));

-- ─── brains: drop encryption columns (per Q4=a hard cutover) ──────────────
ALTER TABLE brains DROP COLUMN IF EXISTS ciphertext;
ALTER TABLE brains DROP COLUMN IF EXISTS iv;
ALTER TABLE brains DROP COLUMN IF EXISTS wrap_handle;

ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS ciphertext;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS iv;

-- ─── auth token ledger rename ─────────────────────────────────────────────
-- Permits → tokens. Same shape, new name reflects the post-rename auth header.
ALTER TABLE IF EXISTS onboard_permits_spent RENAME TO openx_tokens_spent;

COMMIT;
