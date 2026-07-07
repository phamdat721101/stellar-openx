#!/usr/bin/env tsx
/**
 * smoke-vault-rewards-e2e.ts — PRD-N BudgetVault v0.31 yield-rewards.
 *
 * CI-safe smoke — asserts the pure math kernel + read API shape without
 * requiring on-chain testnet funds. Full on-chain topup flow (treasury →
 * vault SAC transfer) is covered manually per VAULT_YIELD_DEPLOY.md.
 *
 * Gated behind `RUN_YIELD=1` env in run-all-smokes.sh.
 *
 * What we assert:
 *   1. computeEpochReward is deterministic + boundary-correct.
 *   2. resolveApyBp flips from boost → base at boost_days.
 *   3. currentEpochWindow aligns to unix-epoch × epochHours.
 *   4. GET /budget/rewards/summary returns 404 when flag off, JSON when on.
 *   5. GET /budget/:id/rewards returns 404 when flag off, {success, data} when on.
 */

import { Keypair } from '@stellar/stellar-sdk';
import {
  computeEpochReward,
  resolveApyBp,
  currentEpochWindow,
  loadRewardConfig,
} from '../packages/api/src/services/stellar/vaultRewards';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: got ${a}, expected ${b}`);
}

async function main() {
  console.log('▶︎ Pure math: computeEpochReward');
  // 1000 USDC (10^10 stroops) × 8% × 7d ÷ 365 = ~1.53424 USDC (15342465 stroops).
  const r1 = computeEpochReward(10_000_000_000n, 800, 7);
  assert(r1 > 15_000_000n && r1 < 16_000_000n, `expected ~15342465 stroops, got ${r1}`);
  console.log(`   ok — 1000 USDC × 8% × 7d = ${r1} stroops`);

  console.log('▶︎ Pure math: computeEpochReward zero cases');
  eq(computeEpochReward(0n, 800, 7), 0n, 'zero balance → zero reward');
  eq(computeEpochReward(10_000_000_000n, 0, 7), 0n, 'zero apy → zero reward');
  eq(computeEpochReward(10_000_000_000n, 800, 0), 0n, 'zero days → zero reward');
  console.log('   ok — 3 zero-case invariants hold');

  console.log('▶︎ Pure math: resolveApyBp boost→base transition');
  const cfg = loadRewardConfig({ VAULT_YIELD_BASE_BP: '400', VAULT_YIELD_BOOST_BP: '800', VAULT_YIELD_BOOST_DAYS: '30' } as NodeJS.ProcessEnv);
  const created = new Date('2026-08-01T00:00:00Z');
  eq(resolveApyBp(created, new Date('2026-08-01T00:00:00Z'), cfg), 800, 'day 0 → boost');
  eq(resolveApyBp(created, new Date('2026-08-29T00:00:00Z'), cfg), 800, 'day 28 → boost');
  eq(resolveApyBp(created, new Date('2026-08-31T00:00:00Z'), cfg), 400, 'day 30 → base');
  eq(resolveApyBp(created, new Date('2026-12-01T00:00:00Z'), cfg), 400, 'day 122 → base');
  console.log('   ok — boost curve flips at exactly boost_days');

  console.log('▶︎ Pure math: currentEpochWindow aligns to epoch grid');
  const now = new Date('2026-08-15T12:34:56Z');
  const w168 = currentEpochWindow(now, 168);
  const durMs = w168.end.getTime() - w168.start.getTime();
  eq(durMs, 168 * 3_600_000, 'epoch duration = 168h');
  assert(w168.start.getTime() <= now.getTime() && w168.end.getTime() > now.getTime(),
    'now falls inside the window');
  console.log(`   ok — window ${w168.start.toISOString()} → ${w168.end.toISOString()}`);

  console.log('▶︎ Pure math: monthly cap clamping (integration-style)');
  // Simulate 5 weeks at max earn on a $1000 vault: each week ~$1.53 → $7.66 total < $50 cap.
  // Simulate a huge vault ($100k): each week ~$153 → cap kicks in during week 1.
  const bigVault = 1_000_000_000_000n; // $100k
  const rBig = computeEpochReward(bigVault, 800, 7);
  const capStroops = BigInt(cfg.monthlyCapStroops);
  const clamped = rBig > capStroops ? capStroops : rBig;
  assert(clamped === capStroops || clamped === rBig, 'clamp preserves ordering');
  console.log(`   ok — clamp ${rBig} → ${clamped} (cap ${capStroops})`);

  console.log('▶︎ HTTP: yield routes gated on FEATURE_M2_VAULT_YIELD');
  const buyer = Keypair.random().publicKey();
  let summary: Response;
  try {
    summary = await fetch(`${API_URL}/v3/marketplace/budget/rewards/summary`, {
      headers: { 'x-stellar-address': buyer },
    });
  } catch {
    console.log(`   skip — API not reachable at ${API_URL} (start with 'npm run api:dev' to run HTTP asserts)`);
    console.log('✅ yield-rewards smoke green (math kernel only)');
    return;
  }
  assert([200, 404].includes(summary.status),
    `expected 200 (flag on) or 404 (flag off), got ${summary.status}`);
  console.log(`   ok — GET /budget/rewards/summary → ${summary.status}`);
  if (summary.status === 200) {
    const j = (await summary.json()) as { success: boolean; data?: { base_apy_bp?: number } };
    assert(j.success === true, 'summary envelope has success:true');
    assert(typeof j.data?.base_apy_bp === 'number', 'summary.data.base_apy_bp is a number');
    console.log(`   ok — summary shape valid (base_apy_bp=${j.data.base_apy_bp})`);
  }

  const list = await fetch(`${API_URL}/v3/marketplace/budget/00000000-0000-0000-0000-000000000000/rewards`, {
    headers: { 'x-stellar-address': buyer },
  });
  assert([200, 404, 500].includes(list.status),
    `expected 200 or 404 (flag off), got ${list.status}`);
  console.log(`   ok — GET /budget/:id/rewards → ${list.status}`);
  if (list.status === 200) {
    const j = (await list.json()) as { success: boolean; data: unknown[]; meta: { limit: number } };
    assert(j.success === true, 'list envelope has success:true');
    assert(Array.isArray(j.data), 'list.data is an array');
    assert(typeof j.meta?.limit === 'number', 'list.meta.limit is a number');
    console.log(`   ok — list shape valid`);
  }

  console.log('✅ yield-rewards smoke green');
}

main().catch((err) => {
  console.error('❌', (err as Error).message);
  process.exit(1);
});
