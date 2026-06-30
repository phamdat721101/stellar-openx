/**
 * stellar/marketplace.ts — typed wrapper around the three Soroban contracts
 * (agent-registry, paywall-router, paid-call-ledger).
 *
 * Read paths (`getAgent`, `listAgents`, `getAgentBalance`, `getCall`) build a
 * simulate-only transaction and decode the host return value — no on-chain
 * write needed, no signer needed.
 *
 * Write paths require a pre-built, *signed* XDR submitted by the caller; the
 * helpers expose `buildHireAgentXdr()` etc. and return the XDR for the wallet
 * to sign. The API only submits — it never holds buyer keys.
 *
 * SOLID:
 *  - SRP: marketplace contract glue lives here. Onramp + privacy-pool stay
 *    in their own files for clean test boundaries.
 */

import { Address, Contract, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { getStellar } from './client';
import type { PaymentMode } from '@openx/sdk';

export interface AgentSummary {
  agent_id: string;        // hex-32
  slug: string;
  seller: string;          // G…
  price_stroops: string;   // decimal-string-bigint for json safety
  display_name: string;
  manifest_hash: string;   // hex-32
  kya_required: boolean;
  created_at: number;
}

export interface CallSummary {
  buyer: string;
  agent_id: string;        // hex-32
  query_hash: string;      // hex-32
  gross_stroops: string;
  completed: boolean;
  disputed: boolean;
  created_at: number;
}

// ── Reads (simulate-only) ────────────────────────────────────────────────────

export async function getAgent(agentId: Buffer): Promise<AgentSummary | null> {
  const s = getStellar();
  const tx = (await s.buildTx(s.platformKeypair.publicKey()))
    .addOperation(
      new Contract(s.contracts.agentRegistry).call(
        'get_agent',
        nativeToScVal(agentId, { type: 'bytes' }),
      ),
    )
    .build();
  const sim = await s.rpc.simulateTransaction(tx);
  if ('error' in sim && sim.error) return null;
  const ret = ('result' in sim && sim.result?.retval) || null;
  if (!ret) return null;
  const decoded = scValToNative(ret) as Record<string, unknown>;
  return mapAgent(agentId, decoded);
}

export async function listAgents(offset: number, limit: number): Promise<AgentSummary[]> {
  const s = getStellar();
  const tx = (await s.buildTx(s.platformKeypair.publicKey()))
    .addOperation(
      new Contract(s.contracts.agentRegistry).call(
        'list_agents',
        nativeToScVal(offset, { type: 'u32' }),
        nativeToScVal(limit, { type: 'u32' }),
      ),
    )
    .build();
  const sim = await s.rpc.simulateTransaction(tx);
  if ('error' in sim && sim.error) return [];
  const ret = ('result' in sim && sim.result?.retval) || null;
  if (!ret) return [];
  const arr = scValToNative(ret) as Array<Record<string, unknown>>;
  return arr.map((m, i) => mapAgent(Buffer.alloc(32), m, i));
}

export async function getAgentBalance(agentId: Buffer): Promise<bigint> {
  const s = getStellar();
  const tx = (await s.buildTx(s.platformKeypair.publicKey()))
    .addOperation(
      new Contract(s.contracts.paidCallLedger).call(
        'get_agent_balance',
        nativeToScVal(agentId, { type: 'bytes' }),
      ),
    )
    .build();
  const sim = await s.rpc.simulateTransaction(tx);
  if ('error' in sim && sim.error) return 0n;
  const ret = ('result' in sim && sim.result?.retval) || null;
  if (!ret) return 0n;
  return BigInt(scValToNative(ret) as number | bigint);
}

export async function getCall(callId: Buffer): Promise<CallSummary | null> {
  const s = getStellar();
  const tx = (await s.buildTx(s.platformKeypair.publicKey()))
    .addOperation(
      new Contract(s.contracts.paywallRouter).call(
        'get_call',
        nativeToScVal(callId, { type: 'bytes' }),
      ),
    )
    .build();
  const sim = await s.rpc.simulateTransaction(tx);
  if ('error' in sim && sim.error) return null;
  const ret = ('result' in sim && sim.result?.retval) || null;
  if (!ret) return null;
  const d = scValToNative(ret) as Record<string, unknown>;
  return {
    buyer: String(d.buyer),
    agent_id: Buffer.from(d.agent_id as Uint8Array).toString('hex'),
    query_hash: Buffer.from(d.query_hash as Uint8Array).toString('hex'),
    gross_stroops: String(d.gross_stroops),
    completed: Boolean(d.completed),
    disputed: Boolean(d.disputed),
    created_at: Number(d.created_at),
  };
}

// ── Build XDRs (caller signs + submits via SDK payRouter) ────────────────────

export async function buildHireAgentXdr(
  buyer: string,
  agentId: Buffer,
  queryHash: Buffer,
  mode: PaymentMode,
): Promise<string> {
  const s = getStellar();
  const modeScVal =
    mode === 'public'
      ? xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Public')])
      : xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Private')]);

  const tx = (await s.buildTx(buyer))
    .addOperation(
      new Contract(s.contracts.paywallRouter).call(
        'hire_agent',
        new Address(buyer).toScVal(),
        nativeToScVal(agentId, { type: 'bytes' }),
        nativeToScVal(queryHash, { type: 'bytes' }),
        modeScVal,
      ),
    )
    .build();
  // Prepare = simulate + restore footprint so the wallet can sign deterministically.
  const prepared = await s.rpc.prepareTransaction(tx);
  return prepared.toXDR();
}

/**
 * buildPrivateHireXdr — x402 "private" tier on Stellar (v3.0.0 platform-relay).
 *
 * The paywall-router Soroban contract intentionally reverts on `PaymentMode::Private`
 * (see `paywall-router/src/lib.rs` line ~95). A Groth16-backed Privacy Pool
 * private_transfer is the v3.1 target. For v3.0.0 MVP we ship a semi-trusted
 * platform-relay path that keeps the same `mode='private'` API surface:
 *
 *   Op1: buyer → platform USDC transfer (via SAC) for `price * private_multiplier`.
 *   Op2: paywall-router.hire_agent(PLATFORM, agent_id, query_hash, Public) signed
 *        by the platform's Soroban keypair — so the on-chain buyer↔agent link
 *        is broken (the agent only sees the platform).
 *
 * Atomicity: both ops live in one Stellar transaction. Settlement is recorded
 * in `paid_calls.method='privacy_pool'` (already allowed by 038_strip_fhe_add_stellar.sql).
 *
 * Threat model: the platform sees the buyer↔agent linkage off-ledger. On-chain,
 * a third-party observer sees only:
 *   - many buyers paying the platform
 *   - the platform paying many agents
 * — which is the same anonymity-set shielding as a centralised mixer. Upgrading
 * to a trustless ZK Privacy Pool is a v3.1 swap behind this same endpoint.
 *
 * Returns: a partially-signed XDR (platform side already signed). The buyer
 * adds their signature for Op1 (the SAC transfer) and submits via /v3/marketplace/submit.
 */
export async function buildPrivateHireXdr(
  buyer: string,
  agentId: Buffer,
  queryHash: Buffer,
  buyerAmountStroops: bigint,
): Promise<string> {
  const s = getStellar();
  const platform = s.platformKeypair.publicKey();
  if (buyerAmountStroops <= 0n) throw new Error('buyerAmountStroops must be > 0');

  // Single tx, source = buyer (so the buyer pays fee + Op1 auth comes from buyer).
  // Op2 auth is sourced by the platform keypair, which we sign before returning.
  const builder = await s.buildTx(buyer);
  const tx = builder
    // Op1 — buyer → platform USDC via the SAC.
    .addOperation(
      new Contract(s.usdcSacId).call(
        'transfer',
        new Address(buyer).toScVal(),
        new Address(platform).toScVal(),
        nativeToScVal(buyerAmountStroops, { type: 'i128' }),
      ),
    )
    // Op2 — paywall-router.hire_agent(PLATFORM, …, Public). Mode::Public so the
    // router accepts it; the on-chain "buyer" is the platform. The platform's
    // payout to the agent (95/5 split) happens inside paywall-router using the
    // platform's pre-existing USDC balance funded by Op1.
    .addOperation(
      new Contract(s.contracts.paywallRouter).call(
        'hire_agent',
        new Address(platform).toScVal(),
        nativeToScVal(agentId, { type: 'bytes' }),
        nativeToScVal(queryHash, { type: 'bytes' }),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Public')]),
      ),
    )
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
  // Platform pre-signs Op2's auth. Buyer co-signs the envelope on the wire.
  prepared.sign(s.platformKeypair);
  return prepared.toXDR();
}

// ── helpers ─────────────────────────────────────────────────────────────────

function mapAgent(agentId: Buffer, m: Record<string, unknown>, _i = 0): AgentSummary {
  return {
    agent_id: agentId.toString('hex'),
    slug: String(m.slug ?? ''),
    seller: String(m.seller ?? ''),
    price_stroops: String(m.price_stroops ?? '0'),
    display_name: String(m.display_name ?? ''),
    manifest_hash:
      m.manifest_hash instanceof Uint8Array
        ? Buffer.from(m.manifest_hash).toString('hex')
        : String(m.manifest_hash ?? ''),
    kya_required: Boolean(m.kya_required),
    created_at: Number(m.created_at ?? 0),
  };
}
