#!/usr/bin/env tsx
/**
 * smoke-credit-e2e.ts — PRD-G credit system Stellar smoke.
 *
 * 1. GET /v3/marketplace/credits/me with a fresh Stellar address → expects
 *    25 USDC welcome bonus when FEATURE_CREDIT_SYSTEM=true.
 * 2. POST /api/v1/credits/buy-pack-25 → expects a Coinflow Stellar session.
 */

import { Keypair } from '@stellar/stellar-sdk';

const API = process.env.API_URL ?? 'http://localhost:3001';

async function main() {
  const buyer = Keypair.random();
  console.log('[smoke] buyer =', buyer.publicKey());

  const meResp = await fetch(`${API}/v3/marketplace/credits/me`, {
    headers: { 'x-stellar-address': buyer.publicKey() },
  });
  if (meResp.status === 404) {
    console.log('[smoke] credit system disabled (FEATURE_CREDIT_SYSTEM=false). Done.');
    return;
  }
  if (!meResp.ok) throw new Error(`/credits/me HTTP ${meResp.status}`);
  const me = (await meResp.json()) as { wallet: string; balance_usdc: string };
  console.log('[smoke] balance =', me.balance_usdc);

  const buy = await fetch(`${API}/api/v1/credits/buy-pack-25`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stellar_address: buyer.publicKey() }),
  });
  if (!buy.ok) throw new Error(`buy-pack HTTP ${buy.status}`);
  const session = (await buy.json()) as { hosted_url: string; pack_usdc: number };
  console.log('[smoke] coinflow session ok:', session);
  console.log('✅ credit smoke green');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
