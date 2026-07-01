/**
 * /v3/marketplace — seller-publish + buyer-browse marketplace API.
 *
 * Stellar-native rewrite. Includes the two helpers the frontend hire flow
 * needs:
 *   POST /seller/agent/:id/build-hire-xdr  → server-prepared Soroban XDR
 *   POST /submit                           → submits a signed XDR via RPC
 */

import { Router, type Response } from 'express';
import { logger } from '../lib';
import { pool } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { sellerPublishService } from '../services/sellerPublishService';
import {
  buildHireAgentXdr,
  buildPlatformRelayHireXdr,
} from '../services/stellar/marketplace';
import {
  buildTransactXdr,
  type ExtDataJson,
  type PoolProofJson,
} from '../services/stellar/privacyPool';
import { getStellar } from '../services/stellar/client';
import * as credits from '../services/creditService';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import { usdcToStroops, type PaymentMode } from '@openx/sdk';

const router = Router();

// ─── Public catalog ───────────────────────────────────────────────────────

router.get('/listings', async (req, res) => {
  const cursor = req.query.cursor ? Number(req.query.cursor) : 0;
  const limit = Math.min(Number(req.query.limit ?? 24), 50);
  const r = await pool.query(
    `SELECT id, slug, owner_address, persona, pricing, soroban_agent_id, created_at
       FROM agents
      WHERE published = true AND archived_at IS NULL
   ORDER BY created_at DESC
      OFFSET $1 LIMIT $2`,
    [cursor, limit],
  );
  res.json({
    listings: r.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      seller: row.owner_address,
      persona: row.persona,
      pricing: row.pricing,
      soroban_agent_id: row.soroban_agent_id,
      price_usdc: row.pricing?.x402 ?? '0',
      created_at: row.created_at,
    })),
    next_cursor: r.rowCount === limit ? cursor + limit : null,
  });
});

// ─── Seller publish ───────────────────────────────────────────────────────

router.post('/seller/publish', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { slug, persona, price_usdc, manifest } = (req.body ?? {}) as {
    slug?: string;
    persona?: { system_prompt: string; model?: string; tools?: string[] };
    price_usdc?: string;
    manifest?: Record<string, unknown>;
  };
  if (!slug || !/^[a-z0-9-]{3,40}$/.test(slug)) {
    return res.status(400).json({ error: 'slug invalid' });
  }
  if (!persona?.system_prompt) return res.status(400).json({ error: 'persona.system_prompt required' });
  if (!price_usdc || isNaN(Number(price_usdc)) || Number(price_usdc) <= 0) {
    return res.status(400).json({ error: 'price_usdc must be a positive number' });
  }
  try {
    const result = await sellerPublishService.publish({
      seller: req.user.address,
      slug,
      persona,
      price_usdc,
      manifest: manifest ?? {},
    });
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    logger.warn({ err: msg, slug }, 'marketplace:publish:failed');
    if (msg.includes('duplicate')) return res.status(409).json({ error: 'slug taken' });
    res.status(500).json({ error: 'publish_failed', detail: msg.slice(0, 200) });
  }
});

router.get('/seller/agent/:id/onchain-status', async (req, res) => {
  const r = await pool.query(
    `SELECT id, slug, soroban_agent_id, stellar_tx_hash FROM agents WHERE id = $1`,
    [req.params.id],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
  res.json(r.rows[0]);
});

// ─── Hire-flow helpers ────────────────────────────────────────────────────

router.post('/seller/agent/:id/build-hire-xdr', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { payment_mode, nonce } = (req.body ?? {}) as { payment_mode?: PaymentMode; nonce?: string };
  if (payment_mode !== 'public' && payment_mode !== 'private') {
    return res.status(400).json({ error: 'payment_mode required' });
  }
  const r = await pool.query(
    `SELECT soroban_agent_id, pricing FROM agents WHERE id = $1`,
    [req.params.id],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
  const sorobanAgentId = r.rows[0].soroban_agent_id as string | null;
  if (!sorobanAgentId) return res.status(412).json({ error: 'agent not registered on chain' });
  const queryHash = nonce
    ? Buffer.from(nonce.split('.')[0] ?? '', 'base64url').subarray(0, 32)
    : Buffer.alloc(32);

  if (payment_mode === 'public') {
    const xdr = await buildHireAgentXdr(
      req.user.address,
      Buffer.from(sorobanAgentId, 'hex'),
      queryHash,
      'public',
    );
    return res.json({ xdr, payment_mode });
  }

  // Private mode (v3.2 default) — platform-relay strategy. Buyer signs a
  // single USDC SAC transfer to the platform account (counterparty invisible
  // on chain). Off-chain reconciliation via paid-call-ledger. The full ZK
  // strategy lives at POST /build-private-transact-xdr and is opt-in for
  // v3.3 once the operator picks Path A/B in docs/runbooks/ZK_DEPLOY.md.
  const basePrice = (r.rows[0].pricing?.x402 as string | undefined) ?? '0';
  if (!basePrice || Number(basePrice) <= 0) {
    return res.status(412).json({ error: 'agent has no on-chain price' });
  }
  const multiplier = Number(process.env.PRIVATE_TIER_MULTIPLIER ?? 1.5);
  const baseStroops = usdcToStroops(basePrice);
  const totalStroops = (baseStroops * BigInt(Math.round(multiplier * 1000))) / 1000n;
  try {
    const xdr = await buildPlatformRelayHireXdr(req.user.address, totalStroops);
    return res.json({
      xdr,
      payment_mode,
      amount_stroops: totalStroops.toString(),
      strategy: 'platform-relay',
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'marketplace:build-private-relay:failed');
    return res.status(500).json({ error: 'build_private_hire_failed', detail: (err as Error).message });
  }
});

// POST /build-private-transact-xdr — buyer submits their client-generated
// Groth16 proof + ExtData; server encodes them to ScVal and returns the
// prepared XDR envelope for the wallet to co-sign.
router.post('/build-private-transact-xdr', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { proof, ext_data } = (req.body ?? {}) as {
    proof?: PoolProofJson;
    ext_data?: ExtDataJson;
  };
  if (!proof || !ext_data) return res.status(400).json({ error: 'proof + ext_data required' });
  try {
    const xdr = await buildTransactXdr({ sender: req.user.address, proof, extData: ext_data });
    res.json({ xdr, payment_mode: 'private' });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'marketplace:build-private-transact:failed');
    res.status(500).json({ error: 'build_private_transact_failed', detail: (err as Error).message });
  }
});

router.post('/submit', async (req: AuthRequest, res: Response) => {
  const { signed_xdr } = (req.body ?? {}) as { signed_xdr?: string };
  if (!signed_xdr) return res.status(400).json({ error: 'signed_xdr required' });
  try {
    const s = getStellar();
    const tx = TransactionBuilder.fromXDR(signed_xdr, s.passphrase);
    // Cast — fromXDR returns Transaction | FeeBumpTransaction; submit accepts both via rpc.
    const sendRes = await s.rpc.sendTransaction(tx as never);
    if (sendRes.status === 'ERROR') {
      return res.status(400).json({ error: 'send_failed', detail: sendRes.errorResult });
    }
    // Poll for confirmation.
    let attempt = 0;
    while (attempt < 30) {
      const r = await s.rpc.getTransaction(sendRes.hash);
      if (r.status === 'SUCCESS') return res.json({ tx_hash: sendRes.hash, ledger: r.ledger });
      if (r.status === 'FAILED') return res.status(400).json({ error: 'tx_failed', tx_hash: sendRes.hash });
      await new Promise((r) => setTimeout(r, 1_000));
      attempt += 1;
    }
    res.json({ tx_hash: sendRes.hash, status: 'pending' });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'marketplace:submit:failed');
    res.status(500).json({ error: 'submit_failed' });
  }
});

// ─── Credits read (chain-agnostic helper) ─────────────────────────────────

router.get('/credits/me', async (req: AuthRequest, res: Response) => {
  if (process.env.FEATURE_CREDIT_SYSTEM !== 'true') {
    return res.status(404).json({ error: 'credit_system_disabled' });
  }
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const account = await credits.ensureAccount({ wallet_address: req.user.address });
  res.json({
    wallet: account.wallet_address,
    balance_usdc: account.balance_usdc,
    welcome_granted: account.welcome_granted,
  });
});

router.get('/credits/config', (_req, res) => {
  res.json({
    network: process.env.STELLAR_NETWORK ?? 'testnet',
    asset: 'USDC',
    packs: String(process.env.CREDIT_TOPUP_PACKS ?? '25,50,100').split(',').map(Number),
    coinflow_enabled: Boolean(process.env.COINFLOW_STELLAR_API_KEY),
  });
});

// ─── Owner mutations ──────────────────────────────────────────────────────

router.post('/seller/agent/:id/archive', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const r = await pool.query(
    `UPDATE agents SET archived_at = NOW(), published = false
      WHERE id = $1 AND owner_address = $2
     RETURNING id`,
    [req.params.id, req.user.address],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found / not owner' });
  res.json({ ok: true });
});

export default router;
