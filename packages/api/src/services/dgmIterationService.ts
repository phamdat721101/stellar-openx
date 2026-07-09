/**
 * dgmIterationService — PRD-T-S S4 Darwin-Gödel-Machine iteration loop.
 *
 * Weekly, for each certified agent, propose an improved system prompt grounded
 * in the agent's recent real traffic (paid_calls as the validation signal), then
 * queue the proposal for the SELLER to approve — never auto-applied. Approval
 * mutates `agents.persona.system_prompt`.
 *
 * Cost governance: at most DGM_MAX_AGENTS agents per run × 1 LLM proposal each,
 * keeping a run comfortably under the $2 cost cap (research constraint).
 *
 * SOLID: SRP — owns proposal generation + application only. Proposals are stored
 * as `agent_training_events` (event_type='dgm_proposal') — no new table. Stage
 * writes/ownership reuse trainingService primitives.
 */

import { pool } from '../db';
import { logger } from '../lib';
import { llmChat } from './llm';
import { recordTrainingEvent, requireOwnedAgent } from './trainingService';

const MAX_AGENTS = Math.max(1, Number(process.env.DGM_MAX_AGENTS ?? 5));
const SAMPLE_CALLS = Math.max(1, Number(process.env.DGM_SAMPLE_CALLS ?? 20));

export interface IDgmIterationService {
  runWeekly(): Promise<{ proposed: number }>;
  approve(agentId: string, owner: string, proposalId: string): Promise<void>;
}

class DgmIterationService implements IDgmIterationService {
  async runWeekly(): Promise<{ proposed: number }> {
    const lock = await pool.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('dgm_cron')::bigint) AS ok`,
    );
    if (!lock.rows[0]?.ok) return { proposed: 0 };
    try {
      const agents = await pool.query<{ id: string; persona: { system_prompt: string } }>(
        `SELECT a.id, a.persona
           FROM agents a
          WHERE a.training_stage = 'certified'
          ORDER BY a.certified_at DESC NULLS LAST
          LIMIT $1`,
        [MAX_AGENTS],
      );
      let proposed = 0;
      for (const a of agents.rows) {
        try {
          if (await this.proposeFor(a.id, a.persona?.system_prompt ?? '')) proposed += 1;
        } catch (err) {
          logger.warn({ err: (err as Error).message, agentId: a.id }, 'dgm:propose:failed');
        }
      }
      logger.info({ proposed, considered: agents.rowCount }, 'dgm:cron:tick_done');
      return { proposed };
    } finally {
      await pool.query(`SELECT pg_advisory_unlock(hashtext('dgm_cron')::bigint)`);
    }
  }

  /** Generate one proposal from recent traffic. Returns true if a distinct
   *  improved prompt was queued (strict-improvement filter: must differ). */
  private async proposeFor(agentId: string, currentPrompt: string): Promise<boolean> {
    if (!currentPrompt.trim()) return false;
    const calls = await pool.query<{ amount_usdc: string; method: string }>(
      `SELECT amount_usdc, method FROM paid_calls
        WHERE agent_id = $1 AND method <> 'demo'
        ORDER BY created_at DESC LIMIT $2`,
      [agentId, SAMPLE_CALLS],
    );
    const signal = `Recent paid calls: ${calls.rowCount ?? 0}. Methods: ${
      [...new Set(calls.rows.map((c) => c.method))].join(', ') || 'none'
    }.`;

    const proposedPrompt = (
      await llmChat({
        system:
          'You improve an AI agent system prompt for a Stellar-native marketplace. Given the CURRENT prompt and TRAFFIC signal, return ONLY the improved system prompt (no preamble). Keep the agent’s purpose; sharpen clarity, guardrails, and output format. If already optimal, return it unchanged.',
        user: `CURRENT PROMPT:\n${currentPrompt}\n\nTRAFFIC:\n${signal}`,
        model: process.env.OPENX_TRAINING_MODEL ?? process.env.OPENX_DEFAULT_MODEL,
        temperature: 0.3,
      })
    ).trim();

    // Strict-improvement filter: skip no-op / trivial / demo-fallback outputs.
    if (!proposedPrompt || proposedPrompt === currentPrompt.trim() || proposedPrompt.startsWith('[demo]')) {
      return false;
    }
    await recordTrainingEvent({
      agentId,
      stage: 'certified',
      eventType: 'dgm_proposal',
      passed: null,
      detail: { status: 'pending', current_prompt: currentPrompt, proposed_prompt: proposedPrompt, signal },
    });
    return true;
  }

  /** Seller approves a pending proposal → apply to the live persona. */
  async approve(agentId: string, owner: string, proposalId: string): Promise<void> {
    await requireOwnedAgent(agentId, owner);
    const r = await pool.query<{ detail: { proposed_prompt?: string; status?: string } }>(
      `SELECT detail FROM agent_training_events
        WHERE id = $1 AND agent_id = $2 AND event_type = 'dgm_proposal' LIMIT 1`,
      [proposalId, agentId],
    );
    const proposal = r.rows[0];
    if (!proposal) throw new Error('proposal_not_found');
    const nextPrompt = proposal.detail?.proposed_prompt;
    if (!nextPrompt) throw new Error('proposal_empty');

    await pool.query(
      `UPDATE agents SET persona = jsonb_set(persona, '{system_prompt}', to_jsonb($1::text)) WHERE id = $2`,
      [nextPrompt, agentId],
    );
    await recordTrainingEvent({
      agentId,
      stage: 'certified',
      eventType: 'dgm_approved',
      passed: true,
      detail: { applied_proposal_id: proposalId },
    });
    logger.info({ agentId, proposalId }, 'dgm:proposal:approved');
  }
}

export const dgmIterationService: IDgmIterationService = new DgmIterationService();
