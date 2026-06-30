-- 033_public_agents.sql
--
-- PRD-1 — Self-hosted seller agent onboarding fast-path.
-- Adds `kind='public'` enum value + service-signed permit metadata +
-- audit log. Additive only; safe to re-run.
--
-- Reverse: DROP CONSTRAINT agents_brain_or_public_chk;
--          DROP TABLE concierge_publish_events;
--          DROP INDEX agents_public_name_idx;
--          (kind='public' enum value cannot be removed; harmless).

BEGIN;

-- ─── 1. agent_kind enum: add 'public' ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_kind') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum
      WHERE enumtypid = 'agent_kind'::regtype AND enumlabel = 'public'
    ) THEN
      ALTER TYPE agent_kind ADD VALUE 'public';
    END IF;
  END IF;
END$$;

-- Production stores `kind` as a CHECK-constrained VARCHAR instead of an
-- enum. Widen the CHECK to allow 'public' too. Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_kind_check'
       AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents DROP CONSTRAINT agents_kind_check;
  END IF;
  ALTER TABLE agents
    ADD CONSTRAINT agents_kind_check
    CHECK (kind IN ('api', 'workflow', 'skill', 'brain', 'public'));
END$$;

-- ─── 2. agents: relax brain_id + add public-agent columns ──────────────────
ALTER TABLE agents
  ALTER COLUMN brain_id DROP NOT NULL;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS service_signed_permit_hash   VARCHAR(66),
  ADD COLUMN IF NOT EXISTS service_key_id               VARCHAR(32),
  ADD COLUMN IF NOT EXISTS lazy_bind_email              VARCHAR(254),
  ADD COLUMN IF NOT EXISTS verification_status          VARCHAR(16)
    NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS last_health_check_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_health_fails     INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_verification_status_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_verification_status_check
      CHECK (verification_status IN ('unverified','verified','degraded','dormant'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_brain_or_public_chk'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_brain_or_public_chk
      CHECK (brain_id IS NOT NULL OR kind = 'public');
  END IF;
END$$;

-- Idempotency: same slug-derived name cannot be re-published while the
-- agent is still wallet-unbound (= still owned by the service wallet).
CREATE UNIQUE INDEX IF NOT EXISTS agents_public_slug_idx
  ON agents (LOWER(slug))
  WHERE kind = 'public';

-- ─── 3. concierge_publish_events: audit trail ──────────────────────────────
CREATE TABLE IF NOT EXISTS concierge_publish_events (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  service_key_id VARCHAR(32) NOT NULL,
  prompt_text TEXT NOT NULL,
  extracted_manifest JSONB NOT NULL,
  llm_model VARCHAR(64) NOT NULL,
  llm_extraction_confidence REAL,
  verification_status VARCHAR(16),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS concierge_publish_events_agent_idx
  ON concierge_publish_events (agent_id);
CREATE INDEX IF NOT EXISTS concierge_publish_events_service_key_idx
  ON concierge_publish_events (service_key_id, created_at DESC);

COMMIT;
