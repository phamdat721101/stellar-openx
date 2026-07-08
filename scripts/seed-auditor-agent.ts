#!/usr/bin/env tsx
/**
 * seed-auditor-agent.ts
 *
 * Seeds the Soroban Contract Auditor lighthouse agent. Powers the third
 * homepage sample pill ("Audit a Soroban contract") added in PRD-U so it
 * returns a real ranked candidate on click. Mirrors the translator seed
 * pattern (two-step build-xdr → sign → confirm) — the platform key is
 * both seller + payout for lighthouse-demo purposes.
 *
 * Idempotent: if the row already exists, the API's confirm endpoint
 * returns 200 with `existing_agent_id` and the smoke gate treats that as
 * success. Set `SEED_AUDITOR=1` in run-all-smokes.sh to enable in CI.
 */

import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
const NETWORK_PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

const BODY = {
  slug: 'soroban-auditor',
  display_name: 'Soroban Contract Auditor',
  persona: {
    system_prompt:
      'You are a senior Rust + Soroban smart-contract auditor. Given a contract source you review reentrancy, integer overflow, access-control gaps, storage-key hygiene, fee-flow correctness, admin-key privilege escalation, and event-emission completeness. Return findings as CRITICAL / HIGH / MEDIUM / LOW with one-line fixes.',
    model: 'gpt-4o-mini',
  },
  price_usdc: '0.75',
  manifest: { name: 'soroban-auditor', version: '3.0.0', license: 'MIT' },
};

async function main() {
  const platformSecret = process.env.STELLAR_PLATFORM_SECRET_KEY;
  if (!platformSecret) {
    console.error('STELLAR_PLATFORM_SECRET_KEY required');
    process.exit(1);
  }
  const seller = Keypair.fromSecret(platformSecret);
  const sellerAddr = seller.publicKey();

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

  const tx = TransactionBuilder.fromXDR(built.xdr, NETWORK_PASSPHRASE);
  tx.sign(seller);
  const signedXdr = tx.toXDR();

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
  console.log('✅ seeded soroban-auditor (wallet-signed on-chain)');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
