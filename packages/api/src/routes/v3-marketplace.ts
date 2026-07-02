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
  buildAgentPayoutXdr,
  getAgentBalance,
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

// ─── Seller publish (wallet-signed, two-step) ─────────────────────────────
//
// The legacy `POST /seller/publish` (platform-signed, gasless) is retired
// in v3.3. Sellers must now sign the Soroban `register_agent` tx with their
// own wallet — the same trust model buyers use for /hire. This makes every
// listing on the marketplace a real on-chain register_agent tx by the
// seller, and eliminates the `soroban_agent_id=null` orphan class that
// showed up as "Awaiting on-chain registration" on the agent page.

interface PublishBody {
  slug?: string;
  display_name?: string;
  persona?: { system_prompt: string; model?: string; tools?: string[] };
  price_usdc?: string;
  manifest?: Record<string, unknown>;
}

function validatePublishBody(body: PublishBody): string | null {
  if (!body.slug || !/^[a-z0-9-]{3,40}$/.test(body.slug)) return 'slug invalid';
  if (!body.persona?.system_prompt || body.persona.system_prompt.trim().length < 20) {
    return 'persona.system_prompt required (min 20 chars)';
  }
  if (!body.price_usdc || isNaN(Number(body.price_usdc)) || Number(body.price_usdc) <= 0) {
    return 'price_usdc must be a positive number';
  }
  return null;
}

// Step 1 — build the unsigned XDR for the seller wallet to sign.
router.post('/seller/publish/build-xdr', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const body = (req.body ?? {}) as PublishBody;
  const invalid = validatePublishBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const out = await sellerPublishService.buildPublishXdr({
      seller: req.user.address,
      slug: body.slug!,
      display_name: body.display_name,
      persona: body.persona!,
      price_usdc: body.price_usdc!,
      manifest: body.manifest ?? {},
    });
    res.json(out);
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    logger.warn({ err: msg, slug: body.slug }, 'marketplace:publish:build-xdr:failed');
    if (msg.includes('duplicate')) return res.status(409).json({ error: 'slug taken' });
    res.status(500).json({ error: 'build_xdr_failed', detail: msg.slice(0, 200) });
  }
});

// Step 2 — submit the seller-signed XDR + mirror on-chain result into DB.
router.post('/seller/publish/confirm', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const body = (req.body ?? {}) as PublishBody & { signed_xdr?: string; existing_agent_id?: string | null };
  const invalid = validatePublishBody(body);
  if (invalid) return res.status(400).json({ error: invalid });
  if (!body.signed_xdr) return res.status(400).json({ error: 'signed_xdr required' });
  try {
    const result = await sellerPublishService.confirmPublish({
      seller: req.user.address,
      slug: body.slug!,
      display_name: body.display_name,
      persona: body.persona!,
      price_usdc: body.price_usdc!,
      manifest: body.manifest ?? {},
      signed_xdr: body.signed_xdr,
      existing_agent_id: body.existing_agent_id ?? null,
    });
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    logger.warn({ err: msg, slug: body.slug }, 'marketplace:publish:confirm:failed');
    if (msg.includes('duplicate')) return res.status(409).json({ error: 'slug taken' });
    res.status(500).json({ error: 'confirm_failed', detail: msg.slice(0, 200) });
  }
});

// Legacy `POST /seller/publish` (platform-signed) — 410 Gone.
// Anyone calling the old endpoint gets pointed at the new two-step flow.
router.post('/seller/publish', (_req: AuthRequest, res: Response) => {
  res.status(410).json({
    error: 'gone',
    message: 'Platform-signed publish retired in v3.3. Use POST /seller/publish/build-xdr → wallet sign → POST /seller/publish/confirm.',
  });
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

// ─── Escrow-protected hire (Trustless Work single-release) ────────────────
//
// PRD-T (v3.3). Three endpoints:
//   POST /escrow/build-action-xdr           dispatcher for deploy|fund|approve
//                                           |release|dispute — returns unsigned
//                                           XDR + contract_address + escrow_id
//   POST /escrow/submit                     wallet-signed XDR → TW /helper/
//                                           send-transaction + confirmAction()
//   POST /escrow/:contract/claim-timeout    seller after ESCROW_TIMEOUT_HOURS —
//                                           returns dispute XDR + schedules
//                                           auto-resolve in seller favor
//   POST /escrow/:contract/resolve          admin-only manual dispute resolver
//   GET  /escrow/me                          list my escrows (buyer or seller)
//   GET  /escrow/health                      cheap TW connectivity probe

router.get('/escrow/health', async (_req, res) => {
  const r = await tw.ping();
  res.json({ tw_ok: r.ok, base_url: tw.TW_CONFIG.BASE_URL, api_key_set: tw.TW_CONFIG.API_KEY_SET, ...r });
});

const VALID_ACTIONS = new Set(['deploy', 'fund', 'approve', 'release', 'dispute']);

router.post('/escrow/build-action-xdr', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { action, agent_id, contract_address, question } = (req.body ?? {}) as {
    action?: string;
    agent_id?: string;
    contract_address?: string;
    question?: string;
  };
  if (!action || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'action must be one of deploy|fund|approve|release|dispute' });
  }
  try {
    let out;
    if (action === 'deploy') {
      if (!agent_id) return res.status(400).json({ error: 'agent_id required for deploy' });
      out = await escrowService.buildDeployXdr({ buyer: req.user.address, agent_id, question });
    } else {
      if (!contract_address) return res.status(400).json({ error: 'contract_address required' });
      const dispatcher = {
        fund: () => escrowService.buildFundXdr({ buyer: req.user!.address, contract_address }),
        approve: () => escrowService.buildApproveXdr({ buyer: req.user!.address, contract_address }),
        release: () => escrowService.buildReleaseXdr({ buyer: req.user!.address, contract_address }),
        dispute: () => escrowService.buildDisputeXdr({ signer: req.user!.address, contract_address }),
      } as const;
      out = await dispatcher[action as keyof typeof dispatcher]();
    }
    res.json(out);
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    logger.warn({ err: msg, action }, 'marketplace:escrow:build-action-xdr:failed');
    const clientErr = /^(agent_not_found|escrow_not_found|not_buyer|not_participant|invalid_state|agent_has_no_price)/.test(msg);
    res.status(clientErr ? 400 : 500).json({ error: 'escrow_action_failed', detail: msg.slice(0, 200) });
  }
});

router.post('/escrow/submit', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { signed_xdr, contract_address, action } = (req.body ?? {}) as {
    signed_xdr?: string;
    contract_address?: string;
    action?: string;
  };
  if (!signed_xdr || !contract_address || !action || !VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'signed_xdr + contract_address + action required' });
  }
  try {
    const sendResp = await tw.sendTransaction(signed_xdr);
    if (sendResp.status !== 'SUCCESS') {
      return res.status(400).json({ error: 'tx_failed', detail: sendResp });
    }
    const tx_hash = sendResp.txHash ?? sendResp.hash ?? '';
    // Deploy special case: TW returns the deployed contract address (in one
    // of several possible field names — probe the common ones + returnValue).
    let real_contract_address: string | undefined;
    if (action === 'deploy') {
      const r = sendResp as unknown as Record<string, unknown>;
      real_contract_address = (r.contractId ?? r.escrowAddress ?? r.contractAddress ?? r.escrowContractAddress) as string | undefined;
      // Fallback: some TW versions embed the address in returnValue.contractId
      if (!real_contract_address && r.returnValue && typeof r.returnValue === 'object') {
        real_contract_address = (r.returnValue as Record<string, unknown>).contractId as string | undefined;
      }
    }
    const row = await escrowService.confirmAction({
      contract_address,
      action: action as 'deploy' | 'fund' | 'approve' | 'release' | 'dispute',
      tx_hash,
      real_contract_address,
    });
    res.json({
      ok: true,
      tx_hash,
      status: row.status,
      contract_address: row.contract_address,
    });
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    logger.warn({ err: msg, contract_address, action }, 'marketplace:escrow:submit:failed');
    res.status(500).json({ error: 'submit_failed', detail: msg.slice(0, 200) });
  }
});

// Seller-only: after ESCROW_TIMEOUT_HOURS of buyer inactivity, seller raises
// a dispute here. Server co-signs the resolve-in-seller-favor tx with the
// platform key (dispute resolver role) once the dispute tx lands. Two-step
// so the seller always signs (no platform impersonation).
router.post('/escrow/:contract/claim-timeout', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { contract } = req.params;
  try {
    const list = await escrowService.listForBuyerOrSeller(req.user.address);
    const escrow = list.find((e) => e.contract_address === contract);
    if (!escrow) return res.status(404).json({ error: 'escrow_not_found_for_caller' });
    if (escrow.seller_address !== req.user.address) return res.status(403).json({ error: 'not_seller' });
    if (escrow.status !== 'answered') return res.status(409).json({ error: `invalid_state:${escrow.status}` });
    if (!escrow.timeout_at || new Date(escrow.timeout_at).getTime() > Date.now()) {
      return res.status(409).json({
        error: 'not_yet_timed_out',
        timeout_at: escrow.timeout_at,
        hours: TIMEOUT_HOURS,
      });
    }
    const out = await escrowService.buildDisputeXdr({
      signer: req.user.address,
      contract_address: contract,
    });
    res.json({ ...out, auto_resolve_hint: 'After submit, call POST /escrow/:contract/auto-resolve-timeout' });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'marketplace:escrow:claim-timeout:failed');
    res.status(500).json({ error: 'claim_timeout_failed', detail: (err as Error).message.slice(0, 200) });
  }
});

// Called by the seller right after their dispute tx lands. Server signs the
// resolve tx with the platform key (dispute resolver) and pushes 100 % to
// seller. Guardrails: escrow must be `disputed`, past timeout, seller
// matches.
router.post('/escrow/:contract/auto-resolve-timeout', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { contract } = req.params;
  try {
    const list = await escrowService.listForBuyerOrSeller(req.user.address);
    const escrow = list.find((e) => e.contract_address === contract);
    if (!escrow) return res.status(404).json({ error: 'escrow_not_found_for_caller' });
    if (escrow.seller_address !== req.user.address) return res.status(403).json({ error: 'not_seller' });
    if (escrow.status !== 'disputed') return res.status(409).json({ error: `invalid_state:${escrow.status}` });
    if (!escrow.timeout_at || new Date(escrow.timeout_at).getTime() > Date.now()) {
      return res.status(409).json({ error: 'not_yet_timed_out' });
    }
    // Build resolve XDR (100 % → seller) and platform-sign it inline.
    const { xdr } = await escrowService.resolveDispute({
      contract_address: contract,
      buyer_bps: 0,
      seller_bps: 10000,
    });
    const s = getStellar();
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(xdr, s.passphrase);
    tx.sign(s.platformKeypair);
    const sendResp = await tw.sendTransaction(tx.toXDR());
    if (sendResp.status !== 'SUCCESS') {
      return res.status(500).json({ error: 'resolve_tx_failed', detail: sendResp });
    }
    const tx_hash = sendResp.txHash ?? sendResp.hash ?? '';
    const row = await escrowService.markResolved({ contract_address: contract, tx_hash, refund: false });
    res.json({ ok: true, tx_hash, status: row.status });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'marketplace:escrow:auto-resolve-timeout:failed');
    res.status(500).json({ error: 'auto_resolve_failed', detail: (err as Error).message.slice(0, 200) });
  }
});

// Admin-only manual dispute resolution (buyer-initiated bad-answer disputes).
router.post('/escrow/:contract/resolve', async (req: AuthRequest, res: Response) => {
  const adminList = (process.env.ADMIN_ADDRESSES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (!req.user?.address || !adminList.includes(req.user.address)) {
    return res.status(403).json({ error: 'admin_only' });
  }
  const { contract } = req.params;
  const { buyer_bps, seller_bps } = (req.body ?? {}) as { buyer_bps?: number; seller_bps?: number };
  if (typeof buyer_bps !== 'number' || typeof seller_bps !== 'number') {
    return res.status(400).json({ error: 'buyer_bps + seller_bps required (integer 0..10000)' });
  }
  try {
    const { xdr } = await escrowService.resolveDispute({
      contract_address: contract,
      buyer_bps,
      seller_bps,
    });
    const s = getStellar();
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(xdr, s.passphrase);
    tx.sign(s.platformKeypair);
    const sendResp = await tw.sendTransaction(tx.toXDR());
    if (sendResp.status !== 'SUCCESS') {
      return res.status(500).json({ error: 'resolve_tx_failed', detail: sendResp });
    }
    const tx_hash = sendResp.txHash ?? sendResp.hash ?? '';
    const row = await escrowService.markResolved({
      contract_address: contract,
      tx_hash,
      refund: buyer_bps === 10000,
    });
    res.json({ ok: true, tx_hash, status: row.status });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'marketplace:escrow:resolve:failed');
    res.status(500).json({ error: 'resolve_failed', detail: (err as Error).message.slice(0, 200) });
  }
});

router.get('/escrow/me', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const rows = await escrowService.listForBuyerOrSeller(req.user.address);
  res.json({ escrows: rows });
});

// Manual "Sync from chain" — explicit reconcile trigger for one contract.
// Same on-chain read as auto-reconcile in /escrow/me, but scoped to a single
// row so a stuck escrow can be healed without listing everything.
router.post('/escrow/:contract/reconcile', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  try {
    const before = await pool.query<{ status: string; seller_address: string; buyer_address: string }>(
      `SELECT status, seller_address, buyer_address FROM hire_escrows WHERE contract_address = $1 LIMIT 1`,
      [req.params.contract],
    );
    if (before.rowCount === 0) return res.status(404).json({ error: 'escrow_not_found' });
    if (![before.rows[0].buyer_address, before.rows[0].seller_address].includes(req.user.address)) {
      return res.status(403).json({ error: 'not_participant' });
    }
    // Trigger the same helper the list endpoint uses (private impl; simplest
    // access is via listForBuyerOrSeller which already reconciles first).
    await escrowService.listForBuyerOrSeller(req.user.address);
    const after = await pool.query<{ status: string }>(
      `SELECT status FROM hire_escrows WHERE contract_address = $1 LIMIT 1`,
      [req.params.contract],
    );
    res.json({
      before: before.rows[0].status,
      after: after.rows[0]?.status ?? before.rows[0].status,
      changed: before.rows[0].status !== after.rows[0]?.status,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, contract: req.params.contract }, 'marketplace:escrow:reconcile:failed');
    res.status(500).json({ error: 'reconcile_failed', detail: (err as Error).message.slice(0, 200) });
  }
});

// ─── Seller payout (wallet-signed withdraw from paid-call-ledger) ─────────
//
// Returns the seller's authoritative on-chain balance (stroops → USDC) plus
// an unsigned XDR that calls `paid-call-ledger.agent_payout(seller, agent_id,
// amount_stroops)`. The seller signs the tx envelope in the browser; the
// contract's `seller.require_auth()` is satisfied by the source-account
// auth shortcut. Submission reuses `POST /submit`.
//
// SOLID: SRP — route validates ownership + composes reader + builder. Chain
// knowledge stays in `services/stellar/marketplace`.

import { escrowService, TIMEOUT_HOURS } from '../services/trustlessWork/escrowService';
import * as tw from '../services/trustlessWork/client';
import { usdcToStroops as _usdcToStroops, stroopsToUsdc } from '@openx/sdk';
router.post('/seller/agent/:id/build-payout-xdr', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const r = await pool.query(
    `SELECT id, owner_address, soroban_agent_id
       FROM agents WHERE id = $1 LIMIT 1`,
    [req.params.id],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
  const row = r.rows[0] as { id: string; owner_address: string; soroban_agent_id: string | null };
  if (row.owner_address !== req.user.address) return res.status(403).json({ error: 'not_owner' });
  if (!row.soroban_agent_id) return res.status(412).json({ error: 'agent_not_on_chain' });

  const agentIdBuf = Buffer.from(row.soroban_agent_id, 'hex');
  const balanceStroops = await getAgentBalance(agentIdBuf);

  // Cross-rail breakdown so the seller understands where money actually is
  // when the on-chain withdrawable balance is 0 (SRP: one endpoint = one
  // authoritative view; frontend renders whatever we return).
  //   • withdrawable                     → paid-call-ledger balance
  //   • escrow_locked (in-flight)        → hire_escrows with pending status
  //   • direct_paid (already in wallet)  → privacy_pool relays + RELEASED
  //                                        escrows (buyer approved OR platform
  //                                        resolved in seller's favor).
  //
  // Note: `paid_calls` gets a row for escrow at answer-time, not release-time.
  // If we blindly summed method='escrow' we'd double-count with the locked
  // bucket. So we join back to hire_escrows and only count RELEASED/RESOLVED
  // rows in the direct bucket.
  const [lockedRes, directRes] = await Promise.all([
    pool.query<{ locked: string | null }>(
      `SELECT COALESCE(SUM(amount_usdc), 0)::text AS locked
         FROM hire_escrows
        WHERE agent_id = $1 AND seller_address = $2
          AND status IN ('funded', 'answered', 'disputed')`,
      [row.id, req.user.address],
    ),
    pool.query<{ paid: string | null }>(
      `SELECT COALESCE(SUM(amount_usdc), 0)::text AS paid FROM (
         -- privacy-pool relays: platform forwards to seller wallet.
         SELECT amount_usdc::numeric AS amount_usdc
           FROM paid_calls
          WHERE agent_id = $1 AND method = 'privacy_pool'
         UNION ALL
         -- escrow tier: only rows where TW has released funds to seller.
         SELECT amount_usdc::numeric AS amount_usdc
           FROM hire_escrows
          WHERE agent_id = $1 AND seller_address = $2
            AND status IN ('released', 'resolved')
       ) t`,
      [row.id, req.user.address],
    ),
  ]);
  const escrow_locked_usdc = String(lockedRes.rows[0]?.locked ?? '0');
  const direct_paid_usdc = String(directRes.rows[0]?.paid ?? '0');

  if (balanceStroops <= 0n) {
    return res.status(409).json({
      error: 'nothing_to_withdraw',
      balance_usdc: '0',
      balance_stroops: '0',
      escrow_locked_usdc,
      direct_paid_usdc,
      hint:
        Number(escrow_locked_usdc) > 0
          ? 'Escrow-tier hires are locked until the buyer clicks Approve. Watch the Escrow queue.'
          : Number(direct_paid_usdc) > 0
            ? 'Your escrow / private-tier earnings already landed directly in your USDC wallet — check your Stellar balance.'
            : 'No hires have settled to your paid-call-ledger balance yet.',
    });
  }

  // Optional partial withdraw. Missing / invalid → full balance.
  const requestedRaw = (req.body ?? {}).amount_usdc as string | undefined;
  let amountStroops = balanceStroops;
  if (typeof requestedRaw === 'string' && Number(requestedRaw) > 0) {
    const req_ = _usdcToStroops(requestedRaw);
    if (req_ > balanceStroops) {
      return res.status(400).json({
        error: 'amount_exceeds_balance',
        balance_usdc: stroopsToUsdc(balanceStroops),
        escrow_locked_usdc,
        direct_paid_usdc,
      });
    }
    amountStroops = req_;
  }

  try {
    const xdr = await buildAgentPayoutXdr(req.user.address, agentIdBuf, amountStroops);
    res.json({
      xdr,
      agent_id: row.id,
      soroban_agent_id: row.soroban_agent_id,
      balance_usdc: stroopsToUsdc(balanceStroops),
      amount_usdc: stroopsToUsdc(amountStroops),
      amount_stroops: amountStroops.toString(),
      escrow_locked_usdc,
      direct_paid_usdc,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, agent: row.id }, 'marketplace:build-payout-xdr:failed');
    res.status(500).json({ error: 'build_payout_failed', detail: (err as Error).message.slice(0, 200) });
  }
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
