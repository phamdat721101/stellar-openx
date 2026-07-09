'use client';

/**
 * TrainingPanel — PRD-T-S owner-only training console on /agent/[id].
 *
 * Renders the 5-stage pipeline as a stepper and drives each transition over the
 * flag-gated /v3/training API (owner-authed via x-stellar-address). Kept in one
 * component so the detail page stays SRP; visible only to the connected owner
 * when FEATURE_TRAINING is on.
 *
 * SOLID: SRP — owns training UI state + the thin fetchers only.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { API_URL } from '@/lib/stellar';

const STAGES = ['onboarded', 'learning', 'skilling', 'evaluating', 'certified'] as const;
const STAGE_LABEL: Record<string, string> = {
  onboarded: 'Onboarded',
  learning: 'Learn Stellar',
  skilling: 'Acquire skill',
  evaluating: 'Evaluate',
  certified: 'Certified',
};

interface TrainingEvent {
  stage: string;
  event_type: string;
  passed: boolean | null;
  score: number | null;
  detail?: Record<string, unknown>;
  created_at: string;
}
interface TrainingState {
  agent_id: string;
  stage: string;
  cert_score: number | null;
  certificate_hash: string | null;
  events: TrainingEvent[];
}

export function TrainingPanel({ agentId }: { agentId: string }) {
  const { address } = useStellarWallet();
  const [state, setState] = useState<TrainingState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skillMd, setSkillMd] = useState('');
  const [autoPublish, setAutoPublish] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const r = await fetch(`${API_URL}/v3/training/${agentId}`, {
        headers: { 'x-stellar-address': address },
      });
      if (r.status === 404) return; // feature off or not found
      if (!r.ok) throw new Error(`status ${r.status}`);
      setState((await r.json()) as TrainingState);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [address, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep-link UX: when a seller clicks "Train with Stellar Raven" from /publish
  // (href `/agent/{id}#train`), scroll the training panel into view once the
  // state has resolved so it's the focal point, not the hire form.
  useEffect(() => {
    if (!state) return;
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#train') return;
    document.getElementById('train')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [state]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    if (!address) return;
    setBusy(path);
    setErr(null);
    try {
      const r = await fetch(`${API_URL}/v3/training/${agentId}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify(body ?? {}),
      });
      const j = (await r.json()) as TrainingState & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `status ${r.status}`);
      setState(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!address || !state) return null;

  const curIdx = STAGES.indexOf(state.stage === 'legacy_certified' ? 'certified' : (state.stage as (typeof STAGES)[number]));
  const lastEval = state.events.find((e) => e.event_type === 'eval');
  const proposals = state.events.filter((e) => e.event_type === 'dgm_proposal' && e.detail?.status === 'pending');

  return (
    <section id="train" className="space-y-4 rounded-xl border border-outline-variant/40 bg-surface-container-low p-5 scroll-mt-24">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Training pipeline</h2>
        <span className="font-mono text-[10px] uppercase text-on-surface-variant/70">owner only</span>
      </div>

      {/* Stepper */}
      <ol className="flex flex-wrap items-center gap-2">
        {STAGES.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${
                i < curIdx
                  ? 'border-primary-container/50 bg-primary-container/15 text-primary-container'
                  : i === curIdx
                    ? 'border-tertiary-container/60 bg-tertiary-container/20 text-on-tertiary-container'
                    : 'border-outline-variant/50 text-on-surface-variant/60'
              }`}
            >
              {i + 1}. {STAGE_LABEL[s]}
            </span>
            {i < STAGES.length - 1 && <span className="text-on-surface-variant/40">→</span>}
          </li>
        ))}
      </ol>

      {/* Stage action */}
      <div className="space-y-3">
        {state.stage === 'onboarded' && (
          <ActionButton label="Start training · Learn Stellar" busy={busy === 'learn'} onClick={() => act('learn')} />
        )}
        {state.stage === 'learning' && (
          <div className="space-y-2">
            <textarea
              value={skillMd}
              onChange={(e) => setSkillMd(e.target.value)}
              rows={4}
              placeholder="Paste a SKILL.md (optional — leave empty to auto-generate from a Raven playbook)"
              className="w-full rounded-lg border border-outline-variant/40 bg-background p-3 text-xs"
            />
            <ActionButton
              label="Acquire skill"
              busy={busy === 'skills'}
              onClick={() => act('skills', skillMd.trim() ? { skill_md: skillMd } : {})}
            />
          </div>
        )}
        {state.stage === 'skilling' && (
          <ActionButton label="Run evaluation (6 tasks)" busy={busy === 'evaluate'} onClick={() => act('evaluate')} />
        )}
        {state.stage === 'evaluating' && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-on-surface-variant">
              <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
              Publish to the Stellar Raven catalog on certify
            </label>
            <ActionButton
              label="Certify agent"
              busy={busy === 'certify'}
              onClick={() => act('certify', { auto_publish: autoPublish })}
            />
          </div>
        )}
        {(state.stage === 'certified' || state.stage === 'legacy_certified') && (
          <div className="rounded-lg border border-primary-container/40 bg-primary-container/10 p-3 text-xs">
            <p className="font-medium text-primary-container">
              {state.stage === 'certified' ? '✓ Certified Stellar Agent' : 'Legacy Certified'}
              {state.cert_score != null && ` · score ${(state.cert_score * 100).toFixed(0)}%`}
            </p>
            {state.certificate_hash && (
              <p className="mt-1 break-all font-mono text-[10px] text-on-surface-variant/80">
                {state.certificate_hash}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Eval scoreboard */}
      {Array.isArray(lastEval?.detail?.results) && (
        <div className="rounded-lg border border-outline-variant/40 bg-background p-3">
          <h3 className="mb-2 font-mono text-[10px] uppercase text-on-surface-variant">Last evaluation</h3>
          <ul className="grid grid-cols-2 gap-1 font-mono text-[11px]">
            {(lastEval.detail.results as Array<{ id: string; score: number }>).map((r) => (
              <li key={r.id} className="flex justify-between gap-2">
                <span className="truncate text-on-surface-variant">{r.id}</span>
                <span className={r.score >= 0.8 ? 'text-primary-container' : 'text-error'}>
                  {(r.score * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* DGM proposals */}
      {proposals.length > 0 && (
        <div className="rounded-lg border border-tertiary-container/40 bg-tertiary-container/10 p-3 text-xs">
          <h3 className="mb-1 font-medium text-on-tertiary-container">Improvement proposals</h3>
          <p className="text-on-surface-variant">
            {proposals.length} pending prompt improvement{proposals.length > 1 ? 's' : ''} — review in your seller inbox.
          </p>
        </div>
      )}

      {err && <p className="text-sm text-error">{err}</p>}
    </section>
  );
}

function ActionButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded-lg bg-primary-container px-5 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Working…' : label}
    </button>
  );
}
