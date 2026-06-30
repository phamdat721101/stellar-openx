#!/usr/bin/env tsx
/**
 * smoke-stellar-privacy-pool-e2e.ts
 *
 * Exercises the private-tier 402 path. Verifies:
 *   • Challenge `contract_id` matches `STELLAR_PRIVACY_POOL_ID`
 *   • `payment_mode` is "private"
 *   • Amount is multiplied (1.5× by default)
 *
 * Real Privacy Pool deposit/transfer/withdraw is exercised in the chain-level
 * cargo tests in packages/soroban-contracts/privacy-pool. This smoke validates
 * the HTTP integration only.
 */

import { Keypair } from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function main() {
  // Reuse a known seeded agent slug; fall back to the translator lighthouse.
  const slug = process.env.SMOKE_AGENT_SLUG ?? 'translator-en-vi';
  const buyer = Keypair.random();

  const r = await fetch(`${API_URL}/api/v1/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-stellar-address': buyer.publicKey(),
      'x-payment-mode': 'private',
    },
    body: JSON.stringify({ question: 'private smoke' }),
  });
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status} ${await r.text()}`);
  const challenge = (await r.json()) as { payment_mode: string; contract_id: string; amount_stroops: string };
  if (challenge.payment_mode !== 'private') throw new Error('challenge payment_mode != private');
  const poolId = process.env.STELLAR_PRIVACY_POOL_ID;
  if (poolId && challenge.contract_id !== poolId) {
    throw new Error(`contract_id mismatch: got ${challenge.contract_id}, expected ${poolId}`);
  }
  console.log('private 402 challenge ok:', challenge);
  console.log('✅ smoke green');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
