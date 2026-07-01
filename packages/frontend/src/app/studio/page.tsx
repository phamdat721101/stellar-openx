'use client';

/**
 * /studio — owner dashboard.
 *
 * Mirrors the original Arbitrum-era studio but Stellar-native: lists the
 * connected wallet's published agents (via /v3/me/agents), per-agent revenue
 * accrued (from paid_calls), and a one-click archive action.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { API_URL } from '@/lib/stellar';

interface Agent {
  id: string;
  slug: string;
  persona: { system_prompt: string };
  pricing: { x402?: string };
  published: boolean;
  soroban_agent_id: string | null;
  created_at: string;
}

interface AgentStat {
  agent_id: string;
  calls: number;
  revenue_usdc: string;
}

export default function StudioPage() {
  const { address, connect, connecting } = useStellarWallet();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStat>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_URL}/v3/me/agents`, {
        headers: { 'x-stellar-address': address },
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = (await r.json()) as { agents: Agent[] };
      setAgents(j.agents);
      // Fetch per-agent stats in parallel.
      const entries = await Promise.all(
        j.agents.map(async (a) => {
          const res = await fetch(`${API_URL}/v3/agents/${a.id}/recent-calls?limit=50`).then((r) => r.json());
          const calls = (res?.calls ?? []) as Array<{ amount_usdc: string }>;
          const revenue = calls.reduce((s, c) => s + Number(c.amount_usdc ?? 0), 0);
          return [a.id, { agent_id: a.id, calls: calls.length, revenue_usdc: revenue.toFixed(4) }] as const;
        }),
      );
      setStats(Object.fromEntries(entries));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const archive = async (agent: Agent) => {
    if (!address) return;
    if (!confirm(`Archive ${agent.slug}? It disappears from /marketplace but historical calls stay visible.`)) return;
    const r = await fetch(`${API_URL}/v3/marketplace/seller/agent/${agent.id}/archive`, {
      method: 'POST',
      headers: { 'x-stellar-address': address },
    });
    if (r.ok) void refetch();
    else setError(`archive failed: ${await r.text()}`);
  };

  /**
   * withdrawShielded — v3.2. Delegates to the same ZK transact pipeline the
   * buyer uses on `/agent/[id]`, only with `ext_amount < 0` (a withdrawal).
   * The actual proof + note assembly lives on the buyer/hire page today; we
   * navigate there with a query flag so the seller reuses the same UX + wallet
   * signing path instead of duplicating the pipeline in Studio.
   *
   * SOLID: SRP kept — Studio owns the seller dashboard concern, not proving.
   */
  const withdrawShielded = (agent: Agent) => {
    if (!address) return;
    const accrued = stats[agent.id]?.revenue_usdc ?? '0';
    if (Number(accrued) <= 0) {
      setError('nothing to withdraw yet — sell a call first');
      return;
    }
    // Deep-link to the shielded withdrawal flow.
    window.location.href = `/agent/${agent.id}?withdraw=1&amount=${accrued}`;
  };

  if (!address) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-20 text-center">
        <h1 className="text-2xl font-bold">Sign in to manage your assistants</h1>
        <p className="text-zinc-400">Connect a Stellar wallet to view your published agents and revenue.</p>
        <button
          onClick={connect}
          disabled={connecting}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {connecting ? 'Connecting…' : 'Connect Stellar wallet'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Studio</h1>
          <p className="text-zinc-400">Your published assistants on Stellar testnet.</p>
        </div>
        <Link
          href="/docs#mint"
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
        >
          + Mint agent
        </Link>
      </header>

      {loading && <p className="text-zinc-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-zinc-400">
          You haven&apos;t published an agent yet.{' '}
          <Link href="/docs#mint" className="text-emerald-400 hover:underline">
            Mint your first →
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {agents.map((a) => {
            const s = stats[a.id];
            return (
              <li
                key={a.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900 p-5"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <Link
                    href={`/agent/${a.id}`}
                    className="font-semibold text-emerald-300 hover:underline"
                  >
                    {a.slug}
                  </Link>
                  <span className="font-mono text-xs text-zinc-500">${a.pricing?.x402 ?? '0'} / call</span>
                </div>
                <p className="line-clamp-2 text-sm text-zinc-400">{a.persona.system_prompt}</p>
                <dl className="mt-4 flex items-center gap-6 text-xs text-zinc-500">
                  <div>
                    <dt>Calls</dt>
                    <dd className="text-base font-semibold text-white">{s?.calls ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Revenue</dt>
                    <dd className="text-base font-semibold text-white">${s?.revenue_usdc ?? '0.0000'}</dd>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => withdrawShielded(a)}
                      disabled={!s?.calls}
                      className="rounded border border-emerald-700/50 px-2 py-1 text-xs text-emerald-300 hover:border-emerald-400 hover:text-emerald-200 disabled:opacity-30"
                      title="Claim accrued revenue as a shielded note (v3.2)"
                    >
                      Withdraw shielded
                    </button>
                    <button
                      onClick={() => archive(a)}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-red-500 hover:text-red-300"
                    >
                      Archive
                    </button>
                  </div>
                </dl>
                {a.soroban_agent_id && (
                  <div className="mt-2 truncate font-mono text-[10px] text-zinc-600">
                    soroban: {a.soroban_agent_id}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
