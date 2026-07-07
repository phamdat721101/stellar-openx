-- 043_vault_reward_epochs.sql — PRD-N (BudgetVault v0.31 yield-rewards).
--
-- Table `vault_reward_epochs` records one row per (vault × weekly-epoch)
-- where the platform credits a yield reward into the vault contract via a
-- treasury-signed SAC transfer. The row acts as the SOLE audit trail for
-- the reward stream — mirroring the SOLID pattern where budget_vaults is
-- the read-hot mirror of the Soroban vault, this table is the read-hot
-- mirror of the reward stream.
--
-- Life-cycle (mirrored in `status` column):
--   pending  ─▶  credited      (happy path: reward submitted on-chain)
--   pending  ─▶  skipped       (below min balance threshold)
--   pending  ─▶  capped        (monthly cap already met — reward=0)
--
-- Idempotency contract: UNIQUE (vault_id, epoch_start). Re-running the
-- cron for the same (vault, epoch) is a safe no-op — a row already exists
-- and the ON CONFLICT clause in the writer skips.
--
-- Additive migration only. Every DDL is idempotent so re-running is safe.
--
-- SOLID (SRP): this file owns the yield-reward audit schema. On-chain
-- vault balance is the source of truth for BALANCE; this table is the
-- source of truth for REWARD ACCRUAL.

CREATE TABLE IF NOT EXISTS vault_reward_epochs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id              UUID NOT NULL REFERENCES budget_vaults(id) ON DELETE CASCADE,
  epoch_start           TIMESTAMPTZ NOT NULL,
  epoch_end             TIMESTAMPTZ NOT NULL,
  avg_balance_stroops   NUMERIC(30,0) NOT NULL DEFAULT 0,
  apy_bp                INT NOT NULL,                                     -- basis points (800 = 8%)
  reward_stroops        NUMERIC(30,0) NOT NULL DEFAULT 0,
  tx_hash               TEXT,                                             -- Soroban tx hash of the topup transfer
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','credited','skipped','capped')),
  reason                TEXT,                                             -- optional human-readable status reason
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_reward_epochs_vault_epoch_uniq
  ON vault_reward_epochs (vault_id, epoch_start);

CREATE INDEX IF NOT EXISTS vault_reward_epochs_status_idx
  ON vault_reward_epochs (status);

-- Fast per-month aggregate — a plain index on epoch_start supports the
-- WHERE epoch_start >= date_trunc(...) predicate used by getBuyerRewardSummary
-- without requiring an immutable-function expression index.
CREATE INDEX IF NOT EXISTS vault_reward_epochs_epoch_start_idx
  ON vault_reward_epochs (epoch_start);
