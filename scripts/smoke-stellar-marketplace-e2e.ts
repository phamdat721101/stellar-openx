#!/usr/bin/env tsx
/**
 * smoke-stellar-marketplace-e2e.ts
 *
 * Regression gate for the wallet-signed publish flow (v3.3):
 *   1. POST /v3/marketplace/seller/publish/build-xdr    (unsigned XDR)
 *   2. sign with platform key (server-side, no wallet)
 *   3. POST /v3/marketplace/seller/publish/confirm      (submit + mirror)
 *   4. GET  /v3/marketplace/listings                    (row is on-chain)
 *   5. POST /api/v1/<slug>                              (expect 402 challenge)
 *   6. POST /v3/marketplace/seller/publish              (expect 410 Gone — retired)
 *   7. POST /v3/concierge/onboard                       (expect 410 Gone — retired)
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
const NETWORK_PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

async function main() {
  const platformSecret = process.env.STELLAR_PLATFORM_SECRET_KEY;
  if (!platformSecret) throw new Error('STELLAR_PLATFORM_SECRET_KEY required');
  const seller = Keypair.fromSecret(platformSecret);
  const sellerAddr = seller.publicKey();
  const slug = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  const body = {
    slug,
    display_name: 'Smoke Agent',
    persona: { system_prompt: 'You are a smoke-test agent that echoes the user input verbatim.' },
    price_usdc: '0.10',
    manifest: { source: 'smoke' },
  };

  // 1. build-xdr
  const buildResp = await fetch(`${API_URL}/v3/marketplace/seller/publish/build-xdr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': sellerAddr },
    body: JSON.stringify(body),
  });
  if (!buildResp.ok) throw new Error(`build-xdr failed: ${buildResp.status} ${await buildResp.text()}`);
  const built = (await buildResp.json()) as { xdr: string; existing_agent_id: string | null };
  console.log('build-xdr ok');

  // 2. server-side sign with platform key
  const tx = TransactionBuilder.fromXDR(built.xdr, NETWORK_PASSPHRASE);
  tx.sign(seller);
  const signedXdr = tx.toXDR();

  // 3. confirm
  const confirmResp = await fetch(`${API_URL}/v3/marketplace/seller/publish/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': sellerAddr },
    body: JSON.stringify({ ...body, signed_xdr: signedXdr, existing_agent_id: built.existing_agent_id }),
  });
  if (!confirmResp.ok) throw new Error(`confirm failed: ${confirmResp.status} ${await confirmResp.text()}`);
  const published = (await confirmResp.json()) as {
    agent_id: string;
    slug: string;
    soroban_agent_id: string;
    stellar_tx_hash: string;
  };
  if (!published.soroban_agent_id || published.soroban_agent_id.length !== 64) {
    throw new Error(`expected 32-byte hex soroban_agent_id, got ${published.soroban_agent_id}`);
  }
  console.log('publish ok:', {
    agent_id: published.agent_id,
    soroban_agent_id: published.soroban_agent_id,
    tx_hash: published.stellar_tx_hash,
  });

  // 4. listings
  const listings = (await fetch(`${API_URL}/v3/marketplace/listings`).then((r) => r.json())) as {
    listings: Array<{ id: string; soroban_agent_id: string | null }>;
  };
  const listed = listings.listings.find((l) => l.id === published.agent_id);
  if (!listed) throw new Error('agent not in /listings');
  if (!listed.soroban_agent_id) throw new Error('agent listed but soroban_agent_id is null');
  console.log('listings ok');

  // 5. 402 challenge shape
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
  console.log('402 challenge ok');

  // 6. retired /seller/publish → 410
  const gone1 = await fetch(`${API_URL}/v3/marketplace/seller/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': sellerAddr },
    body: JSON.stringify(body),
  });
  if (gone1.status !== 410) throw new Error(`expected 410 for retired /seller/publish, got ${gone1.status}`);
  console.log('retired /seller/publish → 410 ok');

  // 7. retired /concierge/onboard → 410
  const gone2 = await fetch(`${API_URL}/v3/concierge/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x'.repeat(100) }),
  });
  if (gone2.status !== 410) throw new Error(`expected 410 for retired /concierge/onboard, got ${gone2.status}`);
  console.log('retired /concierge/onboard → 410 ok');

  console.log('✅ smoke green');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
