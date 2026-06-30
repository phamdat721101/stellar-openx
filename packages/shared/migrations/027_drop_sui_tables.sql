-- 027_drop_sui_tables.sql
--
-- OpenX v2.0 relaunch — drops every Sui / Walrus / MemWal / Tatum table
-- created by migrations 011, 012, 016–021. Adds `brains.payload_status`
-- so migrated rows from `scripts/migrate-to-supabase.ts` can advertise
-- "needs_reupload" to the seller dashboard until the creator re-uploads
-- their knowledge pack to Supabase Storage.
--
-- Idempotent — uses IF EXISTS for tables, columns, and indexes alike.
-- Safe to re-run in any environment.

BEGIN;

-- ─── MemWal-tier tables (migrations 016-021) ─────────────────────────────
DROP TABLE IF EXISTS memwal_accounts                  CASCADE;
DROP TABLE IF EXISTS memwal_delegate_keys             CASCADE;
DROP TABLE IF EXISTS memwal_marketplace_brains        CASCADE;
DROP TABLE IF EXISTS memwal_paid_queries              CASCADE;
DROP TABLE IF EXISTS memwal_fhe_envelope_logs         CASCADE;
DROP TABLE IF EXISTS memwal_revenue_settlements       CASCADE;
DROP TABLE IF EXISTS memwal_namespaces                CASCADE;
DROP TABLE IF EXISTS memwal_recall_log                CASCADE;
DROP TABLE IF EXISTS memwal_remember_log              CASCADE;

-- ─── Walrus + Sui-identity tables (migrations 011, 012) ──────────────────
DROP TABLE IF EXISTS sui_identity_bindings            CASCADE;
DROP TABLE IF EXISTS sui_identity_binding_attestations CASCADE;
DROP TABLE IF EXISTS brain_walrus_blobs               CASCADE;
DROP TABLE IF EXISTS brain_walrus_renewal             CASCADE;
DROP TABLE IF EXISTS walrus_quilt_batches             CASCADE;
DROP TABLE IF EXISTS trustless_brains                 CASCADE;
DROP TABLE IF EXISTS reflective_traces                CASCADE;

-- ─── Tatum bridge tables (no migration number; created at boot) ──────────
DROP TABLE IF EXISTS tatum_webhook_events             CASCADE;
DROP TABLE IF EXISTS tatum_paid_queries               CASCADE;
DROP TABLE IF EXISTS tatum_subscriptions              CASCADE;

-- ─── brains: drop Sui mirror columns, add payload_status ─────────────────
ALTER TABLE brains DROP COLUMN IF EXISTS sui_object_id;
ALTER TABLE brains DROP COLUMN IF EXISTS walrus_blob_id;
ALTER TABLE brains DROP COLUMN IF EXISTS memwal_namespace;
ALTER TABLE brains DROP COLUMN IF EXISTS seal_policy_id;
ALTER TABLE brains DROP COLUMN IF EXISTS trustless_tier_data;

ALTER TABLE brains
  ADD COLUMN IF NOT EXISTS payload_status TEXT NOT NULL DEFAULT 'active';

-- Consume the migrate-to-supabase.ts marker IFF a `metadata` JSONB column
-- exists (newer schemas may not have it). Wrapped in a DO block so the
-- migration is portable across both shapes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'brains' AND column_name = 'metadata'
  ) THEN
    UPDATE brains
       SET payload_status = 'needs_reupload'
     WHERE metadata ->> 'payload_status' = 'needs_reupload';
    UPDATE brains
       SET metadata = metadata - 'payload_status'
     WHERE metadata ? 'payload_status';
  END IF;
END$$;

-- ─── agents: drop Sui mirror columns ─────────────────────────────────────
ALTER TABLE agents DROP COLUMN IF EXISTS sui_seller_address;
ALTER TABLE agents DROP COLUMN IF EXISTS on_chain_sui_id;
ALTER TABLE agents DROP COLUMN IF EXISTS sui_publish_tx;

-- ─── chain_ops_queue: collapse chain enum to Arbitrum-only domain ────────
-- (idempotent: the constraint may not exist if migration 026 used a TEXT
--  column without CHECK; that's fine, both forms coexist.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
              WHERE table_name = 'chain_ops_queue' AND constraint_name = 'chain_ops_queue_chain_check') THEN
    ALTER TABLE chain_ops_queue DROP CONSTRAINT chain_ops_queue_chain_check;
  END IF;
END$$;

DELETE FROM chain_ops_queue WHERE chain LIKE 'sui%';

-- ─── paid_calls: drop Sui-only network rows ──────────────────────────────
DELETE FROM paid_calls WHERE network LIKE 'sui%' OR network LIKE 'walrus%';

COMMIT;
