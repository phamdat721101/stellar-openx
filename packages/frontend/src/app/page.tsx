'use client';

import { useState } from 'react';
import Link from 'next/link';
import { API_URL } from '@/lib/stellar';

interface Candidate {
  id: string;
  slug: string;
  persona: { system_prompt: string };
  pricing: { x402?: string };
  score: number;
  why: string;
}

const SAMPLES = [
  'translate this NDA to Vietnamese',
  'summarize 12 customer interviews into a positioning doc',
  'dedupe and enrich this CSV of 800 lead emails',
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
          submit();
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
            No match yet. <Link href="/docs#mint" className="text-emerald-400 hover:underline">Mint an agent →</Link>
          </p>
        ) : (
          <section>
            <h2 className="mb-3 text-xl font-semibold">{candidates.length} matching agent{candidates.length === 1 ? '' : 's'}</h2>
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
          {SAMPLES.map((s) => (
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
