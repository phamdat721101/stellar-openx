-- 028_agent_archive.sql
--
-- Soft-archive flag for agents. Sellers hide assistants they no longer
-- want to operate; the row stays so paid_calls.agent_id foreign keys
-- (ON DELETE CASCADE in migration 007) keep buyer receipts resolving.
--
-- Marketplace listings, /v3/discover (via loadCorpus), and the seller
-- dashboard's active list filter on `archived_at IS NULL`. Restore is
-- a single UPDATE that sets `archived_at = NULL`. No data loss.
--
-- Note on chain mirror: the `KnowledgeBaseRegistryV2` row on Arbitrum
-- stays after archive. Archive is a marketplace-visibility flag only —
-- on-chain unpublish is a separate, future operation.
--
-- Idempotent. Safe to re-run.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

-- Partial index — every "active agent" lookup (listings, workflows,
-- discover corpus) hits this. Archived rows are skipped at the planner.
CREATE INDEX IF NOT EXISTS agents_active_idx
  ON agents (id) WHERE archived_at IS NULL;

-- Companion: seller dashboard filters by owner + active.
CREATE INDEX IF NOT EXISTS agents_owner_active_idx
  ON agents (owner_address) WHERE archived_at IS NULL;
