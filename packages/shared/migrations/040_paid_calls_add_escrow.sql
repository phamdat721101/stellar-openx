-- 040_paid_calls_add_escrow.sql — PRD-T: allow `escrow` as a payment method.
--
-- The `paid_calls` table has a CHECK constraint restricting `method` to the
-- v3.0 set (stellar_x402, privacy_pool, credit, free, demo). PRD-T adds
-- Trustless Work escrow as a fourth on-chain rail; extend the check.

ALTER TABLE paid_calls DROP CONSTRAINT IF EXISTS paid_calls_method_check;
ALTER TABLE paid_calls
  ADD CONSTRAINT paid_calls_method_check
  CHECK (method IN ('stellar_x402', 'privacy_pool', 'escrow', 'credit', 'free', 'demo'));
