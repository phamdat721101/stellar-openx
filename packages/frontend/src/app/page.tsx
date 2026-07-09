'use client';

import { useState } from 'react';
import Link from 'next/link';
import { API_URL } from '@/lib/stellar';
import { OpenXMark } from '@/components/AppShell';

/**
 * Homepage — the single buyer entrypoint into OpenX.
 *
 * Google-style single-input hero: 3 elements above-the-fold (logo · 7-word
 * pitch · single-line input with embedded submit) plus 3 sample-prompt pills.
 *
 * SRP: this file owns "buyer entrypoint". The discovery ranker lives on the
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

// Hybrid conversion + brand-vibe prompts. First two map to real seeded agents
// (translator + lead-dedup analyst); third maps to the auditor agent seeded by
// `scripts/seed-auditor-agent.ts`.
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
