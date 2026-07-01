-- 039_zk_commitment.sql
--
-- Path B' (server-verified ZK) replay protection.
--
-- The private-tier gate accepts a Groth16 proof whose public signals include
-- a Poseidon commitment (`publicSignals[0]`). We record it here to reject
-- reuse — same commitment across two hires would let a buyer pay once and
-- prove twice. Nullable + unique-when-present so legacy public-tier rows
-- stay untouched.

ALTER TABLE paid_calls
  ADD COLUMN IF NOT EXISTS zk_commitment TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS paid_calls_zk_commitment_uidx
  ON paid_calls (zk_commitment)
  WHERE zk_commitment IS NOT NULL;
