/**
 * /api/v1 — public, paywalled brain endpoints.
 *
 * Stellar-native rewrite. The Stellar payment gate IS the auth — no parent
 * auth middleware. Same per-slug shape as the legacy router; the inference
 * implementation is plain HTTP / OpenAI-compatible (no Phala TEE, no FHE
 * decrypt of memory chunks).
 */

import { Router, type Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import { stellarPaymentGate, type StellarPriceableRequest } from '../middleware/stellarPaymentGate';
import { KnowledgeIngestService } from '../services/knowledge-ingest';

const router = Router();

interface AgentRow {
  id: string;
  slug: string;
  persona: { system_prompt: string; model?: string; tools?: string[] };
  pricing: { x402?: string };
  daily_request_cap?: number;
  published: boolean;
  seller_id: number | null;
}

router.get('/.well-known/agent.json', async (_req, res) => {
  res.json({
    name: 'openx-s',
    version: '3.0.0',
    network: process.env.STELLAR_NETWORK ?? 'testnet',
    chain: 'stellar',
    asset: 'USDC',
    paywallRouter: process.env.STELLAR_PAYWALL_ROUTER_ID ?? '',
  });
});

router.post('/:slug', stellarPaymentGate, async (req: StellarPriceableRequest, res: Response) => {
  const agent = req.pricedAgent;
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const { question, uploadIds } = (req.body ?? {}) as { question?: string; uploadIds?: string[] };
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question required' });
  }
  try {
    // Fetch full agent + persona
    const r = await pool.query<AgentRow>(
      `SELECT id, slug, persona, pricing, published, seller_id FROM agents WHERE id = $1 LIMIT 1`,
      [agent.id],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
    const answer = await runInference(r.rows[0], question, uploadIds ?? []);
    res.json({
      ok: true,
      answer,
      receipt: req.receipt,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, slug: agent.slug }, 'v1:inference:failed');
    res.status(500).json({ error: 'inference_failed' });
  }
});

/**
 * runInference — public for async-task-runner reuse.
 * Plain chat completion via the provider-routing adapter (Bedrock Converse
 * for Claude/Nova, OpenAI-compat for the rest).
 *
 * Helpfulness directive — sellers tend to write narrow personas
 * ("translate EN→VI legal NDAs") that cause the LLM to refuse adjacent
 * reasonable buyer tasks ("translate hello to Chinese"). For buyer UX
 * parity with fhe-ai-context we append a small directive that nudges the
 * model to be useful for any reasonable adjacent request while still
 * refusing unsafe / impossible work. Sellers who want strict refusal can
 * still encode that in their persona.
 */
const HELPFULNESS_DIRECTIVE = `

# Buyer helpfulness
- When the buyer's request is adjacent to your specialty (translation, summarization, coding help, analysis, etc.), do your best with the basic task even if it's slightly off your stated focus.
- Refuse only for unsafe, illegal, or impossible requests — never refuse purely because the request is outside your narrow specialty.
- Always produce a useful answer to a reasonable question. Buyers paid to get a result.`;

export async function runInference(
  agent: { id?: string; persona: AgentRow['persona'] },
  question: string,
  uploadIds: string[],
): Promise<string> {
  const chunks = agent.id ? await KnowledgeIngestService.loadChunks(agent.id) : [];
  const context = chunks
    .slice(0, 10)
    .map((c, i) => `[#${i + 1}] ${c}`)
    .join('\n');
  const uploadCtx = uploadIds.length
    ? `Attached uploads: ${uploadIds.join(', ')}`
    : '';
  const userPrompt = [
    context && `# Knowledge base:\n${context}`,
    uploadCtx && `# Uploads:\n${uploadCtx}`,
    `# User question:\n${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { llmChat } = await import('../services/llm');
  return llmChat({
    system: `${agent.persona.system_prompt}${HELPFULNESS_DIRECTIVE}`,
    user: userPrompt,
    model: agent.persona.model ?? process.env.OPENX_DEFAULT_MODEL,
    temperature: 0.3,
  });
}

export default router;
