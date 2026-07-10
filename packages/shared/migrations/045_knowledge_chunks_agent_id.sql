-- 045_knowledge_chunks_agent_id.sql — fix `column "agent_id" does not exist`
-- on the training pipeline's Learn-Stellar step (PRD-T-S S2).
--
-- Root cause: `knowledge_chunks` was created in 001_init.sql for the legacy
-- brain-based memory model (`brain_id INT NOT NULL REFERENCES brains`).
-- `KnowledgeIngestService` was rewritten for v3.0.0 to store knowledge
-- per-agent (`INSERT INTO knowledge_chunks (agent_id, ...)`), but no
-- migration ever added the column — `brain_id` stayed NOT NULL, so the table
-- could never accept an agent-scoped row even after adding `agent_id`.
--
-- Fix: make the legacy `brain_id` optional and add `agent_id UUID` alongside
-- it. Both columns coexist — old brain-scoped rows keep `brain_id`, new
-- agent-scoped rows (from training/KnowledgeIngestService) use `agent_id`.
--
-- Additive + idempotent; safe to re-run. Reverse: DROP COLUMN agent_id and
-- restore `brain_id SET NOT NULL` (only safe if no agent-scoped rows exist).

BEGIN;

ALTER TABLE knowledge_chunks ALTER COLUMN brain_id DROP NOT NULL;

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_chunks_agent ON knowledge_chunks(agent_id);

COMMIT;
