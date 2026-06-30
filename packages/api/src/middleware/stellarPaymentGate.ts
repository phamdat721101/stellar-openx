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
import { usdcToStroops, type PaymentMode, type StellarPaymentChallenge } from '@openx/sdk';
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
  const s = getStellar();
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
    // v3.0.0 — both modes settle through paywall-router (private uses the
    // platform-relay 2-op tx; the on-chain contract that emits the 'hire'
    // event is paywall-router in both cases). Privacy-pool contract is
    // reserved for the v3.1 Groth16 swap behind the same `mode='private'`
    // API surface.
    contract_id: s.contracts.paywallRouter,
    agent_id: agent.soroban_agent_id ?? agent.id.replaceAll('-', ''),
    nonce: nonceTok,
    expires_at: exp,
    payment_mode: mode,
    display_amount_usdc: (Number(stroops) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
  };
}

async function verifyTxHash(txHash: string, expectedContractId: string): Promise<{ ledger: number } | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const s = getStellar();
  try {
    const r = await s.rpc.getTransaction(txHash);
    if (r.status !== 'SUCCESS') return null;
    // Cheap heuristic — Soroban events for the matching contract id must be present.
    const eventsResp = await s.rpc.getEvents({
      startLedger: r.ledger,
      filters: [{ type: 'contract', contractIds: [expectedContractId] }],
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

  // Off-chain demo short-circuit — when the agent has no soroban_agent_id
  // (chain registration was skipped or failed) the on-chain payment path is
  // unavailable. To keep the buyer hire flow useful for testing the same way
  // fhe-ai-context's freemium hire works, we treat the call as a free demo:
  // record `method='demo'` and let the request through without 402. The
  // ledger row makes the call visible in /agent/:id recent transactions.
  if (!agent.soroban_agent_id) {
    await ledger.record({
      agentId: agent.id,
      slug: agent.slug,
      buyer: req.user?.address ?? 'anonymous',
      amountUsdc: '0',
      txHash: `demo-${crypto.randomUUID()}`,
      network: NETWORK_TAG,
      method: 'demo',
      sellerId: agent.seller_id ?? null,
    });
    req.receipt = { tx_hash: 'demo', amount_usdc: '0', payment_mode: 'public' };
    next();
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
  const expectedContract = getStellar().contracts.paywallRouter;
  const verified = await verifyTxHash(txHash, expectedContract);
  if (!verified) {
    res.status(402).json(buildChallenge(agent, mode));
    return;
  }
  await ledger.record({
    agentId: agent.id,
    slug: agent.slug,
    buyer: req.user?.address ?? 'anonymous',
    amountUsdc: String(nonce.stroops ?? '0'),
    txHash,
    network: NETWORK_TAG,
    method: mode === 'private' ? 'privacy_pool' : 'stellar_x402',
    sellerId: agent.seller_id ?? null,
  });
  req.receipt = {
    tx_hash: txHash,
    amount_usdc: String(nonce.stroops ?? '0'),
    payment_mode: mode,
  };
  next();
}
