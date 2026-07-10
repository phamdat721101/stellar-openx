/**
 * skillService — PRD-T-S S3 (Acquire skills).
 *
 * Two paths to a skill, one gate:
 *   • Path A (manual): seller uploads a SKILL.md.
 *   • Path B (auto):   LLM generates a SKILL.md from a Raven playbook.
 * Both run the Pocock 4-pillar audit (Trigger · Structure · Steering · Pruning)
 * via `llmChat`. A passing skill is written to `knowledge_chunks` (so it grounds
 * inference exactly like S2) and advances the agent to the `skilling` stage.
 *
 * SOLID: SRP — owns skill acquisition + audit only. Stage writes + ownership
 * checks reuse the primitives exported by trainingService (single source of
 * truth for stage transitions). Grounding storage reuses KnowledgeIngestService.
 */

import { llmChat } from './llm';
import { KnowledgeIngestService } from './knowledge-ingest';
import { ravenClient } from './ravenClient';
import {
  requireOwnedAgent,
  recordTrainingEvent,
  setTrainingStage,
  trainingService,
  type TrainingState,
} from './trainingService';

const AUDIT_THRESHOLD = clamp01(Number(process.env.SKILL_AUDIT_THRESHOLD ?? 0.6));

export interface SkillAudit {
  trigger: number;
  structure: number;
  steering: number;
  pruning: number;
  notes: string;
}

export interface ISkillService {
  acquireSkills(
    agentId: string,
    owner: string,
    input: { skill_md?: string; playbook_query?: string },
  ): Promise<TrainingState>;
}

class SkillService implements ISkillService {
  async acquireSkills(
    agentId: string,
    owner: string,
    input: { skill_md?: string; playbook_query?: string },
  ): Promise<TrainingState> {
    const agent = await requireOwnedAgent(agentId, owner);
    const alreadyCertified = agent.training_stage === 'certified' || agent.training_stage === 'legacy_certified';
    // A certified agent may keep layering in new skills post-certification —
    // this is additive learning, not a stage regression, so it skips the
    // normal "must be in learning" gate and never rewinds training_stage.
    if (!alreadyCertified) {
      if (stageAtLeast(agent.training_stage, 'skilling')) return trainingService.getState(agentId);
      if (agent.training_stage !== 'learning') {
        throw new Error('stage_precondition: complete "learning" before acquiring skills');
      }
    }

    // Resolve the skill markdown — uploaded, or auto-generated from a playbook.
    const skillMd =
      input.skill_md?.trim() || (await this.autoGenFromRaven(agent.slug, input.playbook_query, owner));
    if (!skillMd) throw new Error('no_skill_source');

    const audit = await auditSkill(skillMd);
    const score = mean([audit.trigger, audit.structure, audit.steering, audit.pruning]);
    const passed =
      audit.trigger >= AUDIT_THRESHOLD &&
      audit.structure >= AUDIT_THRESHOLD &&
      audit.steering >= AUDIT_THRESHOLD &&
      audit.pruning >= AUDIT_THRESHOLD;

    if (passed) {
      await KnowledgeIngestService.ingest(owner, `# Skill\n${skillMd.slice(0, 8000)}`, agentId);
    }
    await recordTrainingEvent({
      agentId,
      stage: alreadyCertified ? agent.training_stage : 'skilling',
      eventType: 'skill_audit',
      passed,
      score,
      detail: { threshold: AUDIT_THRESHOLD, audit, source: input.skill_md ? 'upload' : 'raven_autogen' },
    });
    if (passed && !alreadyCertified) await setTrainingStage(agentId, 'skilling');
    return trainingService.getState(agentId);
  }

  private async autoGenFromRaven(
    slug: string,
    playbookQuery: string | undefined,
    owner: string,
  ): Promise<string> {
    const entries = await ravenClient.search(playbookQuery || slug, owner);
    const playbook = entries.find((e) => e.kind === 'playbook') ?? entries[0];
    if (!playbook) return '';
    return llmChat({
      system:
        'Generate a single SKILL.md for an AI agent from the PLAYBOOK. Include a clear trigger ("Use when…"), numbered steps, guardrails, and a short example. Output markdown only.',
      user: `PLAYBOOK: ${playbook.title}\n${playbook.body ?? playbook.summary}`,
      model: process.env.OPENX_TRAINING_MODEL ?? process.env.OPENX_DEFAULT_MODEL,
      temperature: 0.2,
    });
  }
}

// ─── Pocock 4-pillar audit ───────────────────────────────────────────────────

async function auditSkill(skillMd: string): Promise<SkillAudit> {
  const raw = await llmChat({
    system:
      'You audit an agent SKILL.md against the Pocock 4 pillars. Return STRICT JSON ' +
      '{"trigger":0..1,"structure":0..1,"steering":0..1,"pruning":0..1,"notes":string}. ' +
      'trigger=has a clear "use when"; structure=well-organized steps; steering=actionable guidance; ' +
      'pruning=concise, no filler.',
    user: skillMd.slice(0, 8000),
    jsonMode: true,
    temperature: 0,
  });
  try {
    const p = JSON.parse(stripFences(raw)) as Partial<SkillAudit>;
    return {
      trigger: clamp01(Number(p.trigger ?? 0)),
      structure: clamp01(Number(p.structure ?? 0)),
      steering: clamp01(Number(p.steering ?? 0)),
      pruning: clamp01(Number(p.pruning ?? 0)),
      notes: typeof p.notes === 'string' ? p.notes : '',
    };
  } catch {
    return { trigger: 0, structure: 0, steering: 0, pruning: 0, notes: 'audit_parse_failed' };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function stageAtLeast(stage: string, target: 'skilling'): boolean {
  const order = ['onboarded', 'learning', 'skilling', 'evaluating', 'certified'];
  const norm = stage === 'legacy_certified' ? 'certified' : stage;
  return order.indexOf(norm) >= order.indexOf(target);
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

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export const skillService: ISkillService = new SkillService();
