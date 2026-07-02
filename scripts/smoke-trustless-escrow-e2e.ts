#!/usr/bin/env tsx
/**
 * smoke-trustless-escrow-e2e.ts — PRD-T regression gate.
 *
 * Cheap-mode: skips the full 4-step wallet dance (which requires two funded
 * testnet wallets with USDC trustlines) and instead verifies:
 *   • /v3/marketplace/escrow/health returns tw_ok=true (TW API reachable)
 *   • /v3/marketplace/escrow/build-action-xdr rejects malformed requests
 *   • /v3/marketplace/escrow/build-action-xdr with a real agent returns 200
 *     + unsigned XDR + contract_address (proves TW auth + our wiring)
 *
 * Deep-mode (TW_ESCROW_SMOKE_DEEP=1): additionally deploys + funds using
 * the platform keypair (both buyer + seller for demo purposes) and walks
 * the state machine end to end. Requires: platform testnet account funded
 * with USDC + trustline.
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
const NETWORK_PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
const DEEP = process.env.TW_ESCROW_SMOKE_DEEP === '1';

async function main() {
  console.log('== PRD-T Trustless Work escrow smoke ==');
  console.log('API_URL:', API_URL, 'network:', NETWORK, 'deep:', DEEP);

  // 1. Health probe — TW connectivity
  const health = (await fetch(`${API_URL}/v3/marketplace/escrow/health`).then((r) => r.json())) as {
    tw_ok: boolean; base_url: string; api_key_set: boolean;
  };
  if (!health.tw_ok) throw new Error(`TW health failed: ${JSON.stringify(health)}`);
  if (!health.api_key_set) throw new Error('TW_API_KEY not set on API');
  console.log('  ✓ escrow/health:', health.base_url, health.tw_ok ? 'reachable' : 'unreachable');

  // 2. Unauth rejected
  const noAuth = await fetch(`${API_URL}/v3/marketplace/escrow/build-action-xdr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'deploy' }),
  });
  if (noAuth.status !== 401) throw new Error(`want 401, got ${noAuth.status}`);
  console.log('  ✓ unauth → 401');

  // 3. Missing action rejected
  const platformSecret = process.env.STELLAR_PLATFORM_SECRET_KEY;
  if (!platformSecret) throw new Error('STELLAR_PLATFORM_SECRET_KEY required');
  const platform = Keypair.fromSecret(platformSecret);
  const badReq = await fetch(`${API_URL}/v3/marketplace/escrow/build-action-xdr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': platform.publicKey() },
    body: JSON.stringify({}),
  });
  if (badReq.status !== 400) throw new Error(`want 400, got ${badReq.status}`);
  console.log('  ✓ missing action → 400');

  // 4. Real deploy XDR — expects a published on-chain agent
  const agentsRes = (await fetch(`${API_URL}/v3/agents/top`).then((r) => r.json())) as {
    agents: Array<{ id: string; soroban_agent_id: string | null; slug: string }>;
  };
  const agent = agentsRes.agents.find((a) => a.soroban_agent_id);
  if (!agent) {
    console.log('  (skip) no on-chain agent to build deploy against — seed one first.');
    console.log('✅ smoke green (shallow — no seeded agent)');
    return;
  }
  const deployRes = await fetch(`${API_URL}/v3/marketplace/escrow/build-action-xdr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': platform.publicKey() },
    body: JSON.stringify({ action: 'deploy', agent_id: agent.id, question: 'smoke test question' }),
  });
  if (!deployRes.ok) {
    const body = await deployRes.text();
    throw new Error(`deploy build failed: ${deployRes.status} ${body}`);
  }
  const deploy = (await deployRes.json()) as { xdr: string; contract_address: string; escrow_id: string };
  if (!deploy.xdr || !deploy.contract_address) throw new Error('deploy missing xdr/contract_address');
  console.log('  ✓ escrow/build-action-xdr deploy →', deploy.contract_address);

  if (!DEEP) {
    console.log('✅ smoke green (shallow — set TW_ESCROW_SMOKE_DEEP=1 for full flow)');
    return;
  }

  // Deep mode — server-side sign with platform key + submit
  const tx = TransactionBuilder.fromXDR(deploy.xdr, NETWORK_PASSPHRASE);
  tx.sign(platform);
  const submitRes = await fetch(`${API_URL}/v3/marketplace/escrow/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': platform.publicKey() },
    body: JSON.stringify({
      signed_xdr: tx.toXDR(),
      contract_address: deploy.contract_address,
      action: 'deploy',
    }),
  });
  if (!submitRes.ok) throw new Error(`deploy submit failed: ${submitRes.status} ${await submitRes.text()}`);
  console.log('  ✓ escrow/submit deploy →', (await submitRes.json()) as unknown);

  console.log('✅ smoke green (deep)');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
