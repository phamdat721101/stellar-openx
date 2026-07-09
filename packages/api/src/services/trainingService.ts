/**
 * trainingService — the PRD-T-S stage machine + S2 (Learn Stellar) and S4
 * (Work + evaluate) orchestration.
 *
 * Stages (agents.training_stage), ordered:
 *   onboarded → learning → skilling → evaluating → certified
 *   (+ legacy_certified — a downgrade of certified handled by certificationService)
 *
 * A stage method advances the agent INTO the named stage iff its gate passes:
 *   • learnStellar  → learning     (gate: 3 canonical Q answers each ≥ learn threshold)
 *   • acquireSkills → skilling      (skillService — gate: ≥1 skill passing audit)
 *   • evaluate      → evaluating    (gate: ≥ cert threshold on 5 of 6 canonical tasks)
 *   • certify       → certified     (certificationService — on-chain attestation)
 *
 * Reuse (the win): grounding is written to `knowledge_chunks` via
 * KnowledgeIngestService, so it flows into `runInference` with zero new prompt
 * code; scoring reuses `runInference` (the REAL agent path) + `llmChat` as judge.
 * No eval framework — canonical tasks are const arrays.
 *
 * SOLID: SRP — owns stage transitions + eval. Skill audit (S3) lives in
 * skillService; on-chain cert (S5) in certificationService; both reuse the
 * `recordTrainingEvent` / `setTrainingStage` primitives exported here so all
 * stage writes stay in one place.
 */

import { pool } from '../db';
import { logger } from '../lib';
import { llmChat } from './llm';
import { KnowledgeIngestService } from './knowledge-ingest';
import { ravenClient } from './ravenClient';
import { runInference } from '../routes/v1Public';

// ─── stage model ─────────────────────────────────────────────────────────────

export type TrainingStage =
  | 'onboarded'
  | 'learning'
  | 'skilling'
  | 'evaluating'
  | 'certified'
  | 'legacy_certified';

const STAGE_ORDER: TrainingStage[] = ['onboarded', 'learning', 'skilling', 'evaluating', 'certified'];

function stageIndex(s: TrainingStage): number {
  if (s === 'legacy_certified') return STAGE_ORDER.indexOf('certified');
  const i = STAGE_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

export interface TrainingEvent {
  stage: string;
  event_type: string;
  passed: boolean | null;
  score: number | null;
  detail?: Record<string, unknown>;
  created_at: string;
}

export interface TrainingState {
  agent_id: string;
  stage: TrainingStage;
  cert_score: number | null;
  certificate_hash: string | null;
  certified_at: string | null;
  events: TrainingEvent[];
}

export interface ITrainingService {
  getState(agentId: string): Promise<TrainingState>;
  learnStellar(agentId: string, owner: string): Promise<TrainingState>;
  evaluate(agentId: string, owner: string): Promise<TrainingState>;
}

// ─── config (env-driven) ─────────────────────────────────────────────────────

const LEARN_THRESHOLD = clamp01(Number(process.env.RAVEN_LEARN_THRESHOLD ?? 0.7));
const CERT_THRESHOLD = clamp01(Number(process.env.RAVEN_CERT_THRESHOLD ?? 0.8));
const JUDGE_MODEL = process.env.OPENX_TRAINING_MODEL ?? process.env.OPENX_DEFAULT_MODEL;

/** S2 gate — canonical Stellar knowledge questions. */
const CANONICAL_QUESTIONS: Array<{ q: string; rubric: string }> = [
  { q: 'How do I transfer USDC on Stellar?', rubric: 'Mentions SEP-41/SAC transfer or a Stellar payment with asset code + issuer, and stroop/amount handling.' },
  { q: "What's a Soroban contract address format?", rubric: 'Explains the StrKey "C…" contract address (or the 32-byte on-chain id).' },
  { q: 'Explain SEP-41.', rubric: 'Describes SEP-41 as the standard Soroban token interface (transfer/balance/etc.).' },
];

/** S4 gate — 6 canonical Stellar-agent tasks scored by an LLM judge. */
const CANONICAL_TASKS: Array<{ id: string; prompt: string; rubric: string }> = [
  { id: 'pay-via-stellar-x402', prompt: 'A buyer hit your endpoint and got HTTP 402. Explain how to settle the x402 payment on Stellar and retry.', rubric: 'Describes paying the challenge in USDC/MGUSD on Stellar and retrying with a payment receipt.' },
  { id: 'query-horizon', prompt: 'Given a Stellar account id, how do you fetch its USDC balance from Horizon?', rubric: 'Uses GET /accounts/{id}, reads balances[], matches asset_code+issuer.' },
  { id: 'submit-soroban-invoke', prompt: 'Outline the steps to invoke a Soroban contract method and submit the transaction.', rubric: 'Build op → simulate/prepare → sign → submit → poll result.' },
  { id: 'fetch-sep41-metadata', prompt: 'How do you read a SEP-41 token’s name, symbol, and decimals?', rubric: 'Calls the SEP-41 name/symbol/decimals views on the token/SAC contract.' },
  { id: 'explain-stellar-error-code', prompt: 'A transaction failed with tx_failed / op_underfunded. What does it mean and how do you fix it?', rubric: 'Explains the error and a concrete remediation (fund account / add trustline / adjust amount).' },
  { id: 'compose-mgusd-payment', prompt: 'Compose a payment that settles in MGUSD so the payee can cash out at MoneyGram.', rubric: 'Resolves MGUSD SAC, builds a transfer in stroops, handles trustline, records settlement.' },
];

// ─── shared stage-write primitives (reused by skill + cert services) ─────────

export async function recordTrainingEvent(input: {
  agentId: string;
  stage: string;
  eventType: string;
  passed?: boolean | null;
  score?: number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO agent_training_events (agent_id, stage, event_type, passed, score, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.agentId,
      input.stage,
      input.eventType,
      input.passed ?? null,
      input.score ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

export async function setTrainingStage(agentId: string, stage: TrainingStage): Promise<void> {
  await pool.query(`UPDATE agents SET training_stage = $1 WHERE id = $2`, [stage, agentId]);
}

export interface OwnedAgent {
  id: string;
  owner_address: string;
  slug: string;
  persona: { system_prompt: string; model?: string };
  training_stage: TrainingStage;
}

/** Load an agent and assert the caller owns it. Throws `not_found`/`not_owner`. */
export async function requireOwnedAgent(agentId: string, owner: string): Promise<OwnedAgent> {
  const r = await pool.query<OwnedAgent>(
    `SELECT id, owner_address, slug, persona, training_stage
       FROM agents WHERE id = $1 LIMIT 1`,
    [agentId],
  );
  const a = r.rows[0];
  if (!a) throw new Error('not_found');
  if (a.owner_address !== owner) throw new Error('not_owner');
  return a;
}

// ─── implementation ──────────────────────────────────────────────────────────

class TrainingService implements ITrainingService {
  async getState(agentId: string): Promise<TrainingState> {
    const a = await pool.query<{
      training_stage: TrainingStage;
      cert_score: number | null;
      certificate_hash: string | null;
      certified_at: string | null;
    }>(
      `SELECT training_stage, cert_score, certificate_hash, certified_at FROM agents WHERE id = $1`,
      [agentId],
    );
    if (a.rowCount === 0) throw new Error('not_found');
    const ev = await pool.query<TrainingEvent>(
      `SELECT stage, event_type, passed, score, detail, created_at
         FROM agent_training_events WHERE agent_id = $1
        ORDER BY created_at DESC LIMIT 25`,
      [agentId],
    );
    const row = a.rows[0];
    return {
      agent_id: agentId,
      stage: row.training_stage,
      cert_score: row.cert_score,
      certificate_hash: row.certificate_hash,
      certified_at: row.certified_at,
      events: ev.rows,
    };
  }

  // ── S2: Learn Stellar via Raven grounding ──────────────────────────────────
  async learnStellar(agentId: string, owner: string): Promise<TrainingState> {
    const agent = await requireOwnedAgent(agentId, owner);
    if (isNoop(agent.training_stage, 'learning')) return this.getState(agentId);
    assertCanEnter(agent.training_stage, 'learning');

    // Ingest Raven grounding once (guarded by prior 'learn' event → no dup chunks).
    if (!(await hasEvent(agentId, 'learn'))) {
      const entries = await ravenClient.search(capabilityQuery(agent), owner);
      const grounding = entries
        .map((e) => `## ${e.title}\n${e.summary}${e.body ? `\n${e.body}` : ''}`)
        .join('\n\n');
      if (grounding.trim()) {
        await KnowledgeIngestService.ingest(owner, `# Stellar grounding (Raven)\n${grounding}`, agentId);
      }
      logger.info({ agentId, entries: entries.length }, 'training:learn:grounding_ingested');
    }

    // Gate: answer the 3 canonical questions; each must clear LEARN_THRESHOLD.
    const scores = await Promise.all(
      CANONICAL_QUESTIONS.map(async ({ q, rubric }) => {
        const answer = await runInference({ id: agentId, persona: agent.persona }, q, []);
        return { q, score: await judge(rubric, answer) };
      }),
    );
    const mean = avg(scores.map((s) => s.score));
    const passed = scores.every((s) => s.score >= LEARN_THRESHOLD);

    await recordTrainingEvent({
      agentId,
      stage: 'learning',
      eventType: 'learn',
      passed,
      score: mean,
      detail: { threshold: LEARN_THRESHOLD, scores },
    });
    if (passed) await setTrainingStage(agentId, 'learning');
    return this.getState(agentId);
  }

  // ── S4: Work + evaluate against 6 canonical tasks ──────────────────────────
  async evaluate(agentId: string, owner: string): Promise<TrainingState> {
    const agent = await requireOwnedAgent(agentId, owner);
    if (isNoop(agent.training_stage, 'evaluating')) return this.getState(agentId);
    assertCanEnter(agent.training_stage, 'evaluating');

    const results = await Promise.all(
      CANONICAL_TASKS.map(async (t) => {
        const answer = await runInference({ id: agentId, persona: agent.persona }, t.prompt, []);
        return { id: t.id, score: await judge(t.rubric, answer) };
      }),
    );
    const passedCount = results.filter((r) => r.score >= CERT_THRESHOLD).length;
    const mean = avg(results.map((r) => r.score));
    const passed = passedCount >= 5; // 5 of 6

    await recordTrainingEvent({
      agentId,
      stage: 'evaluating',
      eventType: 'eval',
      passed,
      score: mean,
      detail: { threshold: CERT_THRESHOLD, passed_count: passedCount, results },
    });
    if (passed) {
      await pool.query(`UPDATE agents SET training_stage = 'evaluating', cert_score = $1 WHERE id = $2`, [
        mean,
        agentId,
      ]);
    }
    return this.getState(agentId);
  }
}

// ─── gate + scoring helpers ──────────────────────────────────────────────────

/** LLM judge — score 0-1 how well `answer` satisfies `rubric`. */
async function judge(rubric: string, answer: string): Promise<number> {
  const raw = await llmChat({
    system:
      'You are a strict grader. Return STRICT JSON {"score": number 0..1, "reason": string} scoring how well the ANSWER satisfies the RUBRIC. 1 = fully correct, 0 = wrong/empty.',
    user: `RUBRIC:\n${rubric}\n\nANSWER:\n${answer}`,
    jsonMode: true,
    model: JUDGE_MODEL,
    temperature: 0,
  });
  try {
    const parsed = JSON.parse(stripFences(raw)) as { score?: unknown };
    return clamp01(typeof parsed.score === 'number' ? parsed.score : 0);
  } catch {
    return 0;
  }
}

function capabilityQuery(agent: OwnedAgent): string {
  return `${agent.slug} ${agent.persona?.system_prompt ?? ''}`.slice(0, 240);
}

function assertCanEnter(current: TrainingStage, target: TrainingStage): void {
  if (stageIndex(current) !== stageIndex(target) - 1) {
    throw new Error(`stage_precondition: complete the previous stage before "${target}"`);
  }
}

/** Already at/past the target → treat the call as an idempotent no-op. */
function isNoop(current: TrainingStage, target: TrainingStage): boolean {
  return stageIndex(current) >= stageIndex(target);
}

async function hasEvent(agentId: string, eventType: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM agent_training_events WHERE agent_id = $1 AND event_type = $2 LIMIT 1`,
    [agentId, eventType],
  );
  return (r.rowCount ?? 0) > 0;
}

function stripFences(raw: string): string {
  const t = raw.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  return m ? m[1] : t;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ─── singleton export ────────────────────────────────────────────────────────

export const trainingService: ITrainingService = new TrainingService();
