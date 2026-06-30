'use client';

/**
 * /agent/[id] — buyer-focused detail page (Stellar-native).
 *
 * Mirrors the fhe-ai-context `/agent/[id]` bento layout while staying within
 * one file:
 *   header   : title + description + status pills + owner
 *   main 8/12: 3-stat grid · system instructions · hire form
 *   sidebar 4/12 (sticky) : Hire CTA + recent paid calls feed
 *
 * Hire flow: 402 → build XDR → wallet signs → /submit → retry with X-PAYMENT
 * receipt. Identical for public + private modes; backend dispatches.
 *
 * SOLID:
 *   • SRP — page renders + owns the per-page state. Network shape lives in
 *           thin local fetchers (one fetch per concern).
 *   • DIP — depends on hooks (useStellarWallet, useConnectedPrivacyMode) +
 *           env-config (API_URL). Easy to swap in tests.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PrivacyModeToggle } from '@/components/PrivacyModeToggle';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { useConnectedPrivacyMode } from '@/hooks/useConnectedPrivacyMode';
import { API_URL } from '@/lib/stellar';
import type { StellarPaymentChallenge } from '@openx/sdk';

interface Agent {
  id: string;
  slug: string;
  owner_address: string;
  persona: { system_prompt: string; model?: string };
  pricing: { x402?: string };
  soroban_agent_id: string | null;
  created_at: string;
}

interface RecentCall {
  created_at: string;
  amount_usdc: string;
  method: string;
  tx_hash: string;
  buyer_anon: string;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { address, signTransaction, connect, connecting } = useStellarWallet();
  const { mode, setMode } = useConnectedPrivacyMode();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [recent, setRecent] = useState<RecentCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const a = await fetch(`${API_URL}/v3/agents`).then((r) => r.json() as Promise<{ agents: Agent[] }>);
      const found = a.agents.find((x) => x.id === id || x.slug === id) ?? null;
      setAgent(found);
      if (found) {
        const c = await fetch(`${API_URL}/v3/agents/${found.id}/recent-calls?limit=8`).then((r) => r.json());
        setRecent((c?.calls ?? []) as RecentCall[]);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const hire = async () => {
    if (!agent) return;
    if (!address) {
      void connect();
      return;
    }
    if (!question.trim()) {
      setErr('Type a question first.');
      return;
    }
    setBusy(true);
    setErr(null);
    setAnswer(null);
    try {
      // 1. First call — 402 challenge OR direct 200 (off-chain demo path).
      const r0 = await fetch(`${API_URL}/api/v1/${agent.slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stellar-address': address,
          'x-payment-mode': mode,
        },
        body: JSON.stringify({ question }),
      });
      if (r0.status === 200) {
        // Off-chain demo (agent not yet registered on Soroban). Skip the
        // wallet-sign dance and surface the answer directly.
        const j = (await r0.json()) as { answer: string };
        setAnswer(j.answer);
        void refresh();
        return;
      }
      if (r0.status !== 402) throw new Error(`expected 402, got ${r0.status}`);
      const challenge = (await r0.json()) as StellarPaymentChallenge & { nonce: string };

      // 2. Build XDR (works for both public + private; backend dispatches)
      const xdrRes = await fetch(`${API_URL}/v3/marketplace/seller/agent/${agent.id}/build-hire-xdr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({ payment_mode: mode, nonce: challenge.nonce }),
      });
      if (!xdrRes.ok) throw new Error(`build_xdr ${xdrRes.status}`);
      const { xdr } = (await xdrRes.json()) as { xdr: string };

      // 3. Wallet co-signs + submit
      const signed = await signTransaction(xdr);
      const submitRes = await fetch(`${API_URL}/v3/marketplace/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signed_xdr: signed }),
      });
      const submitJson = (await submitRes.json()) as { tx_hash?: string };
      if (!submitJson.tx_hash) throw new Error('submit failed');

      // 4. Retry the paywalled endpoint with receipt
      const retry = await fetch(`${API_URL}/api/v1/${agent.slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stellar-address': address,
          'x-payment': `stellar ${submitJson.tx_hash}`,
          'x-payment-mode': mode,
          'x-payment-nonce': challenge.nonce,
        },
        body: JSON.stringify({ question }),
      });
      if (!retry.ok) throw new Error(`retry ${retry.status}`);
      const j = (await retry.json()) as { answer: string };
      setAnswer(j.answer);
      void refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="py-20 text-center text-zinc-500">Loading agent…</div>;
  if (!agent) {
    return (
      <div className="py-20 text-center">
        <p className="text-zinc-400">Agent not found.</p>
        <Link href="/marketplace" className="mt-3 inline-block text-sm text-emerald-400 hover:underline">
          ← Back to marketplace
        </Link>
      </div>
    );
  }

  const price = agent.pricing?.x402 ?? '0';
  const onChain = Boolean(agent.soroban_agent_id);

  return (
    <div className="space-y-6">
      <Link href="/marketplace" className="inline-block text-sm text-zinc-400 hover:text-white">
        ← Back to marketplace
      </Link>

      {/* HEADER */}
      <header className="space-y-3 border-b border-zinc-800 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-emerald-700/40 bg-emerald-900/30 px-2 py-0.5 font-mono text-[10px] uppercase text-emerald-300">
            {onChain ? 'LIVE on Stellar' : 'DRAFT'}
          </span>
          <span className="rounded-full border border-purple-700/40 bg-purple-900/20 px-2 py-0.5 font-mono text-[10px] uppercase text-purple-300">
            Privacy ready
          </span>
          <span className="font-mono text-[10px] text-zinc-500">/api/v1/{agent.slug}</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{agent.slug}</h1>
        <p className="max-w-3xl text-zinc-400">{agent.persona?.system_prompt}</p>
        <p className="font-mono text-xs text-zinc-500">
          Owner {agent.owner_address.slice(0, 6)}…{agent.owner_address.slice(-4)}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-12">
        {/* MAIN 8/12 */}
        <div className="space-y-5 lg:col-span-8">
          {/* 3-stat grid */}
          <section className="grid grid-cols-3 gap-3">
            <Stat label="Price / call" value={`$${Number(price).toFixed(2)}`} sub="USDC on Stellar" />
            <Stat label="Calls" value={String(recent.length)} sub="last 8" />
            <Stat
              label="Latency"
              value="≈30s"
              sub={agent.persona?.model ? `model ${agent.persona.model}` : 'gpt-4o-mini'}
            />
          </section>

          {/* system instructions */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
              <h2 className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                System instructions
              </h2>
              <span className="font-mono text-[10px] text-zinc-500">seller-authored</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed text-zinc-300">
              {agent.persona?.system_prompt}
            </pre>
          </section>

          {/* hire form */}
          <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">Hire this agent</h2>
              <PrivacyModeToggle mode={mode} onChange={setMode} basePriceUsdc={price} />
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={4}
              placeholder="What do you want this agent to do?"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm focus:border-emerald-500 focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={hire}
                disabled={busy || connecting}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy
                  ? 'Working…'
                  : !address
                    ? 'Connect & Hire'
                    : `Hire · ${mode === 'private' ? 'Private' : 'Public'}`}
              </button>
              {!onChain && (
                <span className="text-xs text-zinc-500">
                  Demo mode — chain payment skipped until the seller registers on Soroban.
                </span>
              )}
              {err && <span className="text-sm text-red-400">{err}</span>}
            </div>
            {answer && (
              <article className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase text-emerald-400">Result</h3>
                <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-100">{answer}</pre>
              </article>
            )}
          </section>
        </div>

        {/* SIDEBAR 4/12 */}
        <aside className="space-y-4 lg:col-span-4">
          <div className="sticky top-24 space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                  Recent transactions
                </h3>
                <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                  live
                </span>
              </div>
              {recent.length === 0 ? (
                <p className="py-3 text-center font-mono text-[11px] text-zinc-500">
                  No paid calls yet — be the first.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-800/80">
                  {recent.map((r) => (
                    <li
                      key={r.tx_hash}
                      className="flex items-center justify-between gap-2 py-1.5 font-mono text-[11px]"
                      title={r.tx_hash}
                    >
                      <span className="truncate text-emerald-300">{r.buyer_anon}</span>
                      <span className="text-zinc-100">${Number(r.amount_usdc).toFixed(2)}</span>
                      <span className="shrink-0 rounded-full border border-zinc-700 px-1.5 py-0.5 text-[9px] uppercase text-zinc-400">
                        {r.method.replace('stellar_', '').replace('privacy_pool', 'private')}
                      </span>
                      <span className="shrink-0 text-zinc-500">{relTime(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                For integrators
              </h3>
              <p className="text-zinc-400">
                Every published agent is an x402 endpoint at{' '}
                <code className="font-mono text-emerald-300">/api/v1/{agent.slug}</code>.
              </p>
              <Link href="/docs" className="mt-2 inline-block text-xs text-emerald-400 hover:underline">
                Read the integration docs →
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
