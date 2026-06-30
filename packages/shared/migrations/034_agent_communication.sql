-- 034_agent_communication.sql
--
-- PRD-2 — Buyer ↔ Agent communication pipeline (MVP, 4 modes M1-M4).
-- Adds threads, messages, async tasks, and webhook-delivery ledger.
-- Additive only; safe to re-run.

BEGIN;

-- ─── threads: 1 buyer + 1 agent (forward-compatible with multi-agent v2) ───
CREATE TABLE IF NOT EXISTS agent_threads (
  id BIGSERIAL PRIMARY KEY,
  buyer_wallet VARCHAR(42) NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  encryption_tier VARCHAR(32) NOT NULL DEFAULT 'tee-attested-only',
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  message_count INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  origin_paid_call_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_threads_buyer_idx
  ON agent_threads (LOWER(buyer_wallet), last_message_at DESC);
CREATE INDEX IF NOT EXISTS agent_threads_agent_idx
  ON agent_threads (agent_id, last_message_at DESC);

-- ─── messages: every message in every mode (M1, M2, M3, M4) ────────────────
CREATE TABLE IF NOT EXISTS agent_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  sender_type VARCHAR(16) NOT NULL,
  sender_id VARCHAR(64) NOT NULL,
  mode VARCHAR(8) NOT NULL,
  body TEXT NOT NULL,
  tee_attestation_hash VARCHAR(66) NOT NULL,
  payment_event_id BIGINT,
  delivery_status VARCHAR(16) NOT NULL DEFAULT 'sent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_mode_check') THEN
    ALTER TABLE agent_messages
      ADD CONSTRAINT agent_messages_mode_check
      CHECK (mode IN ('m1','m2','m3','m4'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_sender_check') THEN
    ALTER TABLE agent_messages
      ADD CONSTRAINT agent_messages_sender_check
      CHECK (sender_type IN ('buyer','agent','operator','system'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS agent_messages_thread_idx
  ON agent_messages (thread_id, created_at);

-- ─── async tasks (M3) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tasks (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slug VARCHAR(64),
  thread_id BIGINT REFERENCES agent_threads(id) ON DELETE SET NULL,
  buyer_wallet VARCHAR(42) NOT NULL,
  payload JSONB NOT NULL,
  webhook_url TEXT,
  status VARCHAR(16) NOT NULL,
  result JSONB,
  tee_attestation_hash VARCHAR(66),
  paid_call_id BIGINT,
  estimated_completion_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tasks_status_check') THEN
    ALTER TABLE agent_tasks
      ADD CONSTRAINT agent_tasks_status_check
      CHECK (status IN ('pending','running','complete','failed'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS agent_tasks_status_idx ON agent_tasks (status, created_at);
CREATE INDEX IF NOT EXISTS agent_tasks_buyer_idx
  ON agent_tasks (LOWER(buyer_wallet), created_at DESC);

-- ─── webhook deliveries with retry/DLQ ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT REFERENCES agent_tasks(id) ON DELETE CASCADE,
  destination_url TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,
  hmac_signature VARCHAR(132) NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_response_code INT,
  last_response_body TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_webhook_deliveries_status_check') THEN
    ALTER TABLE agent_webhook_deliveries
      ADD CONSTRAINT agent_webhook_deliveries_status_check
      CHECK (status IN ('pending','delivered','failed','dead_letter'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS agent_webhook_deliveries_due_idx
  ON agent_webhook_deliveries (status, next_retry_at);

-- ─── per-agent communication policy (M4 microbill price etc.) ──────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS communication_policy JSONB
    NOT NULL DEFAULT '{"buyer_message_price_usdc": 0.001}'::jsonb;

COMMIT;
