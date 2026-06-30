-- 030_task_uploads_unlimited.sql — lift size cap + reconcile schema drift.
--
-- Two jobs:
--
--   1. Lift the 50 MB hard ceiling that 029 baked into the column. Upload
--      policy is now an API-level concern (`UPLOAD_MAX_BYTES` env, default
--      0 = unlimited), so the DB only enforces the non-empty invariant.
--
--   2. Backfill columns that may be missing on deployments where an earlier
--      revision of 029 created the table without them. Root cause of the
--      production "upload mint failed" 500: an older 029 created
--      `task_uploads` without `uploader_addr`, and `CREATE TABLE IF NOT
--      EXISTS` is a no-op on re-run — the column never gets added. This
--      migration uses `ADD COLUMN IF NOT EXISTS` so it converges on the
--      canonical 029 schema regardless of which revision created the table.
--
-- Fully idempotent. Safe to re-apply.

-- ── 1. lift size ceiling ────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'task_uploads'
       AND constraint_name = 'task_uploads_size_bytes_check'
  ) THEN
    ALTER TABLE task_uploads DROP CONSTRAINT task_uploads_size_bytes_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'task_uploads'
       AND constraint_name = 'task_uploads_size_bytes_positive'
  ) THEN
    ALTER TABLE task_uploads
      ADD CONSTRAINT task_uploads_size_bytes_positive
      CHECK (size_bytes > 0);
  END IF;
END $$;

-- ── 2. reconcile schema drift (idempotent ADD COLUMN IF NOT EXISTS) ─────
ALTER TABLE task_uploads
  ADD COLUMN IF NOT EXISTS uploader_addr TEXT NULL;

ALTER TABLE task_uploads
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ NULL;

ALTER TABLE task_uploads
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL
  DEFAULT (NOW() + INTERVAL '24 hours');

-- The Supabase Storage migration introduced `storage_path` to replace the
-- legacy Walrus blob-id reference. Older deploys (Walrus-era 029) created
-- the table with `walrus_blob_id NOT NULL` and no `storage_path` at all.
-- Add the new column and drop the legacy NOT NULL so the new INSERT path
-- can succeed without touching the legacy column. Legacy rows keep their
-- walrus_blob_id; new rows write storage_path only.
ALTER TABLE task_uploads
  ADD COLUMN IF NOT EXISTS storage_path TEXT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'task_uploads'
       AND column_name = 'walrus_blob_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE task_uploads ALTER COLUMN walrus_blob_id DROP NOT NULL;
  END IF;
END $$;

-- Indexes are CREATE INDEX IF NOT EXISTS in 029 already, but re-asserting
-- here protects against the same kind of drift on the index side.
CREATE INDEX IF NOT EXISTS task_uploads_agent_idx
  ON task_uploads(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_uploads_expires_idx
  ON task_uploads(expires_at)
  WHERE consumed_at IS NULL;
