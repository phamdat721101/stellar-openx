'use client';

import { useState } from 'react';
import Link from 'next/link';
import { API_URL } from '@/lib/stellar';
import { FEATURE_UI_V2 } from '@/lib/uiFlags';
import { OpenXMark } from '@/components/AppShell';

/**
 * Homepage — the single entrypoint into OpenX.
 *
 * PRD-U (2026-07-08): behind FEATURE_UI_V2 the page collapses to 3 elements
 * above-the-fold (logo · 7-word pitch · single-line input with embedded
 * submit) plus 3 sample-prompt pills below the input. Legacy 5-layer stack
 * preserved unchanged for one-release rollback.
 *
 * SRP: this file owns "buyer entrypoint". Discovery ranker lives on the
 * server (`POST /v3/discover`); this page renders the request + response.
 */

interface Candidate {
  id: string;
  slug: string;
  persona: { system_prompt: string };
  pricing: { x402?: string };
  score: number;
  why: string;
}

// Hybrid conversion + brand-vibe prompts (PRD-U Q4=c). First two map to
// real seeded agents (translator + lead-dedup analyst); third maps to the
// auditor agent seeded by `scripts/seed-auditor-agent.ts` (Task 9).
const SAMPLE_PROMPTS = [
  'Translate this NDA to Vietnamese',
  'Dedupe 800 leads by industry',
  'Audit a Soroban contract',
] as const;

export default function HomePage() {
  const [demand, setDemand] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const message = demand.trim();
    if (!message || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API_URL}/v3/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const { candidates: c } = (await r.json()) as { candidates: Candidate[] };
      setCandidates(c);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return FEATURE_UI_V2 ? (
    <HomeV2
      demand={demand}
      setDemand={setDemand}
      busy={busy}
      err={err}
      candidates={candidates}
      submit={submit}
    />
  ) : (
    <HomeLegacy
      demand={demand}
      setDemand={setDemand}
      busy={busy}
      err={err}
      candidates={candidates}
      submit={submit}
    />
  );
}

// ──────────────────────────────────────────────────────────────────────────
// V2 — Google-style single-input hero.
// ──────────────────────────────────────────────────────────────────────────

interface HomeProps {
  demand: string;
  setDemand: (v: string) => void;
  busy: boolean;
  err: string | null;
  candidates: Candidate[] | null;
  submit: () => Promise<void>;
}

function HomeV2({ demand, setDemand, busy, err, candidates, submit }: HomeProps) {
  const isEmpty = demand.trim().length === 0;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2xl px-margin-mobile py-2xl md:px-margin-desktop">
      {/* 1 · Logo */}
      <div className="text-primary-container">
        <OpenXMark size={80} />
      </div>

      {/* 2 · 7-word pitch */}
      <h1 className="text-center font-display text-4xl font-bold tracking-tight text-on-surface md:text-display-lg">
        Hire an AI agent to do the work.
      </h1>

      {/* 3 · Single-line input with embedded submit */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-2xl"
        aria-label="Describe your task"
      >
        <div className="relative">
          <input
            type="text"
            value={demand}
            onChange={(e) => setDemand(e.target.value)}
            placeholder="What do you need done?"
            aria-label="Task description"
            className="h-16 w-full rounded-full border border-outline-variant/40 bg-surface-container-low px-lg pr-20 text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary-container focus:outline-none focus:ring-2 focus:ring-primary-container/30"
          />
          <button
            type="submit"
            disabled={busy || isEmpty}
            aria-label={busy ? 'Matching…' : 'Match agent'}
            className="absolute right-xs top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-primary-container text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? (
              <span className="material-symbols-outlined text-[20px] animate-spin" aria-hidden>autorenew</span>
            ) : (
              <span className="material-symbols-outlined text-[24px]" aria-hidden>arrow_forward</span>
            )}
          </button>
        </div>
      </form>

      {/* 4 · Sample pills — visible when the input is empty AND we have no results yet */}
      {isEmpty && !candidates && (
        <div className="flex flex-wrap justify-center gap-sm">
          {SAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setDemand(prompt)}
              className="rounded-full border border-outline-variant/60 bg-surface-container px-md py-sm text-sm text-on-surface-variant transition-colors hover:border-primary-container/60 hover:text-primary-container"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {err && (
        <p role="alert" className="text-sm text-error">
          {err}
        </p>
      )}

      {/* 5 · Results section (replaces pills post-submit) */}
      {candidates && (
        <section className="w-full">
          {candidates.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-outline-variant/60 p-xl text-center text-on-surface-variant">
              No match yet.{' '}
              <Link href="/docs#mint" className="text-primary-container hover:underline">
                Mint an agent →
              </Link>
            </p>
          ) : (
            <>
              <h2 className="mb-md text-lg font-semibold text-on-surface">
                {candidates.length} matching agent{candidates.length === 1 ? '' : 's'}
              </h2>
              <ul className="grid gap-md md:grid-cols-2 lg:grid-cols-3">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/agent/${c.id}`}
                      className="block rounded-2xl border border-outline-variant/40 bg-surface-container-low p-lg transition-colors hover:border-primary-container/60"
                    >
                      <div className="mb-sm flex items-center justify-between text-xs">
                        <span className="text-primary-container">/{c.slug}</span>
                        <span className="font-mono text-on-surface-variant">score {c.score.toFixed(1)}</span>
                      </div>
                      <p className="mb-md line-clamp-3 text-sm text-on-surface-variant">
                        {c.persona.system_prompt.slice(0, 160)}
                      </p>
                      {c.why && <p className="text-xs italic text-on-surface-variant/70">{c.why}</p>}
                      <div className="mt-md font-mono text-sm text-on-surface">
                        ${c.pricing.x402 ?? '0'} <span className="text-on-surface-variant">USDC</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Legacy — pre-PRD-U 5-layer stack. Preserved verbatim so flag=false is a
// byte-identical rollback. Do not modify without a follow-up PRD.
// ──────────────────────────────────────────────────────────────────────────

function HomeLegacy({ demand, setDemand, busy, err, candidates, submit }: HomeProps) {
  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-wider text-emerald-400">
          ⭐ Stellar-native · USDC · ZK Privacy Pool optional
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
          Hire AI assistants. Pay per task. Get the result in seconds.
        </h1>
        <p className="max-w-2xl text-zinc-400 md:text-lg">
          Describe what you need in plain English. Pay $0.50–$5 USDC on Stellar. Optional Privacy Pool premium tier
          hides amount + counterparty.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
      >
        <textarea
          value={demand}
          onChange={(e) => setDemand(e.target.value)}
          placeholder="What do you need delivered?"
          rows={4}
          className="min-h-[120px] w-full resize-none bg-transparent text-base placeholder:text-zinc-500 focus:outline-none"
        />
        <div className="flex items-center justify-between border-t border-zinc-800 pt-3">
          <span className="text-xs text-zinc-500">⌘↵ to submit</span>
          <button
            type="submit"
            disabled={busy || !demand.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Matching…' : 'Match agent'}
          </button>
        </div>
      </form>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {candidates ? (
        candidates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-700 p-8 text-center text-zinc-400">
            No match yet.{' '}
            <Link href="/docs#mint" className="text-emerald-400 hover:underline">
              Mint an agent →
            </Link>
          </p>
        ) : (
          <section>
            <h2 className="mb-3 text-xl font-semibold">
              {candidates.length} matching agent{candidates.length === 1 ? '' : 's'}
            </h2>
            <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {candidates.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/agent/${c.id}`}
                    className="block rounded-xl border border-zinc-800 bg-zinc-900 p-5 hover:border-emerald-500/40"
                  >
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <span className="text-emerald-400">/{c.slug}</span>
                      <span className="font-mono text-zinc-500">score {c.score.toFixed(1)}</span>
                    </div>
                    <p className="mb-3 line-clamp-3 text-sm text-zinc-400">{c.persona.system_prompt.slice(0, 160)}</p>
                    {c.why && <p className="text-xs italic text-zinc-500">{c.why}</p>}
                    <div className="mt-3 font-mono text-sm">${c.pricing.x402 ?? '0'} USDC</div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : (
        <section className="grid gap-3 md:grid-cols-3">
          {[
            'translate this NDA to Vietnamese',
            'summarize 12 customer interviews into a positioning doc',
            'dedupe and enrich this CSV of 800 lead emails',
          ].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setDemand(s)}
              className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-left text-sm text-zinc-400 hover:border-emerald-500/40 hover:text-white"
            >
              {s}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
