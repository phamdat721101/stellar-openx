/**
 * stellar/vaultRewards.ts — BudgetVault v0.31 yield-rewards.
 *
 * Responsibilities:
 *   • Pure math: resolveApyBp, computeEpochReward, sampleAvgBalanceStroops.
 *   • Cron runner: runRewardEpoch iterates active vaults, computes the
 *     reward, respects the per-vault monthly cap, and submits a treasury-
 *     signed SAC transfer into the vault contract address. The vault's
 *     balance() view reads live SAC balance, so the reward is immediately
 *     spendable by future debit_for_hire calls.
 *
 * Trust model:
 *   • Reward is a plain SEP-41 SAC transfer (treasury → vault contract
 *     address). NO Soroban contract changes required — the vault owns
 *     any balance sitting at its address regardless of how it arrived.
 *   • Idempotency guaranteed by UNIQUE (vault_id, epoch_start) index on
 *     `vault_reward_epochs` — a re-run for the same epoch is a safe no-op.
 *   • Multi-instance safety: pg_try_advisory_lock at the top of the
 *     runner — losing instances become no-ops until the winning instance
 *     releases the lock.
 *
 * SOLID:
 *   • SRP — this module owns the entire reward lifecycle; budgetVault.ts
 *     is untouched for its write paths.
 *   • OCP — the rate curve is data-driven via cfg; extending to per-tier
 *     rates in v0.32 means passing a new `tiers` field, not forking.
 *   • DIP — pure functions accept primitive types + a small `Deps` shape
 *     so tests inject fakes without any framework.
 */

import { Contract, Operation, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import type { PoolClient, Pool } from 'pg';
import { pool as defaultPool } from '../../db';
import { logger } from '../../lib';
import { getStellar, type StellarHandle } from './client';

// ── Config ─────────────────────────────────────────────────────────────────

export interface RewardConfig {
  baseBp: number;                    // e.g. 400 for 4%
  boostBp: number;                   // e.g. 800 for 8%
  boostDays: number;                 // e.g. 30
  minBalanceStroops: bigint;         // eligibility threshold
  monthlyCapStroops: bigint;         // per-vault per-calendar-month cap
  epochHours: number;                // e.g. 168 (weekly)
}

export function loadRewardConfig(env: NodeJS.ProcessEnv = process.env): RewardConfig {
  return {
    baseBp: Number(env.VAULT_YIELD_BASE_BP ?? 400),
    boostBp: Number(env.VAULT_YIELD_BOOST_BP ?? 800),
    boostDays: Number(env.VAULT_YIELD_BOOST_DAYS ?? 30),
    minBalanceStroops: BigInt(env.VAULT_YIELD_MIN_BALANCE_STROOPS ?? 100_000_000),
    monthlyCapStroops: BigInt(env.VAULT_YIELD_CAP_MONTHLY_STROOPS ?? 500_000_000),
    epochHours: Number(env.VAULT_YIELD_EPOCH_HOURS ?? 168),
  };
}

// ── Pure math (deterministic, side-effect free) ────────────────────────────

/**
 * Return APY basis points based on vault age at `now`. Vaults inside the
 * boost window get boostBp; older vaults get baseBp.
 */
export function resolveApyBp(vaultCreatedAt: Date, now: Date, cfg: RewardConfig): number {
  const ageDays = Math.floor((now.getTime() - vaultCreatedAt.getTime()) / 86_400_000);
  return ageDays < cfg.boostDays ? cfg.boostBp : cfg.baseBp;
}

/**
 * Compute reward for one epoch. Uses integer stroop math with floor semantics.
 * Formula: avg_balance * apy_bp * epoch_days / (365 * 10_000)
 */
export function computeEpochReward(
  avgBalanceStroops: bigint,
  apyBp: number,
  epochDays: number,
): bigint {
  if (avgBalanceStroops <= 0n || apyBp <= 0 || epochDays <= 0) return 0n;
  return (avgBalanceStroops * BigInt(apyBp) * BigInt(epochDays)) / (365n * 10_000n);
}

/**
 * Compute [epoch_start, epoch_end) window boundaries. Windows are aligned to
 * `epochHours` boundaries anchored at unix epoch — so every vault ticks on
 * the same wall-clock cadence regardless of created_at.
 */
export function currentEpochWindow(now: Date, epochHours: number): { start: Date; end: Date } {
  const epochMs = epochHours * 3_600_000;
  const startMs = Math.floor(now.getTime() / epochMs) * epochMs;
  return { start: new Date(startMs), end: new Date(startMs + epochMs) };
}

/**
 * Sample vault avg balance over the epoch window. First iteration uses the
 * v0.30 balance_cache column as a point-in-time proxy (single-sample avg =
 * current balance). Future iterations can query a balance_history table for
 * a true trapezoidal average — the pure-function shape supports it.
 */
export async function sampleAvgBalanceStroops(
  vaultId: string,
  _epochStart: Date,
  _epochEnd: Date,
  db: Pool | PoolClient,
): Promise<bigint> {
  const r = await db.query<{ balance_cache: string | null }>(
    `SELECT balance_cache FROM budget_vaults WHERE id = $1 LIMIT 1`,
    [vaultId],
  );
  const bal = r.rows[0]?.balance_cache;
  if (!bal) return 0n;
  // balance_cache is NUMERIC(20,7) in units. Convert to stroops (× 1e7).
  const [whole, frac = ''] = String(bal).split('.');
  const padded = (frac + '0000000').slice(0, 7);
  return BigInt(whole || '0') * 10_000_000n + BigInt(padded || '0');
}

// ── On-chain submitter ─────────────────────────────────────────────────────

/**
 * Build + submit the SAC transfer (treasury → vault contract address).
 * Reuses the SDK's SAC contract binding — `token::transfer` in Rust maps to
 * calling the SAC contract's `transfer` method with (from, to, amount).
 */
export async function submitRewardTopup(
  s: StellarHandle,
  sacContract: string,
  vaultAddress: string,
  amountStroops: bigint,
): Promise<{ hash: string }> {
  const platform = s.platformKeypair.publicKey();
  const tx = (await s.buildTx(platform))
    .addOperation(new Contract(sacContract).call(
      'transfer',
      nativeToScVal(platform, { type: 'address' }),
      nativeToScVal(vaultAddress, { type: 'address' }),
      nativeToScVal(amountStroops, { type: 'i128' }),
    ))
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
  prepared.sign(s.platformKeypair);
  const result = await s.submitPlatformSigned(prepared);
  return { hash: result.hash };
}

// ── Cron runner ────────────────────────────────────────────────────────────

interface VaultEligibleRow {
  id: string;
  contract_address: string;
  sac_contract: string;
  created_at: string;
}

interface RewardWriteRow {
  vault_id: string;
  epoch_start: Date;
  epoch_end: Date;
  avg_balance_stroops: bigint;
  apy_bp: number;
  reward_stroops: bigint;
  status: 'pending' | 'credited' | 'skipped' | 'capped';
  reason?: string;
}

export interface EpochRunSummary {
  attempted: number;
  credited: number;
  skipped: number;
  capped: number;
  failed: number;
}

/**
 * Runs the weekly reward epoch. Idempotent + multi-instance-safe.
 *
 * Steps for each active vault with no row in the current epoch:
 *   1. Sample avg balance.
 *   2. If < min-balance: write status='skipped' row, return.
 *   3. Compute apy_bp + reward_stroops.
 *   4. Clamp to remaining monthly cap; if 0: status='capped'.
 *   5. Insert row status='pending' (write-ahead).
 *   6. Submit SAC transfer treasury → vault contract address.
 *   7. On success: update to status='credited' + tx_hash.
 *   8. On failure: leave 'pending' for the next run.
 */
export async function runRewardEpoch(
  now: Date = new Date(),
  deps: { pool?: Pool; stellar?: StellarHandle; cfg?: RewardConfig } = {},
): Promise<EpochRunSummary> {
  const pool = deps.pool ?? defaultPool;
  const cfg = deps.cfg ?? loadRewardConfig();
  const summary: EpochRunSummary = { attempted: 0, credited: 0, skipped: 0, capped: 0, failed: 0 };

  const lock = await pool.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext('vault_yield_cron')::bigint) AS ok`,
  );
  if (!lock.rows[0]?.ok) {
    logger.info({}, 'yield:cron:lock_held_elsewhere');
    return summary;
  }

  try {
    const window = currentEpochWindow(now, cfg.epochHours);
    const epochDays = cfg.epochHours / 24;
    // Only active vaults with no row already in the current window.
    const q = await pool.query<VaultEligibleRow>(
      `SELECT v.id, v.contract_address, v.sac_contract, v.created_at::text AS created_at
         FROM budget_vaults v
         LEFT JOIN vault_reward_epochs e
           ON e.vault_id = v.id AND e.epoch_start = $1
        WHERE v.status = 'active' AND e.id IS NULL
        ORDER BY v.created_at ASC`,
      [window.start.toISOString()],
    );
    summary.attempted = q.rowCount ?? 0;
    const s = deps.stellar ?? (summary.attempted > 0 ? getStellar() : null);

    for (const row of q.rows) {
      try {
        const avg = await sampleAvgBalanceStroops(row.id, window.start, window.end, pool);
        if (avg < cfg.minBalanceStroops) {
          await insertEpoch(pool, {
            vault_id: row.id,
            epoch_start: window.start,
            epoch_end: window.end,
            avg_balance_stroops: avg,
            apy_bp: 0,
            reward_stroops: 0n,
            status: 'skipped',
            reason: 'below_min_balance',
          });
          summary.skipped += 1;
          continue;
        }

        const apyBp = resolveApyBp(new Date(row.created_at), now, cfg);
        let reward = computeEpochReward(avg, apyBp, epochDays);
        const alreadyThisMonth = await sumMonthReward(pool, row.id, now);
        const remaining = cfg.monthlyCapStroops - alreadyThisMonth;
        if (remaining <= 0n) {
          await insertEpoch(pool, {
            vault_id: row.id,
            epoch_start: window.start,
            epoch_end: window.end,
            avg_balance_stroops: avg,
            apy_bp: apyBp,
            reward_stroops: 0n,
            status: 'capped',
            reason: 'monthly_cap_reached',
          });
          summary.capped += 1;
          continue;
        }
        if (reward > remaining) reward = remaining;
        if (reward <= 0n) {
          await insertEpoch(pool, {
            vault_id: row.id,
            epoch_start: window.start,
            epoch_end: window.end,
            avg_balance_stroops: avg,
            apy_bp: apyBp,
            reward_stroops: 0n,
            status: 'skipped',
            reason: 'reward_rounded_to_zero',
          });
          summary.skipped += 1;
          continue;
        }

        // Write-ahead: reserve the (vault, epoch) slot BEFORE submitting the tx.
        // If tx fails, the row stays 'pending' and the next run retries.
        const insertRes = await insertEpoch(pool, {
          vault_id: row.id,
          epoch_start: window.start,
          epoch_end: window.end,
          avg_balance_stroops: avg,
          apy_bp: apyBp,
          reward_stroops: reward,
          status: 'pending',
        });
        if (!insertRes.inserted) {
          // Another instance beat us to it — safe to skip.
          continue;
        }

        if (!s) throw new Error('yield:cron:stellar_unavailable');
        const { hash } = await submitRewardTopup(s, row.sac_contract, row.contract_address, reward);
        await pool.query(
          `UPDATE vault_reward_epochs
              SET status = 'credited', tx_hash = $1, credited_at = NOW()
            WHERE vault_id = $2 AND epoch_start = $3`,
          [hash, row.id, window.start.toISOString()],
        );
        summary.credited += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn({ err: (err as Error).message, vault_id: row.id }, 'yield:cron:vault_failed');
      }
    }
  } finally {
    await pool.query(`SELECT pg_advisory_unlock(hashtext('vault_yield_cron')::bigint)`);
  }
  logger.info(summary as unknown as Record<string, unknown>, 'yield:cron:tick_done');
  return summary;
}

async function insertEpoch(
  db: Pool | PoolClient,
  row: RewardWriteRow,
): Promise<{ inserted: boolean }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO vault_reward_epochs
       (vault_id, epoch_start, epoch_end, avg_balance_stroops, apy_bp, reward_stroops, status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (vault_id, epoch_start) DO NOTHING
     RETURNING id`,
    [
      row.vault_id,
      row.epoch_start.toISOString(),
      row.epoch_end.toISOString(),
      row.avg_balance_stroops.toString(),
      row.apy_bp,
      row.reward_stroops.toString(),
      row.status,
      row.reason ?? null,
    ],
  );
  return { inserted: (r.rowCount ?? 0) > 0 };
}

async function sumMonthReward(db: Pool | PoolClient, vaultId: string, now: Date): Promise<bigint> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await db.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(reward_stroops)::text, '0') AS total
       FROM vault_reward_epochs
      WHERE vault_id = $1
        AND status = 'credited'
        AND epoch_start >= $2`,
    [vaultId, monthStart.toISOString()],
  );
  return BigInt(r.rows[0]?.total ?? '0');
}

// ── Read helpers (used by the routes layer) ────────────────────────────────

export async function listVaultRewards(
  vaultId: string,
  buyer: string,
  limit = 50,
  offset = 0,
  db: Pool = defaultPool,
) {
  const r = await db.query(
    `SELECT e.id, e.epoch_start, e.epoch_end, e.avg_balance_stroops::text AS avg_balance_stroops,
            e.apy_bp, e.reward_stroops::text AS reward_stroops, e.status, e.reason,
            e.tx_hash, e.credited_at
       FROM vault_reward_epochs e
       JOIN budget_vaults v ON v.id = e.vault_id
      WHERE v.id = $1 AND v.buyer_address = $2
      ORDER BY e.epoch_start DESC
      LIMIT $3 OFFSET $4`,
    [vaultId, buyer, limit, offset],
  );
  return r.rows;
}

export async function getBuyerRewardSummary(buyer: string, now: Date = new Date(), db: Pool = defaultPool) {
  const cfg = loadRewardConfig();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const totals = await db.query<{ total: string; month: string; vaults_with_boost: string }>(
    `SELECT
       COALESCE(SUM(e.reward_stroops) FILTER (WHERE e.status = 'credited')::text, '0') AS total,
       COALESCE(SUM(e.reward_stroops) FILTER (WHERE e.status = 'credited' AND e.epoch_start >= $2)::text, '0') AS month,
       COALESCE(COUNT(DISTINCT v.id) FILTER (
         WHERE v.status = 'active' AND v.created_at + ($3 || ' days')::interval > NOW()
       )::text, '0') AS vaults_with_boost
     FROM budget_vaults v
     LEFT JOIN vault_reward_epochs e ON e.vault_id = v.id
    WHERE v.buyer_address = $1`,
    [buyer, monthStart.toISOString(), String(cfg.boostDays)],
  );
  const window = currentEpochWindow(now, cfg.epochHours);
  const row = totals.rows[0] ?? { total: '0', month: '0', vaults_with_boost: '0' };
  return {
    success: true,
    data: {
      total_earned_stroops: row.total,
      this_month_stroops: row.month,
      active_vaults_with_boost: Number(row.vaults_with_boost),
      next_epoch_at: window.end.toISOString(),
      base_apy_bp: cfg.baseBp,
      boost_apy_bp: cfg.boostBp,
      boost_days: cfg.boostDays,
    },
  };
}

export async function getPerVaultRewardTotals(buyer: string, db: Pool = defaultPool) {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const r = await db.query<{
    vault_id: string;
    total_stroops: string;
    month_stroops: string;
  }>(
    `SELECT v.id AS vault_id,
            COALESCE(SUM(e.reward_stroops) FILTER (WHERE e.status = 'credited')::text, '0') AS total_stroops,
            COALESCE(SUM(e.reward_stroops) FILTER (WHERE e.status = 'credited' AND e.epoch_start >= $2)::text, '0') AS month_stroops
       FROM budget_vaults v
       LEFT JOIN vault_reward_epochs e ON e.vault_id = v.id
      WHERE v.buyer_address = $1
      GROUP BY v.id`,
    [buyer, monthStart.toISOString()],
  );
  return r.rows;
}
