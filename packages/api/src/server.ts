/**
 * server.ts — OpenX-S API (Stellar-native v3.0.0).
 *
 * Surface kept byte-identical wherever possible (`/v3` marketplace + `/api/v1`
 * paywalled brain + `/api/v1/credits` Coinflow onramp + `/upload` + health/
 * metrics/openapi). Everything chain-specific is concentrated under
 * `middleware/stellarPaymentGate` and `services/stellar/*`.
 */

import dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import express from 'express';
import { auth } from './middleware/auth';
import uploadRouter from './routes/upload';
import openapiRouter from './routes/openapi';
import v3Router from './routes/v3';
import v3MarketplaceRouter from './routes/v3-marketplace';
import v3ConciergeRouter from './routes/v3-concierge';
import v1PublicRouter from './routes/v1Public';
import creditsTopupRouter from './routes/credits-topup';
import {
  correlationId,
  healthHandler,
  installLifecycle,
  logger,
  metricsHandler,
  metricsMiddleware,
} from './lib';
import { getStellar } from './services/stellar/client';

const app = express();
app.use(cors());
app.use(correlationId());
app.use(metricsMiddleware());
app.use(express.json({ limit: '4mb' }));

// Diagnostics.
app.get('/health', healthHandler);
app.get('/metrics', metricsHandler);

// /v3 marketplace surface (auth-gated; public paths whitelisted in auth.ts).
// /v3/concierge is mounted FIRST so it bypasses the wallet-address auth — the
// onboard endpoint is intentionally permissionless (sellers may not have a
// Stellar wallet yet). Abuse defense: in-process rate limit + Turnstile.
app.use('/v3/concierge', v3ConciergeRouter);
app.use('/v3', auth, v3Router);
app.use('/v3/marketplace', auth, v3MarketplaceRouter);

// /api/v1 — paywalled. The Stellar payment gate is the auth (mounted per-route).
app.use('/api/v1/credits', creditsTopupRouter);
app.use('/api/v1', v1PublicRouter);

// Static surface.
app.use('/upload', auth, uploadRouter);
app.use('/openapi.json', openapiRouter);
app.get('/platform', (_req, res) =>
  res.json({
    network: process.env.STELLAR_NETWORK ?? 'testnet',
    contracts: {
      agentRegistry: process.env.STELLAR_AGENT_REGISTRY_ID ?? '',
      paywallRouter: process.env.STELLAR_PAYWALL_ROUTER_ID ?? '',
      paidCallLedger: process.env.STELLAR_PAID_CALL_LEDGER_ID ?? '',
      privacyPool: process.env.STELLAR_PRIVACY_POOL_ID ?? '',
      privacyPoolToken: process.env.STELLAR_PRIVACY_POOL_TOKEN_ID ?? '',
      aspMembership: process.env.STELLAR_ASP_MEMBERSHIP_ID ?? '',
      aspNonMembership: process.env.STELLAR_ASP_NON_MEMBERSHIP_ID ?? '',
      groth16Verifier: process.env.STELLAR_GROTH16_VERIFIER_ID ?? '',
    },
  }),
);

// Boot-time env validation.
const REQUIRED = [
  'DATABASE_URL',
  'STELLAR_NETWORK',
  'STELLAR_PLATFORM_SECRET_KEY',
  'STELLAR_AGENT_REGISTRY_ID',
  'STELLAR_PAYWALL_ROUTER_ID',
  'STELLAR_PAID_CALL_LEDGER_ID',
];
const missing = REQUIRED.filter((v) => !process.env[v]);
if (missing.length) {
  logger.error({ missing }, 'Missing required env vars — exiting');
  process.exit(1);
}
try {
  getStellar();
} catch (err) {
  logger.error({ err: (err as Error).message }, 'stellar:init:failed');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3001);
const server = app.listen(PORT, () => logger.info({ port: PORT }, 'api:listening'));

// PRD-T stale-escrow notifier — every 5 min, log/notify sellers whose escrows
// crossed the ESCROW_TIMEOUT_HOURS threshold so they know to click "Claim
// overdue" in Studio. No auto-action here (seller must sign the dispute tx).
const STALE_INTERVAL_MS = 5 * 60 * 1000;
setInterval(async () => {
  try {
    const { escrowService } = await import('./services/trustlessWork/escrowService');
    const rows = await escrowService.listStale();
    if (rows.length > 0) {
      logger.info({ count: rows.length }, 'escrow:stale:tick');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'escrow:stale:tick:failed');
  }
}, STALE_INTERVAL_MS).unref();

installLifecycle(server);
