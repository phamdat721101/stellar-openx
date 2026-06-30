/**
 * /v3/concierge — natural-language onboarding fast-path on Stellar.
 *
 * Mounted at /v3/concierge in server.ts BEFORE /v3 so it bypasses the
 * `x-stellar-address` auth (the onboard endpoint is intentionally
 * permissionless — sellers may not have a Stellar wallet yet).
 *
 * Abuse defense: in-process sliding-window rate limit + optional Cloudflare
 * Turnstile.
 *
 * SOLID:
 *   • SRP — HTTP shell only. All logic lives in conciergeOnboardService.
 *   • DIP — depends on IConciergeOnboardService; swappable in tests.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib';
import { conciergeOnboardService } from '../services/conciergeOnboardService';

const router = Router();

// ─── per-IP rate limiter (in-process; sufficient for single host) ─────────

const ipHits = new Map<string, number[]>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = Math.max(1, Number(process.env.OPENX_CONCIERGE_RATE_LIMIT ?? 3));

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= MAX_PER_WINDOW) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  if (Math.random() < 0.01 && ipHits.size > 1000) {
    for (const [k, v] of ipHits) {
      const remaining = v.filter((t) => t > cutoff);
      if (remaining.length === 0) ipHits.delete(k);
      else ipHits.set(k, remaining);
    }
  }
  return false;
}

// ─── Cloudflare Turnstile (optional) ──────────────────────────────────────

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  const secret = process.env.CF_TURNSTILE_SECRET_KEY;
  if (!secret) return true; // unconfigured = bypass (dev / early beta)
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean };
    return body.success === true;
  } catch {
    return false;
  }
}

// ─── POST /v3/concierge/onboard ────────────────────────────────────────────

router.post('/onboard', async (req: Request, res: Response) => {
  if (process.env.FEATURE_PUBLIC_AGENT_ONBOARD !== 'true') {
    return res.status(404).json({ error: 'not_found' });
  }

  const ip =
    (req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ?? '') ||
    req.socket.remoteAddress ||
    'unknown';

  if (rateLimited(ip)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: `One onboard per IP every ${WINDOW_MS / 60_000} minutes (limit ${MAX_PER_WINDOW}). Try again shortly.`,
      retry_after_seconds: WINDOW_MS / 1000,
    });
  }

  const turnstileToken =
    (req.headers['cf-turnstile-token'] as string | undefined) ??
    (typeof req.body?.cf_turnstile_token === 'string' ? req.body.cf_turnstile_token : undefined);
  if (!(await verifyTurnstile(turnstileToken, ip))) {
    return res.status(403).json({ error: 'captcha_failed' });
  }

  // ── input validation ────────────────────────────────────────────────────
  const body = (req.body ?? {}) as {
    prompt?: unknown;
    operator_email?: unknown;
    preferred_slug?: unknown;
    notification_webhook_url?: unknown;
  };

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 30 || prompt.length > 2000) {
    return res.status(400).json({
      error: 'invalid_prompt',
      message: 'prompt must be 30-2000 characters.',
    });
  }
  const operator_email =
    typeof body.operator_email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.operator_email)
      ? body.operator_email.toLowerCase()
      : undefined;
  const preferred_slug =
    typeof body.preferred_slug === 'string' && /^[a-z0-9-]{3,40}$/.test(body.preferred_slug)
      ? body.preferred_slug
      : undefined;
  const notification_webhook_url =
    typeof body.notification_webhook_url === 'string' &&
    /^https?:\/\/[^\s]+$/.test(body.notification_webhook_url)
      ? body.notification_webhook_url
      : undefined;

  try {
    const result = await conciergeOnboardService.onboardPublicAgent({
      prompt,
      operator_email,
      preferred_slug,
      notification_webhook_url,
      request_ip: ip,
      user_agent: req.headers['user-agent']?.toString(),
    });

    if (result.status === 'needs_clarification') return res.status(400).json(result);
    if (result.status === 'duplicate') return res.status(409).json(result);
    return res.status(200).json(result);
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown';
    logger.error({ err: msg, ip }, 'concierge:onboard:failed');
    return res.status(503).json({
      error: 'onboard_failed',
      message: 'Could not publish the agent. Please try again.',
      detail: msg.slice(0, 200),
    });
  }
});

// ─── GET /v3/concierge/config — surface feature flag + example to UI ──────

router.get('/config', (_req: Request, res: Response) => {
  res.json({
    enabled: process.env.FEATURE_PUBLIC_AGENT_ONBOARD === 'true',
    network: `stellar:${process.env.STELLAR_NETWORK ?? 'testnet'}`,
    rate_limit: { window_minutes: WINDOW_MS / 60_000, max_per_window: MAX_PER_WINDOW },
    captcha_required: Boolean(process.env.CF_TURNSTILE_SECRET_KEY),
  });
});

export default router;
