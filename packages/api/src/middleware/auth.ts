/**
 * auth middleware — Stellar wallet-address based.
 *
 * Replaces the EVM x-wallet-address + x-fhenix-permit dual scheme with one
 * simple `x-stellar-address` header (G…) plus a public-paths whitelist.
 * No FHE permit verification any more; identity is the Stellar account id.
 *
 * SOLID:
 *  - SRP: this middleware only proves wallet identity. Per-route ownership
 *    and KYA gating live in each sub-router.
 *  - OCP: PUBLIC_PATHS is data, not code — adding a route is one regex add.
 */

import type { NextFunction, Request, Response } from 'express';

export const AUTH_HEADER = 'x-stellar-address';

export interface AuthRequest extends Request {
  user?: { address: string };
}

const PUBLIC_PATHS: RegExp[] = [
  /^\/version$/,
  /^\/agents$/,
  /^\/agents\/top$/,
  /^\/agents\/search$/,
  /^\/agents\/slug-available$/,
  /^\/agents\/[^/]+\/recent-calls$/,
  /^(?:\/marketplace)?\/listings$/,
  /^\/discover$/,
  /^\/credits\/config$/,
  /^\/dashboard\/stats$/,
  // PRD-T-S — Raven WorkOS OAuth redirect lands here from the browser with a
  // `state=<owner>`; no wallet header is present yet, so it must be public.
  /^\/raven\/oauth\/callback$/,
];

const STELLAR_ADDR_RE = /^G[A-Z2-7]{55}$/;

export const auth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  if (PUBLIC_PATHS.some((re) => re.test(req.path))) {
    next();
    return;
  }
  const address = req.headers[AUTH_HEADER] as string | undefined;
  if (!address || !STELLAR_ADDR_RE.test(address)) {
    res.status(401).json({ error: `${AUTH_HEADER} required (Stellar G… account)` });
    return;
  }
  req.user = { address };
  await ensureCreditAccountIfEnabled(req, address);
  next();
};

async function ensureCreditAccountIfEnabled(req: AuthRequest, walletAddress: string): Promise<void> {
  if (process.env.FEATURE_CREDIT_SYSTEM !== 'true') return;
  try {
    const credits = await import('../services/creditService');
    await credits.ensureAccount({ wallet_address: walletAddress });
  } catch {
    /* non-fatal */
  }
}
