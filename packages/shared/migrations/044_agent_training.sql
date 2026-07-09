-- 044_agent_training.sql — PRD-T-S Agent Training Pipeline (S1→S5).
--
-- Turns a newly-onboarded agent into a certified, income-earning operator via
-- a 5-stage sequential unlock:
--   onboarded → learning → skilling → evaluating → certified (+ legacy_certified)
--
-- Schema shape follows the codebase's read-hot-mirror + append-only-audit split
-- (mirrors budget_vaults + vault_reward_epochs, agents + concierge_publish_events):
--   • Fast columns on `agents` — read on every listing/detail fetch for the badge.
--   • `agent_training_events` — append-only audit trail (also stores DGM proposals
--     in `detail` JSONB). The credibility substrate for the OFF-chain-visible cert.
--   • `agent_certifications` — mirror of the ON-chain agent-registry certification.
--   • `seller_raven_auth` — per-seller Raven (WorkOS AuthKit) OAuth token.
--
-- Additive + idempotent; safe to re-run. Reverse: drop the 3 tables + the added
-- agents columns + the CHECK constraint (training_stage default is harmless).

BEGIN;

-- ─── 1. agents: stage + fast cert read columns ─────────────────────────────
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS training_stage    VARCHAR(20) NOT NULL DEFAULT 'onboarded',
  ADD COLUMN IF NOT EXISTS cert_score        REAL,
  ADD COLUMN IF NOT EXISTS certificate_hash  VARCHAR(66),
  ADD COLUMN IF NOT EXISTS certified_at      TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_training_stage_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_training_stage_check
      CHECK (training_stage IN
        ('onboarded','learning','skilling','evaluating','certified','legacy_certified'));
  END IF;
END$$;

-- ─── 2. agent_training_events: append-only audit + DGM proposal store ───────
CREATE TABLE IF NOT EXISTS agent_training_events (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  stage       VARCHAR(20) NOT NULL,             -- stage this event advanced INTO
  event_type  VARCHAR(24) NOT NULL,             -- learn|skill_audit|eval|dgm_proposal|certify|recert
  passed      BOOLEAN,
  score       REAL,
  detail      JSONB NOT NULL DEFAULT '{}',      -- raven entries meta, per-task scores, audit notes, dgm diff
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_training_events_agent_idx
  ON agent_training_events (agent_id, created_at DESC);

-- ─── 3. agent_certifications: mirror of on-chain certify_agent ──────────────
CREATE TABLE IF NOT EXISTS agent_certifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  score         REAL NOT NULL,                  -- mean eval score 0.0-1.0
  cert_hash     VARCHAR(66) NOT NULL,           -- SHA-256 canonical certificate
  tx_hash       TEXT,                           -- Soroban tx hash of certify_agent
  version       INT NOT NULL DEFAULT 1,
  status        VARCHAR(12) NOT NULL DEFAULT 'certified'
                CHECK (status IN ('certified','legacy','revoked')),
  auto_publish  BOOLEAN NOT NULL DEFAULT false, -- opt-in to Raven catalog PR
  raven_pr_url  TEXT,
  certified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days'
);

CREATE INDEX IF NOT EXISTS agent_certifications_agent_idx
  ON agent_certifications (agent_id, certified_at DESC);
CREATE INDEX IF NOT EXISTS agent_certifications_expiry_idx
  ON agent_certifications (expires_at) WHERE status = 'certified';

-- ─── 4. seller_raven_auth: per-seller Raven OAuth token (WorkOS AuthKit) ────
CREATE TABLE IF NOT EXISTS seller_raven_auth (
  owner_address VARCHAR(64) PRIMARY KEY,
  workos_token  TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
