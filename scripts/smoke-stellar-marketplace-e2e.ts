#!/usr/bin/env tsx
/**
 * smoke-stellar-marketplace-e2e.ts
 *
 * Full end-to-end smoke against a running API + Stellar testnet:
 *   1. POST /v3/marketplace/seller/publish (seller registers a translator agent)
 *   2. GET  /v3/marketplace/listings (confirm it shows up)
 *   3. POST /api/v1/<slug>           (expect 402 challenge)
 *   4. (manual) sign+submit the prepared XDR in the browser flow
 *
 * For CI we stop at step 3 and verify the 402 envelope shape.
 */

import { Keypair } from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function main() {
  const seller = Keypair.random();
  console.log('seller:', seller.publicKey());

  // 1. Publish
  const publishResp = await fetch(`${API_URL}/v3/marketplace/seller/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': seller.publicKey() },
    body: JSON.stringify({
      slug: `smoke-${Math.random().toString(36).slice(2, 8)}`,
      persona: { system_prompt: 'You are a smoke-test agent that echoes the user input.' },
      price_usdc: '0.10',
      manifest: { source: 'smoke' },
    }),
  });
  if (!publishResp.ok) throw new Error(`publish failed: ${publishResp.status} ${await publishResp.text()}`);
  const published = (await publishResp.json()) as { agent_id: string; slug: string; soroban_agent_id: string };
  console.log('published:', published);

  // 2. Listings
  const listings = (await fetch(`${API_URL}/v3/marketplace/listings`).then((r) => r.json())) as {
    listings: Array<{ id: string }>;
  };
  if (!listings.listings.some((l) => l.id === published.agent_id)) {
    throw new Error('agent not in /listings');
  }
  console.log('listings ok');

  // 3. 402 challenge shape
  const buyer = Keypair.random();
  const r = await fetch(`${API_URL}/api/v1/${published.slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-stellar-address': buyer.publicKey(),
      'x-payment-mode': 'public',
    },
    body: JSON.stringify({ question: 'hello' }),
  });
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
  const challenge = (await r.json()) as Record<string, unknown>;
  for (const k of ['network', 'asset', 'amount_stroops', 'contract_id', 'agent_id', 'nonce', 'expires_at', 'payment_mode']) {
    if (!(k in challenge)) throw new Error(`challenge missing key: ${k}`);
  }
  console.log('402 challenge ok:', challenge);
  console.log('✅ smoke green');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
