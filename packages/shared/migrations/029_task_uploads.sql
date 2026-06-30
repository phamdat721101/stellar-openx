-- 029_task_uploads.sql — workspace upload references for /agent/:id/run.
--
-- Tracks signed Supabase Storage objects that buyers attach to a free
-- /v3/agents/:id/try call OR a paid /api/v1/<slug> call. Files live in
-- bucket `task-uploads`; this row is the authoritative reference.
--
-- Lifecycle:
--   1. POST /v3/agents/:id/uploads   → row inserted, signed PUT URL minted
--   2. Client PUTs file              → object lands in bucket (status outside DB)
--   3. POST /try OR /api/v1/<slug>   → run reads `consumed_at = NOW()`
--   4. expires_at default = 24h      → cron-style cleanup script can purge
--
-- Idempotent (CREATE … IF NOT EXISTS). 50 MB hard ceiling enforced at the
-- column level so the API can't accidentally bypass it. Index on
-- (expires_at) WHERE consumed_at IS NULL targets the cleanup query only.

CREATE TABLE IF NOT EXISTS task_uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  uploader_addr   TEXT NULL,                              -- nullable for anon /try
  storage_path    TEXT NOT NULL,                          -- e.g. <agent>/<id>/<sanitized-name>
  original_name   TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at     TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS task_uploads_agent_idx
  ON task_uploads(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_uploads_expires_idx
  ON task_uploads(expires_at)
  WHERE consumed_at IS NULL;
