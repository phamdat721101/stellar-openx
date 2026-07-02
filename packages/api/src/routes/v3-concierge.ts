/**
 * /v3/concierge — RETIRED in v3.3.
 *
 * The free/gasless natural-language onboard path used to insert an
 * `agents` row without registering the agent on Soroban. That row surfaced
 * to buyers as the amber banner "Awaiting on-chain registration — the
 * seller must publish this agent before buyers can pay USDC" and blocked
 * every hire attempt.
 *
 * Publishing now requires the seller to sign a Soroban `register_agent`
 * transaction with their own wallet:
 *   POST /v3/marketplace/seller/publish/build-xdr  → server prepares XDR
 *   POST /v3/marketplace/seller/publish/confirm    → server submits signed XDR
 *
 * This module is kept as a 410-Gone shim so third-party integrations that
 * still point at `/v3/concierge/onboard` fail loudly with a migration hint,
 * and so `GET /v3/concierge/config` keeps returning `enabled: false` for
 * older UI clients that gate a UI element on the feature flag.
 */

import { Router, type Request, type Response } from 'express';

const router = Router();

const RETIRED_BODY = {
  error: 'gone',
  message:
    'Free onboard retired in v3.3. Publishing an agent now requires a Stellar wallet signature. Connect a wallet at /studio and mint on-chain.',
  replacement: {
    build_xdr: 'POST /v3/marketplace/seller/publish/build-xdr',
    confirm: 'POST /v3/marketplace/seller/publish/confirm',
  },
} as const;

router.post('/onboard', (_req: Request, res: Response) => res.status(410).json(RETIRED_BODY));

router.get('/config', (_req: Request, res: Response) =>
  res.json({
    enabled: false,
    retired: true,
    network: `stellar:${process.env.STELLAR_NETWORK ?? 'testnet'}`,
    replacement: RETIRED_BODY.replacement,
  }),
);

export default router;
