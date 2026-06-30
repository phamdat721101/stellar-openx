/**
 * /api/v1/credits — Coinflow Stellar SEP-24 fiat-onramp top-ups.
 *
 * Replaces the x402-USDC-on-Arbitrum top-up flow. The new shape:
 *   1. Buyer POSTs `/buy-pack-25` (or 50 / 100) with `{ stellar_address }`.
 *      → API creates a Coinflow SEP-24 session and returns `{ hostedUrl }`.
 *   2. Buyer is redirected to `hostedUrl` (iframe) → pays SEPA / Apple Pay /
 *      Card → Coinflow delivers USDC to the buyer's Stellar wallet.
 *   3. Coinflow webhook → POSTs `/webhook` here → we credit `buyer_credits`.
 */

import express, { type Request, type Response } from 'express';
import { logger } from '../lib';
import * as credits from '../services/creditService';
import {
  createDepositSession,
  getDepositStatus,
  verifyWebhook,
} from '../services/stellar/anchorOnramp';

const router = express.Router();

const PACKS = String(process.env.CREDIT_TOPUP_PACKS ?? '25,50,100')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

router.get('/.well-known/agent.json', (_req: Request, res: Response) => {
  res.json({
    name: 'openx-s-credits',
    description: 'Top up OpenX credit balance with fiat (SEPA / Card / Apple Pay) via Coinflow Stellar.',
    network: process.env.STELLAR_NETWORK ?? 'testnet',
    asset: 'USDC',
    packs: PACKS,
  });
});

router.post('/buy-pack-:usd', async (req: Request, res: Response) => {
  if (process.env.FEATURE_CREDIT_SYSTEM !== 'true') {
    return res.status(404).json({ error: 'credit system disabled' });
  }
  const usd = Number(req.params.usd);
  if (!PACKS.includes(usd)) {
    return res.status(404).json({ error: `unknown pack — valid: ${PACKS.join(', ')}` });
  }
  const stellarAddress = (req.body?.stellar_address as string) ?? '';
  if (!/^G[A-Z2-7]{55}$/.test(stellarAddress)) {
    return res.status(400).json({ error: 'stellar_address (G…) required' });
  }
  try {
    const session = await createDepositSession(stellarAddress, usd);
    res.json({
      pack_usdc: usd,
      hosted_url: session.hostedUrl,
      session_id: session.sessionId,
      expires_at: session.expiresAt,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'credits-topup:session-create-failed');
    res.status(503).json({ error: 'coinflow_session_failed' });
  }
});

router.get('/status/:sessionId', async (req: Request, res: Response) => {
  try {
    const status = await getDepositStatus(req.params.sessionId);
    res.json(status);
  } catch (err) {
    res.status(503).json({ error: 'coinflow_status_failed', detail: (err as Error).message });
  }
});

/** Coinflow webhook — HMAC-signed; idempotent on session_id. */
router.post(
  '/webhook',
  express.raw({ type: '*/*' }),
  async (req: Request, res: Response) => {
    try {
      const signature = req.headers['x-coinflow-signature'] as string | undefined;
      if (!signature) return res.status(400).json({ error: 'missing signature' });
      const event = verifyWebhook(req.body.toString('utf8'), signature);
      if (event.status !== 'completed' || !event.amount_usdc || !event.buyer_address) {
        return res.json({ ok: true, noop: true });
      }
      const r = await credits.grant({
        wallet_address: event.buyer_address,
        amount_usdc: Number(event.amount_usdc),
        kind: 'purchase',
        tx_hash: event.tx_hash ?? `coinflow-${event.sessionId}`,
        meta: { source: 'coinflow-stellar', session_id: event.sessionId },
      });
      res.json({ ok: true, ...r });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'credits-topup:webhook:failed');
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

export default router;
