#!/usr/bin/env tsx
/**
 * smoke-mgusd-x402-e2e.ts — MGUSD × x402 v2 shape verification.
 *
 * Verifies the payment gate's asset-resolution + dual-emit v2 header + JSON
 * body for both USDC (backward-compat) and MGUSD (v0.30) settlement paths.
 *
 * This smoke is **shape-only** — it asserts the challenge response is
 * correctly formed for each asset, without requiring the buyer to hold
 * TMGUSD (which needs an M0 testnet faucet). The full on-chain settlement
 * path is exercised by manual E2E once the faucet is funded.
 *
 * Gated behind `RUN_MGUSD=1` env in run-all-smokes.sh so CI stays green
 * even when MGUSD tooling is absent.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { parseV2RequiredHeader } from '../packages/api/src/services/x402/v2Header';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const SLUG = process.env.SMOKE_SLUG ?? 'translator-en-vi';

async function requestChallenge(preferredAsset: string | null): Promise<{
  status: number;
  header: string | null;
  body: Record<string, unknown>;
}> {
  const buyer = Keypair.random();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-stellar-address': buyer.publicKey(),
    'x-payment-mode': 'public',
  };
  if (preferredAsset) headers['x-preferred-asset'] = preferredAsset;
  const r = await fetch(`${API_URL}/api/v1/${SLUG}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: 'hello' }),
  });
  const raw = r.headers.get('x-payment-required') ?? r.headers.get('X-Payment-Required');
  return { status: r.status, header: raw, body: (await r.json()) as Record<string, unknown> };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main() {
  // 1) USDC baseline — pre-v0.30 clients rely on this path.
  console.log('▶︎ USDC (baseline) challenge');
  const usdc = await requestChallenge(null);
  assert(usdc.status === 402, `expected 402, got ${usdc.status}`);
  assert(usdc.body.asset === 'USDC', `expected asset=USDC, got ${usdc.body.asset}`);
  assert(!!usdc.header, 'X-Payment-Required header must be present (dual-emit)');
  const usdcParsed = parseV2RequiredHeader(usdc.header);
  assert(!!usdcParsed, 'X-Payment-Required must parse as valid x402 v2 header');
  assert(usdcParsed!.assetCode === 'USDC', `header assetCode expected USDC, got ${usdcParsed!.assetCode}`);
  console.log('   ok — status 402, JSON.asset=USDC, header parses, matches challenge');

  // 2) MGUSD explicit — asserts asset resolution + header emits correct SAC.
  const mgusdCode = (process.env.STELLAR_NETWORK ?? 'testnet') === 'mainnet' ? 'MGUSD' : 'TMGUSD';
  console.log(`▶︎ ${mgusdCode} (v0.30) challenge`);
  const mgusd = await requestChallenge(mgusdCode);
  assert(mgusd.status === 402, `expected 402, got ${mgusd.status}`);
  assert(mgusd.body.asset === mgusdCode, `expected asset=${mgusdCode}, got ${mgusd.body.asset}`);
  assert(!!mgusd.header, 'X-Payment-Required header must be present');
  const parsed = parseV2RequiredHeader(mgusd.header);
  assert(!!parsed, 'X-Payment-Required must parse as valid x402 v2 header');
  assert(parsed!.assetCode === mgusdCode, `header assetCode expected ${mgusdCode}, got ${parsed!.assetCode}`);
  assert(/^C[A-Z0-9]{55}$/.test(parsed!.asset), 'header asset must be a Soroban C-address SAC');
  assert(parsed!.precision === 7, `expected precision=7, got ${parsed!.precision}`);
  console.log(`   ok — status 402, JSON.asset=${mgusdCode}, SAC=${parsed!.asset.slice(0, 8)}…, precision=${parsed!.precision}`);

  // 3) Cross-asset info integrity — asset_info block should mirror header
  const info = (mgusd.body.asset_info ?? {}) as Record<string, unknown>;
  assert(info.code === mgusdCode, 'body.asset_info.code mismatch');
  assert(info.sac_contract === parsed!.asset, 'body.asset_info.sac_contract mismatch header');
  console.log('   ok — asset_info block mirrors v2 header (structured settlement info)');

  console.log('✅ smoke green — MGUSD × x402 v2 challenge shape verified');
}

main().catch((err) => {
  console.error('❌', err.message ?? err);
  process.exit(1);
});
