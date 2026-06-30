-- 036_seller_async_callback.sql
--
-- Sellers whose pipelines can't answer synchronously (e.g. multi-minute LLM
-- workflows) can now return {status:"pending"} and deliver the final answer
-- later via a callback URL. This adds two columns to agent_tasks:
--
--   external_task_id — short opaque token the seller sees + echoes back
--                      when calling /deliver. UNIQUE so we can look it up
--                      directly without a separate table.
--   seller_task_token — HMAC(OPENX_WEBHOOK_SECRET, external_task_id), used
--                      as a bearer token in the deliver POST. Stored so we
--                      can constant-time-compare on incoming callbacks.

BEGIN;

ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS external_task_id  TEXT,
  ADD COLUMN IF NOT EXISTS seller_task_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_external_idx
  ON agent_tasks (external_task_id)
  WHERE external_task_id IS NOT NULL;

COMMIT;
