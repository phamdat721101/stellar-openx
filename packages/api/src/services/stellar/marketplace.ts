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

/**
 * buildAgentPayoutXdr — seller withdraws their accrued USDC balance from
 * paid-call-ledger. Contract call: `agent_payout(seller, agent_id, amount)`
 * with `seller.require_auth()` — the seller's wallet is the tx source, so
 * Soroban's source-account auth shortcut satisfies the require_auth check
 * without a separate auth entry (LSP mirror of `buildHireAgentXdr`).
 *
 * SOLID (SRP): only builds the tx envelope. Reading the on-chain balance
 * lives in `getAgentBalance()`; caller composes the two.
 */
export async function buildAgentPayoutXdr(
  seller: string,
  agentId: Buffer,
  amountStroops: bigint,
): Promise<string> {
  if (amountStroops <= 0n) throw new Error('amountStroops must be > 0');
  const s = getStellar();
  const tx = (await s.buildTx(seller))
    .addOperation(
      new Contract(s.contracts.paidCallLedger).call(
        'agent_payout',
        new Address(seller).toScVal(),
        nativeToScVal(agentId, { type: 'bytes' }),
        nativeToScVal(amountStroops, { type: 'i128' }),
      ),
    )
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
  return prepared.toXDR();
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

// The v3.1 `buildPrivateHireXdr` (single-op platform-relay via SAC transfer)
// was removed in v3.2. Private-tier settlement now goes through Nethermind's
// audited Privacy Pool via `services/stellar/privacyPool.ts::buildTransactXdr`.
// Callers should:
//   1. Fetch pool metadata via GET /v3/marketplace/private-hire-context.
//   2. Generate a Groth16 proof client-side using @openx/sdk (zk module).
//   3. Submit the proof to POST /v3/marketplace/build-private-transact-xdr,
//      which delegates to `stellar/privacyPool.buildTransactXdr()`.

/**
 * buildPlatformRelayHireXdr — Private tier v3.2 (default, working).
 *
 * A single-op USDC SAC transfer from the buyer to the platform account. The
 * on-chain artifact is opaque about the SELLER (counterparty hidden — the
 * platform intermediates). Amount is on-ledger; that's the trade-off vs the
 * full ZK path (v3.3 opt-in via `privacyPool.buildTransactXdr`, gated on
 * operator picking Path A or Path B in docs/runbooks/ZK_DEPLOY.md).
 *
 * SOLID:
 *  - SRP: only builds the transfer tx envelope. Off-chain seller reconciliation
 *    is `paid-call-ledger`'s job, kicked by `stellarPaymentGate.record()`.
 *  - LSP: signature parallels `buildHireAgentXdr` — both return a prepared
 *    Soroban XDR the wallet co-signs.
 */
export async function buildPlatformRelayHireXdr(
  buyer: string,
  buyerAmountStroops: bigint,
): Promise<string> {
  const s = getStellar();
  if (buyerAmountStroops <= 0n) throw new Error('buyerAmountStroops must be > 0');
  const platform = s.platformKeypair.publicKey();
  const tx = (await s.buildTx(buyer))
    .addOperation(
      new Contract(s.usdcSacId).call(
        'transfer',
        new Address(buyer).toScVal(),
        new Address(platform).toScVal(),
        nativeToScVal(buyerAmountStroops, { type: 'i128' }),
      ),
    )
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
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
