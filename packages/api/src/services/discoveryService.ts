/**
 * discoveryService — LLM-ranked agent discovery for /v3/discover.
 *
 * Chain-agnostic: reads only Supabase. The LLM scores agents against the
 * buyer's NL message; falls back to TF-IDF on rate-limit / no-key.
 */

import { pool } from '../db';
import { logger } from '../lib';
import { llmChat } from './llm';

export interface DiscoveryCandidate {
  id: string;
  slug: string;
  persona: { system_prompt: string };
  pricing: { x402?: string };
  soroban_agent_id?: string | null;
  score: number;
  why: string;
}

class DiscoveryService {
  async discover(message: string): Promise<DiscoveryCandidate[]> {
    const r = await pool.query<DiscoveryCandidate>(
      `SELECT id, slug, persona, pricing, soroban_agent_id, 0::float AS score, '' AS why
         FROM agents
        WHERE published = true AND archived_at IS NULL
     ORDER BY created_at DESC
        LIMIT 50`,
    );
    if (r.rowCount === 0) return [];
    const hasKey = Boolean(process.env.BEDROCK_API_KEY ?? process.env.OPENAI_API_KEY);
    const useLlm = process.env.OPENX_DISCOVERY_LLM !== 'off' && hasKey;
    if (!useLlm) return this.tfIdfRank(message, r.rows);
    try {
      return await this.llmRank(message, r.rows);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'discover:llm:fallback');
      return this.tfIdfRank(message, r.rows);
    }
  }

  private tfIdfRank(message: string, agents: DiscoveryCandidate[]): DiscoveryCandidate[] {
    const tokens = message.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return agents
      .map((a) => {
        const text = `${a.slug} ${a.persona?.system_prompt ?? ''}`.toLowerCase();
        const score = tokens.reduce((s, t) => (text.includes(t) ? s + 1 : s), 0);
        return { ...a, score, why: 'keyword-match' };
      })
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private async llmRank(message: string, agents: DiscoveryCandidate[]): Promise<DiscoveryCandidate[]> {
    const list = agents
      .map(
        (a, i) =>
          `${i + 1}. ${a.slug} :: ${(a.persona?.system_prompt ?? '').slice(0, 200)}`,
      )
      .join('\n');
    const system =
      'You rank AI assistants for a buyer task. Reply with a JSON object: {"results":[{"index":<1-based>,"score":<0-10>,"why":"<one-sentence reason>"}]}. Top 5 only.';
    const raw = await llmChat({
      system,
      user: `Task:\n${message}\n\nAssistants:\n${list}`,
      jsonMode: true,
      model: process.env.OPENX_DISCOVERY_MODEL ?? process.env.OPENX_DEFAULT_MODEL,
      temperature: 0,
    });
    const parsed = safeJson(raw) as { results?: Array<{ index: number; score: number; why: string }> } | null;
    const results = parsed?.results ?? [];
    return results
      .map((r) => {
        const a = agents[r.index - 1];
        return a ? { ...a, score: r.score, why: r.why } : null;
      })
      .filter(Boolean) as DiscoveryCandidate[];
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const discoveryService = new DiscoveryService();
