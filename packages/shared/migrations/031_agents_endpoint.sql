-- 031_agents_endpoint.sql — Level-2 self-hosted agent endpoints.
--
-- When `agents.endpoint_url` is set, the API dispatches paid + free calls
-- to the seller's HTTP endpoint instead of running RAG + Bedrock locally.
-- Sellers get full control over inference (any LLM, any tools, any
-- sandbox); OpenX keeps owning discovery + payment routing + the {answer,
-- artifacts} contract on the wire.
--
-- The column is NULL by default → every existing agent stays on the
-- platform-hosted path. Single SQL column, single source of truth.
--
-- CHECK constraint enforces http(s):// format at the DB level so a bad
-- INSERT can't slip past the API. Runtime SSRF guards (no private IPs,
-- no link-local, etc.) live in the dispatcher. Idempotent.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS endpoint_url TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'agents'
       AND constraint_name = 'agents_endpoint_url_format'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_endpoint_url_format
      CHECK (endpoint_url IS NULL OR endpoint_url ~ '^https?://[^[:space:]]+$');
  END IF;
END $$;
