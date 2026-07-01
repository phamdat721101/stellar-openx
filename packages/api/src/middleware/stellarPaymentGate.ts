/**
 * stellarPaymentGate — single middleware, single rail, two modes.
 *
 * Replaces the EVM `paymentGate.ts` (x402 + MPP across Arbitrum/Base).
 *
 * Flow:
 *   1. Buyer GETs `/api/v1/<slug>` with no payment header.
 *   2. Gate looks up the agent (Supabase), computes price stroops, builds a
 *      `StellarPaymentChallenge`, signs an HMAC nonce, returns 402 with the
 *      challenge JSON body.
 *   3. Buyer signs the appropriate Stellar tx (paywall-router or privacy-pool)
 *      with their Wallets Kit wallet and submits via Soroban RPC. They retry
 *      `/api/v1/<slug>` with `X-PAYMENT: stellar <tx_hash>` and
 *      `X-PAYMENT-MODE: public|private`.
 *   4. Gate verifies the tx landed (Soroban RPC `getTransaction`) and matches
 *      the expected contract id; on success records to `paid_calls` and lets
 *      the request through.
 *
 * SOLID:
 *  - SRP: gate composes challenge + verification + ledger write. Contract
 *    knowledge is delegated to `stellar/marketplace.ts` / `stellar/privacyPool.ts`.
 *  - DIP: the gate depends on `getStellar()` and the ledger record() — both
 *    swappable for tests.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import * as ledger from '../services/paidCallLedger';
import { getStellar } from '../services/stellar/client';
import { verifyHireProof, type ProofBundle } from '../services/zk/verifier';
import { stroopsToUsdc, usdcToStroops, type PaymentMode, type StellarPaymentChallenge } from '@openx/sdk';
import type { AuthRequest } from './auth';

const PAYMENT_SECRET = process.env.PAYMENT_SECRET ?? 'dev-only-rotate-me';
const NETWORK_TAG: string = `stellar:${process.env.STELLAR_NETWORK ?? 'testnet'}`;
const PRIVATE_TIER_MULTIPLIER = Number(process.env.PRIVATE_TIER_MULTIPLIER ?? 1.5);

export interface StellarPriceableRequest extends AuthRequest {
  pricedAgent?: {
    id: string;
    slug: string;
    seller_id: number | null;
    pricing: { x402?: string | null } | null;
    soroban_agent_id?: string | null;
  };
  receipt?: {
    tx_hash: string;
    amount_usdc: string;
    payment_mode: PaymentMode;
  };
}

function signNonce(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', PAYMENT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyNonce(token: string): (Record<string, unknown> & { exp: number }) | null {
  try {
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', PAYMENT_SECRET).update(body).digest('base64url');
    if (sig !== expected) return null;
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildChallenge(
  agent: NonNullable<StellarPriceableRequest['pricedAgent']>,
  mode: PaymentMode,
): StellarPaymentChallenge {
  const basePrice = agent.pricing?.x402 ?? '0';
  const baseStroops = usdcToStroops(basePrice);
  const stroops =
    mode === 'private'
      ? (baseStroops * BigInt(Math.round(PRIVATE_TIER_MULTIPLIER * 1000))) / 1000n
      : baseStroops;

  const exp = Date.now() + 5 * 60 * 1000;
  const nonceTok = signNonce({
    aid: agent.soroban_agent_id ?? agent.id,
    mode,
    stroops: stroops.toString(),
    exp,
  });

  return {
    network: NETWORK_TAG as `stellar:${string}`,
    asset: 'USDC',
    amount_stroops: stroops.toString(),
    // Private mode advertises the ZK Privacy Pool contract when it's
    // configured (so the smoke + integrators see the privacy-stack
    // contract). When the pool is unset we fall through to the paywall
    // router. Verification accepts events from either contract (see
    // settlementContractIds() — the platform-relay path keeps working as
    // the graceful fallback when buyer has no shielded deposit).
    contract_id: settlementContractIds(mode)[0],
    agent_id: agent.soroban_agent_id ?? agent.id.replaceAll('-', ''),
    nonce: nonceTok,
    expires_at: exp,
    payment_mode: mode,
    display_amount_usdc: (Number(stroops) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
  };
}

/**
 * settlementContractIds — single source of truth for "which Soroban
 * contract(s) may legitimately settle this payment mode".
 *
 *  public  → [paywallRouter]
 *  private → [usdcSacId, privacyPool, privacyPoolToken, paywallRouter]
 *            v3.2 default is the platform-relay strategy: buyer signs a USDC
 *            SAC.transfer(buyer → platform) — the SAC contract emits the
 *            settlement event we verify. The pool contracts stay accepted
 *            for the v3.3 ZK opt-in path (see docs/runbooks/ZK_DEPLOY.md);
 *            paywallRouter remains as a legacy fallback.
 */
function settlementContractIds(mode: PaymentMode): string[] {
  const s = getStellar();
  if (mode === 'private') {
    const ids: string[] = [s.usdcSacId];
    if (s.contracts.privacyPool) ids.push(s.contracts.privacyPool);
    if (s.contracts.privacyPoolToken) ids.push(s.contracts.privacyPoolToken);
    ids.push(s.contracts.paywallRouter);
    return ids;
  }
  return [s.contracts.paywallRouter];
}

/**
 * verifyZkHeaders — decode + verify the buyer's Groth16 proof off the request.
 *
 * Headers:
 *   x-zk-proof   base64(proof JSON — snarkjs shape)
 *   x-zk-public  base64(publicSignals JSON — [commitment, agent_bind, agent_id])
 *
 * We validate the proof against the vk at services/zk/verification_key.json
 * AND enforce publicSignals[2] === Keccak(slug)[:31] so a proof for agent A
 * cannot be replayed against agent B.
 */
async function verifyZkHeaders(
  req: Request,
  agentSlug: string,
): Promise<{ ok: true; commitment: string } | { ok: false; reason: string }> {
  const proofHdr = req.headers['x-zk-proof'] as string | undefined;
  const publicsHdr = req.headers['x-zk-public'] as string | undefined;
  if (!proofHdr || !publicsHdr) return { ok: false, reason: 'x-zk-proof / x-zk-public required for private tier' };
  let bundle: ProofBundle;
  try {
    bundle = {
      proof: JSON.parse(Buffer.from(proofHdr, 'base64').toString('utf8')),
      publicSignals: JSON.parse(Buffer.from(publicsHdr, 'base64').toString('utf8')),
    };
  } catch {
    return { ok: false, reason: 'x-zk-proof / x-zk-public base64/JSON decode failed' };
  }
  const r = await verifyHireProof(bundle, { expectedAgentSlug: agentSlug });
  if ('reason' in r) {
    return { ok: false, reason: r.reason };
  }
  return { ok: true, commitment: r.commitment };
}

async function verifyTxHash(
  txHash: string,
  expectedContractIds: string[],
): Promise<{ ledger: number } | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const s = getStellar();
  try {
    const r = await s.rpc.getTransaction(txHash);
    if (r.status !== 'SUCCESS') return null;
    // Cheap heuristic — Soroban events for any acceptable settlement
    // contract id must be present in the same ledger.
    const eventsResp = await s.rpc.getEvents({
      startLedger: r.ledger,
      filters: [{ type: 'contract', contractIds: expectedContractIds }],
      limit: 50,
    });
    const matches = eventsResp.events.some((e) => e.txHash === txHash);
    return matches ? { ledger: r.ledger } : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, txHash }, 'stellarPaymentGate:verify-error');
    return null;
  }
}

export async function stellarPaymentGate(
  req: StellarPriceableRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const slug = (req.params.id ?? req.params.agentId ?? req.params.slug) as string | undefined;
  if (!slug) {
    res.status(400).json({ error: 'agent id required' });
    return;
  }
  const r = await pool.query(
    `SELECT id, slug, seller_id, pricing, soroban_agent_id
       FROM agents WHERE (id::text = $1 OR slug = $1)
              AND published = true AND archived_at IS NULL`,
    [slug],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const agent = r.rows[0];
  req.pricedAgent = agent;

  // Strict-chain policy (v3.1): every paywalled call MUST settle on Soroban.
  // The v3.0 "demo short-circuit" (free answer when soroban_agent_id is
  // null) is gone — it silently bypassed wallet signing and USDC payment,
  // which broke the private-x402 contract this gate exists to enforce.
  // Atomic publish now guarantees `soroban_agent_id` is populated when
  // `published=true`; the 412 below is the defensive last line for any
  // legacy row left in a half-published state.
  if (!agent.soroban_agent_id) {
    res.status(412).json({
      error: 'agent_pending_onchain_registration',
      detail:
        'This agent has no Soroban registration yet — ask the seller to (re-)publish so the on-chain agent_id is committed.',
    });
    return;
  }

  const mode = ((req.headers['x-payment-mode'] as string) ?? 'public').toLowerCase() as PaymentMode;
  if (mode !== 'public' && mode !== 'private') {
    res.status(400).json({ error: 'invalid X-PAYMENT-MODE; expected public|private' });
    return;
  }

  // PRD-G credit-first short-circuit (chain-agnostic). When buyer has enough
  // balance in `buyer_credits`, debit and bypass the chain dance.
  if (process.env.FEATURE_CREDIT_SYSTEM === 'true') {
    const buyer = req.user?.address;
    const price = agent.pricing?.x402;
    if (buyer && price && Number(price) > 0) {
      try {
        const credits = await import('../services/creditService');
        const debit = await credits.tryDebit({
          wallet_address: buyer,
          amount_usdc: price,
          agent_id: agent.id,
          seller_id: agent.seller_id ?? null,
        });
        if (debit.ok) {
          await ledger.record({
            agentId: agent.id,
            slug: agent.slug,
            buyer,
            amountUsdc: String(price),
            txHash: `credit-${debit.ledger_id}`,
            network: NETWORK_TAG,
            method: 'credit',
            sellerId: agent.seller_id ?? null,
          });
          res.setHeader('X-Credit-Balance', debit.new_balance);
          req.receipt = { tx_hash: `credit-${debit.ledger_id}`, amount_usdc: String(price), payment_mode: 'public' };
          next();
          return;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'stellarPaymentGate:credit-debit:failed');
      }
    }
  }

  const xPayment = (req.headers['x-payment'] as string | undefined) ?? '';
  if (!xPayment.startsWith('stellar ')) {
    res.status(402).json(buildChallenge(agent, mode));
    return;
  }
  const [, txHash] = xPayment.trim().split(/\s+/);
  const nonceTok = req.headers['x-payment-nonce'] as string | undefined;
  const nonce = nonceTok ? verifyNonce(nonceTok) : null;
  if (!nonce || nonce.mode !== mode) {
    res.status(402).json(buildChallenge(agent, mode));
    return;
  }
  const expectedContracts = settlementContractIds(mode);
  const verified = await verifyTxHash(txHash, expectedContracts);
  if (!verified) {
    res.status(402).json(buildChallenge(agent, mode));
    return;
  }

  // Private tier: also require a valid Groth16 ZK proof bound to this agent.
  // Real snarkjs proof; server-side verification (Path B'); on-chain verifier
  // deployment is v3.4. See docs/runbooks/ZK_DEPLOY.md.
  let zkCommitment: string | null = null;
  if (mode === 'private') {
    const zkResult = await verifyZkHeaders(req, agent.slug);
    if ('reason' in zkResult) {
      logger.info({ slug: agent.slug, reason: zkResult.reason }, 'stellarPaymentGate:zk-reject');
      res.status(402).json({ ...buildChallenge(agent, mode), zk_error: zkResult.reason });
      return;
    }
    zkCommitment = zkResult.commitment;
    // Replay-protection: reject if the same commitment already settled.
    if (await ledger.isZkCommitmentUsed(zkCommitment)) {
      logger.info({ slug: agent.slug, commitment: zkCommitment.slice(0, 12) }, 'stellarPaymentGate:zk-replay');
      res.status(402).json({ ...buildChallenge(agent, mode), zk_error: 'proof replay: commitment already used' });
      return;
    }
  }
  await ledger.record({
    agentId: agent.id,
    slug: agent.slug,
    buyer: req.user?.address ?? 'anonymous',
    amountUsdc: stroopsToUsdc(BigInt(String(nonce.stroops ?? '0'))),
    txHash,
    network: NETWORK_TAG,
    method: mode === 'private' ? 'privacy_pool' : 'stellar_x402',
    sellerId: agent.seller_id ?? null,
    zkCommitment,
  });
  req.receipt = {
    tx_hash: txHash,
    amount_usdc: String(nonce.stroops ?? '0'),
    payment_mode: mode,
  };
  next();
}
