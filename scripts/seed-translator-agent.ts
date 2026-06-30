#!/usr/bin/env tsx
/**
 * seed-translator-agent.ts
 *
 * Seeds the EN→VI Legal Translator lighthouse agent. Uses the platform key
 * as both seller + payout (lighthouse demo only). For real sellers the
 * /v3/marketplace/seller/publish endpoint is the production path.
 */

import { Keypair } from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function main() {
  const platformSecret = process.env.STELLAR_PLATFORM_SECRET_KEY;
  if (!platformSecret) {
    console.error('STELLAR_PLATFORM_SECRET_KEY required');
    process.exit(1);
  }
  const seller = Keypair.fromSecret(platformSecret);

  const r = await fetch(`${API_URL}/v3/marketplace/seller/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': seller.publicKey() },
    body: JSON.stringify({
      slug: 'translator-en-vi',
      persona: {
        system_prompt:
          'You are a legal-document translator that converts English NDAs and contracts into Vietnamese while preserving every clause and formatting cue.',
        model: 'gpt-4o-mini',
      },
      price_usdc: '1.50',
      manifest: { name: 'translator-en-vi', version: '3.0.0', license: 'MIT' },
    }),
  });
  if (!r.ok) {
    console.error('publish failed:', r.status, await r.text());
    process.exit(1);
  }
  console.log(await r.json());
  console.log('✅ seeded translator-en-vi');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
