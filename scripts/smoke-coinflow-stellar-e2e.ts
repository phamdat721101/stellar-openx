#!/usr/bin/env tsx
/**
 * smoke-coinflow-stellar-e2e.ts
 *
 * In dev/CI the API runs without a real Coinflow API key — `createDepositSession`
 * returns a deterministic mock hostedUrl. This smoke verifies:
 *   1. POST /api/v1/credits/buy-pack-25 returns a hosted url + session id
 *   2. GET  /api/v1/credits/status/<session> returns a status payload
 */

import { Keypair } from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function main() {
  const buyer = Keypair.random();
  const r = await fetch(`${API_URL}/api/v1/credits/buy-pack-25`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stellar_address: buyer.publicKey() }),
  });
  if (!r.ok) throw new Error(`buy-pack failed: ${r.status} ${await r.text()}`);
  const session = (await r.json()) as { hosted_url: string; session_id: string; pack_usdc: number };
  if (!session.hosted_url || !session.session_id || session.pack_usdc !== 25) {
    throw new Error(`bad session shape: ${JSON.stringify(session)}`);
  }
  console.log('session ok:', session);

  const status = (await fetch(`${API_URL}/api/v1/credits/status/${session.session_id}`).then((r) => r.json())) as {
    sessionId: string;
    status: string;
  };
  if (status.sessionId !== session.session_id) throw new Error('status sessionId mismatch');
  console.log('status ok:', status);
  console.log('✅ smoke green');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
