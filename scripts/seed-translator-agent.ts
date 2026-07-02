#!/usr/bin/env tsx
/**
 * seed-translator-agent.ts
 *
 * Seeds the EN→VI Legal Translator lighthouse agent. Uses the platform key
 * as both seller + payout (lighthouse demo only). For real sellers the
 * /studio wallet-signed publish flow is the production path.
 *
 * v3.3: uses the two-step wallet-signed publish endpoints
 * (build-xdr → sign → confirm) with the platform keypair signing server-side.
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
const NETWORK_PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

const BODY = {
  slug: 'translator-en-vi',
  display_name: 'EN→VI Legal Translator',
  persona: {
    system_prompt:
      'You are a legal-document translator that converts English NDAs and contracts into Vietnamese while preserving every clause and formatting cue.',
    model: 'gpt-4o-mini',
  },
  price_usdc: '1.50',
  manifest: { name: 'translator-en-vi', version: '3.0.0', license: 'MIT' },
};

async function main() {
  const platformSecret = process.env.STELLAR_PLATFORM_SECRET_KEY;
  if (!platformSecret) {
    console.error('STELLAR_PLATFORM_SECRET_KEY required');
    process.exit(1);
  }
  const seller = Keypair.fromSecret(platformSecret);
  const sellerAddr = seller.publicKey();

  // 1. build unsigned XDR
  const buildResp = await fetch(`${API_URL}/v3/marketplace/seller/publish/build-xdr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': sellerAddr },
    body: JSON.stringify(BODY),
  });
  if (!buildResp.ok) {
    console.error('build-xdr failed:', buildResp.status, await buildResp.text());
    process.exit(1);
  }
  const built = (await buildResp.json()) as { xdr: string; existing_agent_id: string | null };

  // 2. sign with platform key (server-side signer — no wallet UI in a script)
  const tx = TransactionBuilder.fromXDR(built.xdr, NETWORK_PASSPHRASE);
  tx.sign(seller);
  const signedXdr = tx.toXDR();

  // 3. confirm
  const confirmResp = await fetch(`${API_URL}/v3/marketplace/seller/publish/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': sellerAddr },
    body: JSON.stringify({ ...BODY, signed_xdr: signedXdr, existing_agent_id: built.existing_agent_id }),
  });
  if (!confirmResp.ok) {
    console.error('confirm failed:', confirmResp.status, await confirmResp.text());
    process.exit(1);
  }
  console.log(await confirmResp.json());
  console.log('✅ seeded translator-en-vi (wallet-signed on-chain)');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
