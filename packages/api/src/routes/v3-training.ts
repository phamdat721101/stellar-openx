/**
 * /v3/training — PRD-T-S Agent Training Pipeline HTTP surface.
 *
 * Owner-authed (x-stellar-address) + flag-gated (FEATURE_TRAINING → 404 when
 * off, byte-identical to a route that doesn't exist). Thin controllers: each
 * delegates to a service and maps domain errors to status codes. The Raven
 * OAuth callback is the one public path (whitelisted in auth.ts).
 *
 * SOLID: SRP — routing + error mapping only; all logic lives in the services.
 */

import { Router, type Response } from 'express';
import { logger } from '../lib';
import type { AuthRequest } from '../middleware/auth';
import { trainingService, requireOwnedAgent } from '../services/trainingService';
import { skillService } from '../services/skillService';
import { certificationService } from '../services/certificationService';
import { dgmIterationService } from '../services/dgmIterationService';
import { ravenAuthorizeUrl, ravenExchangeCode } from '../services/ravenClient';

const router = Router();

function requireTrainingFlag(_req: AuthRequest, res: Response, next: () => void): void {
  if (process.env.FEATURE_TRAINING !== 'true') {
    res.status(404).json({ error: 'feature_disabled' });
    return;
  }
  next();
}

/** Map a domain error to an HTTP status + safe message. */
function fail(res: Response, err: unknown, log: string): void {
  const msg = (err as Error).message ?? 'error';
  logger.warn({ err: msg }, log);
  const status = msg === 'not_found'
    ? 404
    : msg === 'not_owner'
      ? 403
      : msg.startsWith('stage_precondition')
        ? 409
        : 400;
  res.status(status).json({ error: msg });
}

function ownerOr401(req: AuthRequest, res: Response): string | null {
  if (!req.user?.address) {
    res.status(401).json({ error: 'auth required' });
    return null;
  }
  return req.user.address;
}

// ─── Raven OAuth (WorkOS AuthKit) ────────────────────────────────────────────

router.get('/raven/authorize-url', requireTrainingFlag, (req: AuthRequest, res: Response) => {
  const owner = ownerOr401(req, res);
  if (!owner) return;
  const url = ravenAuthorizeUrl(owner);
  if (!url) return res.status(503).json({ error: 'raven_oauth_not_configured' });
  res.json({ url });
});

// Public (browser redirect). `state` carries the seller's Stellar address.
router.get('/raven/oauth/callback', async (req: AuthRequest, res: Response) => {
  const code = String(req.query.code ?? '');
  const owner = String(req.query.state ?? '');
  if (!code || !owner) return res.status(400).json({ error: 'missing code/state' });
  try {
    const ok = await ravenExchangeCode(code, owner);
    res.status(ok ? 200 : 400).json({ connected: ok });
  } catch (err) {
    fail(res, err, 'training:raven:oauth_failed');
  }
});

// ─── Pipeline (S2→S5) ────────────────────────────────────────────────────────

router.get('/:agentId', requireTrainingFlag, async (req: AuthRequest, res: Response) => {
  const owner = ownerOr401(req, res);
  if (!owner) return;
  try {
    await requireOwnedAgent(req.params.agentId, owner); // 404/403 for non-owners
    res.json(await trainingService.getState(req.params.agentId));
  } catch (err) {
    fail(res, err, 'training:getState:failed');
  }
});

router.post('/:agentId/learn', requireTrainingFlag, async (req: AuthRequest, res: Response) => {
  const owner = ownerOr401(req, res);
  if (!owner) return;
  try {
    res.json(await trainingService.learnStellar(req.params.agentId, owner));
  } catch (err) {
    fail(res, err, 'training:learn:failed');
  }
});

router.post('/:agentId/skills', requireTrainingFlag, async (req: AuthRequest, res: Response) => {
  const owner = ownerOr401(req, res);
  if (!owner) return;
  try {
    res.json(
      await skillService.acquireSkills(req.params.agentId, owner, {
        skill_md: typeof req.body?.skill_md === 'string' ? req.body.skill_md : undefined,
        playbook_query: typeof req.body?.playbook_query === 'string' ? req.body.playbook_query : undefined,
      }),
    );
  } catch (err) {
    fail(res, err, 'training:skills:failed');
  }
});

router.post('/:agentId/evaluate', requireTrainingFlag, async (req: AuthRequest, res: Response) => {
  const owner = ownerOr401(req, res);
  if (!owner) return;
  try {
    res.json(await trainingService.evaluate(req.params.agentId, owner));
  } catch (err) {
    fail(res, err, 'training:evaluate:failed');
  }
});

router.post('/:agentId/certify', requireTrainingFlag, async (req: AuthRequest, res: Response) => {
  const owner = ownerOr401(req, res);
  if (!owner) return;
  try {
    res.json(
      await certificationService.certify(req.params.agentId, owner, {
        auto_publish: req.body?.auto_publish === true,
      }),
    );
  } catch (err) {
    fail(res, err, 'training:certify:failed');
  }
});

router.post(
  '/:agentId/dgm/:proposalId/approve',
  requireTrainingFlag,
  async (req: AuthRequest, res: Response) => {
    const owner = ownerOr401(req, res);
    if (!owner) return;
    try {
      await dgmIterationService.approve(req.params.agentId, owner, req.params.proposalId);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 'training:dgm:approve:failed');
    }
  },
);

export default router;
