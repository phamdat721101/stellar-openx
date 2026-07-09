/**
 * /v3 — Stellar-native marketplace API.
 *
 * Surface preserved from the legacy v3 router; everything chain-specific
 * is delegated to `services/stellar/marketplace`. The Supabase `agents`
 * table holds the off-chain metadata (slug, persona JSON, manifest URL,
 * pricing JSON for UX-side rendering). The on-chain row in agent-registry
 * holds the trust-anchor price + payout address; the API simply mirrors.
 */

import { Router, type Response } from 'express';
import { logger } from '../lib';
import { pool } from '../db';
import type { AuthRequest } from '../middleware/auth';
import { discoveryService } from '../services/discoveryService';
import { listAgents, getAgent, getCertification } from '../services/stellar/marketplace';
import { stroopsToUsdc } from '@openx/sdk';

const router = Router();

router.get('/version', (_req, res) =>
  res.json({ name: 'openx-s', version: '3.0.0', chain: process.env.STELLAR_NETWORK ?? 'testnet' }),
);

// ─── Public listings ──────────────────────────────────────────────────────

router.get('/agents', async (_req, res) => {
  const r = await pool.query(
    `SELECT id, slug, owner_address, persona, pricing, published, soroban_agent_id, created_at,
            training_stage, cert_score, certified_at
       FROM agents
      WHERE published = true AND archived_at IS NULL
   ORDER BY created_at DESC
      LIMIT 100`,
  );
  res.json({ agents: r.rows });
});

router.get('/agents/top', async (_req, res) => {
  const r = await pool.query(
    `SELECT a.id, a.slug, a.persona, a.pricing, a.soroban_agent_id,
            COUNT(p.id)::int AS call_count
       FROM agents a
       LEFT JOIN paid_calls p ON p.agent_id = a.id
      WHERE a.published = true AND a.archived_at IS NULL
   GROUP BY a.id
   ORDER BY call_count DESC, a.created_at DESC
      LIMIT 10`,
  );
  res.json({ agents: r.rows });
});

router.get('/agents/search', async (req, res) => {
  const q = ((req.query.q as string) ?? '').trim().toLowerCase();
  if (!q) return res.json({ agents: [] });
  const r = await pool.query(
    `SELECT id, slug, persona, pricing, soroban_agent_id
       FROM agents
      WHERE published = true AND archived_at IS NULL
        AND (LOWER(slug) LIKE $1 OR LOWER(persona->>'system_prompt') LIKE $1)
      LIMIT 25`,
    [`%${q}%`],
  );
  res.json({ agents: r.rows });
});

router.get('/agents/slug-available', async (req, res) => {
  const slug = (req.query.slug as string) ?? '';
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return res.json({ available: false });
  const r = await pool.query('SELECT 1 FROM agents WHERE slug = $1 LIMIT 1', [slug]);
  res.json({ available: r.rowCount === 0 });
});

router.get('/agents/:id/recent-calls', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 10), 50);
  // Hide legacy `method='demo'` rows produced by the v3.0 gate bypass — they
  // are kept in `paid_calls` for audit but should not pollute the live
  // buyer-facing feed now that the bypass is gone.
  const r = await pool.query(
    `SELECT created_at, amount_usdc, method, tx_hash,
            SUBSTRING(buyer, 1, 6) || '…' || SUBSTRING(buyer, GREATEST(LENGTH(buyer) - 3, 1)) AS buyer_anon
       FROM paid_calls
      WHERE agent_id = $1 AND method <> 'demo'
   ORDER BY created_at DESC
      LIMIT $2`,
    [req.params.id, limit],
  );
  res.json({ calls: r.rows });
});

// ─── Concierge discovery (LLM ranker) ─────────────────────────────────────

router.post('/discover', async (req, res) => {
  const message = ((req.body?.message as string) ?? '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const ranked = await discoveryService.discover(message);
    res.json({ candidates: ranked });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'discover:failed');
    res.status(500).json({ error: 'discover_failed' });
  }
});

// ─── Soroban registry passthrough (for cross-checking Supabase) ───────────

router.get('/registry/agents', async (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const agents = await listAgents(offset, limit);
  res.json({ agents: agents.map((a) => ({ ...a, price_usdc: stroopsToUsdc(BigInt(a.price_stroops)) })) });
});

router.get('/registry/agents/:agent_id', async (req, res) => {
  if (!/^[0-9a-f]{64}$/i.test(req.params.agent_id)) {
    return res.status(400).json({ error: 'agent_id must be 32-byte hex' });
  }
  const a = await getAgent(Buffer.from(req.params.agent_id, 'hex'));
  if (!a) return res.status(404).json({ error: 'agent not found on chain' });
  res.json({ agent: { ...a, price_usdc: stroopsToUsdc(BigInt(a.price_stroops)) } });
});

// PRD-T-S — read the on-chain certification (trust anchor) for cross-checking
// the DB badge. Public cross-check tool, same auth treatment as its sibling.
router.get('/registry/agents/:agent_id/certification', async (req, res) => {
  if (!/^[0-9a-f]{64}$/i.test(req.params.agent_id)) {
    return res.status(400).json({ error: 'agent_id must be 32-byte hex' });
  }
  const cert = await getCertification(Buffer.from(req.params.agent_id, 'hex'));
  if (!cert) return res.status(404).json({ error: 'agent not certified on chain' });
  res.json({ certification: cert });
});

// ─── Owner-authed dashboard ───────────────────────────────────────────────

router.get('/dashboard/stats', async (_req, res) => {
  const r = await pool.query(
    `SELECT
        COUNT(DISTINCT a.id)::int AS published_agents,
        COUNT(p.id)::int AS total_calls,
        COALESCE(SUM(p.amount_usdc::numeric), 0)::text AS total_usdc
       FROM agents a
       LEFT JOIN paid_calls p ON p.agent_id = a.id
      WHERE a.published = true AND a.archived_at IS NULL`,
  );
  res.json(r.rows[0]);
});

router.get('/me/agents', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const r = await pool.query(
    `SELECT id, slug, persona, pricing, published, soroban_agent_id, created_at,
            training_stage, cert_score, certified_at
       FROM agents
      WHERE owner_address = $1 AND archived_at IS NULL
   ORDER BY created_at DESC`,
    [req.user.address],
  );
  res.json({ agents: r.rows });
});

export default router;
