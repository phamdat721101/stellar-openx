#!/usr/bin/env tsx
/**
 * smoke-translator-e2e.ts
 *
 * Pings the seeded translator agent. Verifies:
 *   1. /v3/marketplace/listings contains the slug
 *   2. POST /api/v1/translator-en-vi returns a 402 Stellar challenge
 */

import { Keypair } from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function main() {
  const listings = (await fetch(`${API_URL}/v3/marketplace/listings`).then((r) => r.json())) as {
    listings: Array<{ slug: string }>;
  };
  const lighthouse = listings.listings.find((l) => l.slug === 'translator-en-vi');
  if (!lighthouse) throw new Error('translator-en-vi not seeded — run seed:translator first');
  console.log('listed:', lighthouse.slug);

  const buyer = Keypair.random();
  const r = await fetch(`${API_URL}/api/v1/translator-en-vi`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-stellar-address': buyer.publicKey(),
      'x-payment-mode': 'public',
    },
    body: JSON.stringify({ question: 'Translate: This Agreement is governed by the laws of California.' }),
  });
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
  const challenge = await r.json();
  console.log('402:', challenge);
  console.log('✅ translator-en-vi smoke green');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
