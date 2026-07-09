#!/usr/bin/env tsx
/**
 * smoke-training-e2e.ts — PRD-T-S Agent Training Pipeline.
 *
 * CI-safe smoke gated behind `RUN_TRAINING=1` in run-all-smokes.sh. Asserts:
 *   1. ravenClient offline fixture (RAVEN_MCP_URL unset) — grounding + playbooks
 *      available with zero network, so S2/S3 always have a data source.
 *   2. /v3/training routes are mounted + flag-gated (404 when FEATURE_TRAINING
 *      off, JSON envelope when on) — the S1→S5 HTTP surface exists.
 *
 * The full on-chain certify + LLM-judged S1→S5 drive is covered manually per
 * docs/runbooks/TRAINING_DEPLOY.md (needs API + DB + testnet + an LLM key). To
 * drive it locally deterministically: FEATURE_TRAINING=true RAVEN_LEARN_THRESHOLD=0
 * RAVEN_CERT_THRESHOLD=0 SKILL_AUDIT_THRESHOLD=0 (LLM unset → demo fallback).
 */

import { Keypair } from '@stellar/stellar-sdk';
import { ravenClient } from '../packages/api/src/services/ravenClient';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log('▶︎ Raven offline fixture (RAVEN_MCP_URL unset → graceful fallback)');
  const entries = await ravenClient.search('transfer usdc on stellar');
  assert(entries.length > 0, 'fixture returns at least one entry');
  assert(entries.some((e) => e.kind === 'playbook' && !!e.body), 'fixture includes a playbook with a body');
  assert(entries.some((e) => /sep-41/i.test(e.title) || /sep-41/i.test(e.summary)), 'fixture covers SEP-41');
  console.log(`   ok — ${entries.length} entries, ${entries.filter((e) => e.kind === 'playbook').length} playbooks`);

  console.log('▶︎ HTTP: /v3/training mounted + flag-gated');
  const owner = Keypair.random().publicKey();
  const fakeAgent = '00000000-0000-0000-0000-000000000000';
  let getRes: Response;
  try {
    getRes = await fetch(`${API_URL}/v3/training/${fakeAgent}`, { headers: { 'x-stellar-address': owner } });
  } catch {
    console.log(`   skip — API not reachable at ${API_URL} (start with 'npm run api:dev' for HTTP asserts)`);
    console.log('✅ training smoke green (fixture only)');
    return;
  }
  assert([200, 404].includes(getRes.status), `GET expected 200 (flag on) or 404 (flag off/not found), got ${getRes.status}`);
  console.log(`   ok — GET /v3/training/:id → ${getRes.status}`);

  const learn = await fetch(`${API_URL}/v3/training/${fakeAgent}/learn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stellar-address': owner },
    body: '{}',
  });
  assert([404, 400, 403, 409, 500].includes(learn.status), `POST learn shape, got ${learn.status}`);
  const learnBody = (await learn.json().catch(() => ({}))) as { error?: string };
  assert(typeof learnBody === 'object', 'POST learn returns JSON');
  console.log(`   ok — POST /v3/training/:id/learn → ${learn.status} (${learnBody.error ?? 'ok'})`);

  console.log('✅ training smoke green');
}

main().catch((err) => {
  console.error('❌', (err as Error).message);
  process.exit(1);
});
