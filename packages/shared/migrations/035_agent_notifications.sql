-- 035_agent_notifications.sql
--
-- Adds a per-agent notification webhook so sellers learn about buyer
-- activity (paid calls + M4 messages) in real time. Additive; safe to
-- re-run.

BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS notification_webhook_url TEXT;

COMMENT ON COLUMN agents.notification_webhook_url IS
  'Optional HTTPS URL where OpenX POSTs event notifications (paid calls + buyer messages). Body is HMAC-signed with x-openx-signature; idempotency key in x-openx-delivery-id. Use this to mirror OpenX activity into your own inbox/Slack/email.';

COMMIT;
