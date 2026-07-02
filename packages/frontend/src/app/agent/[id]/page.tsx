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
import { useEscrowActions } from '@/hooks/useEscrowActions';
import { API_URL, fmtUsdcAmount, stellarExplorerTxUrl } from '@/lib/stellar';
import {
  hireAgentIdField,
  prove,
  randomScalar248,
  type StellarPaymentChallenge,
} from '@openx/sdk';

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
  // PRD-T escrow tier — persists across renders so Approve/Dispute buttons
  // survive answer scrolling / page refreshes via localStorage.
  const [escrowAddr, setEscrowAddr] = useState<string | null>(null);
  const [escrowDone, setEscrowDone] = useState<'approved' | 'released' | 'disputed' | null>(null);

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
    // PRD-T — escrow tier runs a fully different flow (no 402 challenge; the
    // funded on-chain escrow IS the receipt). Dispatch here.
    if (mode === 'escrow') {
      void hireEscrow();
      return;
    }
    setBusy(true);
    setErr(null);
    setAnswer(null);
    try {
      // 1. First call — expect a 402 challenge. (v3.1 removed the
      //    "demo bypass" that used to return 200 + a free answer when the
      //    agent wasn't on-chain; that path leaked private payments.)
      const r0 = await fetch(`${API_URL}/api/v1/${agent.slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stellar-address': address,
          'x-payment-mode': mode,
        },
        body: JSON.stringify({ question }),
      });
      if (r0.status === 412) {
        throw new Error('Agent is awaiting on-chain registration — try again once the seller re-publishes.');
      }
      if (r0.status !== 402) throw new Error(`expected 402, got ${r0.status}`);
      const challenge = (await r0.json()) as StellarPaymentChallenge & { nonce: string };

      // 1b. Private tier: generate a real Groth16 proof bound to this agent
      //     BEFORE building the XDR — the proof is required by the payment
      //     gate on retry. Same wasm+zkey the runbook installs (Path B').
      let zkHeaders: Record<string, string> = {};
      if (mode === 'private') {
        setErr('Generating ZK proof… (≈3–8 s)');
        const wasmUrl = process.env.NEXT_PUBLIC_ZK_CIRCUIT_WASM_URL ?? '/circuits/prove_hire.wasm';
        const zkeyUrl = process.env.NEXT_PUBLIC_ZK_CIRCUIT_ZKEY_URL ?? '/circuits/prove_hire_final.zkey';
        const inputs = {
          secret: randomScalar248().toString(),
          nonce: randomScalar248().toString(),
          agent_id: hireAgentIdField(agent.slug).toString(),
        };
        const { proof, publicSignals } = await prove(inputs, { wasmUrl, zkeyUrl });
        zkHeaders = {
          'x-zk-proof': btoa(JSON.stringify(proof)),
          'x-zk-public': btoa(JSON.stringify(publicSignals)),
        };
        setErr(null);
      }

      // 2. Build XDR — same shape for public and private in v3.2. Private
      //    uses the platform-relay strategy; the ZK proof gates settlement.
      const xdrRes = await fetch(`${API_URL}/v3/marketplace/seller/agent/${agent.id}/build-hire-xdr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({ payment_mode: mode, nonce: challenge.nonce }),
      });
      if (!xdrRes.ok) throw new Error(`build_xdr ${xdrRes.status}`);
      const xdrToSign = ((await xdrRes.json()) as { xdr: string }).xdr;

      // 3. Wallet co-signs + submit
      const signed = await signTransaction(xdrToSign);
      const submitRes = await fetch(`${API_URL}/v3/marketplace/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({ signed_xdr: signed }),
      });
      if (!submitRes.ok) throw new Error(`submit ${submitRes.status}`);
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
          ...zkHeaders,
        },
        body: JSON.stringify({ question }),
      });
      if (!retry.ok) throw new Error(`retry ${retry.status}`);
      const j = (await retry.json()) as { answer: string };
      setAnswer(j.answer);
      void refresh();
    } catch (e) {
      const msg = (e as Error).message;
      // If any zk-* error surfaces, the buyer's Private attempt failed on our
      // side (missing/misformatted circuit assets). Public tier is unaffected
      // — surface it as a one-click fallback so the buyer always has a path.
      const zkFailure = /^zk-|private tier not configured|private_context|build_private_transact/.test(msg);
      if (zkFailure && mode === 'private') {
        setErr(`${msg}\nSwitch to Public ($${Number(agent.pricing?.x402 ?? 0).toFixed(2)}) below to complete this call.`);
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const switchToPublicAndHire = () => {
    setMode('public');
    setErr(null);
    // Defer to next tick so the mode state has committed before we resubmit.
    setTimeout(() => void hire(), 0);
  };

  // ── PRD-T escrow flow ─────────────────────────────────────────────────────
  //
  // 4 wallet signatures: deploy → fund → (server delivers answer) → approve
  // → release. Buyer can dispute instead of approve. localStorage caches the
  // in-flight contract address so a refresh doesn't lose the escrow.

  const escrowStorageKey = agent ? `openx.escrow.${agent.id}` : '';

  useEffect(() => {
    if (!agent) return;
    try {
      const cached = window.localStorage.getItem(`openx.escrow.${agent.id}`);
      if (cached) {
        const p = JSON.parse(cached);
        if (p?.contract_address) setEscrowAddr(p.contract_address);
        if (p?.answer) setAnswer(p.answer);
        if (p?.status) setEscrowDone(p.status);
      }
    } catch { /* ignore */ }
  }, [agent]);

  const persistEscrow = (patch: Record<string, unknown>) => {
    if (!agent) return;
    try {
      const key = `openx.escrow.${agent.id}`;
      const cur = JSON.parse(window.localStorage.getItem(key) ?? '{}');
      window.localStorage.setItem(key, JSON.stringify({ ...cur, ...patch }));
    } catch { /* ignore */ }
  };

  const runEscrowAction = useEscrowActions(address, signTransaction);

  const hireEscrow = async () => {
    if (!agent) return;
    setBusy(true);
    setAnswer(null);
    setEscrowDone(null);
    setErr(null);
    try {
      // 1. Deploy escrow (buyer sign #1) — server pre-builds via TW deploy.
      setErr('Step 1/4 · Deploying escrow contract… sign in wallet');
      const dep = await runEscrowAction({ action: 'deploy', agent_id: agent.id, question });
      setEscrowAddr(dep.contract_address);
      persistEscrow({ contract_address: dep.contract_address, status: 'deploying' });

      // 2. Fund escrow (buyer sign #2)
      setErr('Step 2/4 · Locking USDC in escrow… sign in wallet');
      await runEscrowAction({ action: 'fund', contract_address: dep.contract_address });
      persistEscrow({ status: 'funded' });

      // 3. Trigger inference — the gate accepts the funded escrow as receipt.
      setErr('Step 3/4 · Agent working…');
      const infRes = await fetch(`${API_URL}/api/v1/${agent.slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stellar-address': address ?? '',
          'x-payment-mode': 'escrow',
          'x-payment': `escrow ${dep.contract_address}`,
        },
        body: JSON.stringify({ question }),
      });
      if (!infRes.ok) throw new Error(`inference ${infRes.status}: ${await infRes.text()}`);
      const inf = (await infRes.json()) as { answer: string };
      setAnswer(inf.answer);
      persistEscrow({ answer: inf.answer, status: 'answered' });

      // 4. Wait for buyer to click Approve or Dispute — no auto-sign.
      setErr('Step 4/4 · Review the answer and click Approve & release (or Dispute).');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const escrowApprove = async () => {
    if (!escrowAddr) return;
    setBusy(true);
    setErr(null);
    try {
      setErr('Approve · sign #1/2 in wallet…');
      await runEscrowAction({ action: 'approve', contract_address: escrowAddr });
      setErr('Release · sign #2/2 in wallet…');
      await runEscrowAction({ action: 'release', contract_address: escrowAddr });
      setEscrowDone('released');
      setErr(null);
      persistEscrow({ status: 'released' });
      void refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const escrowDispute = async () => {
    if (!escrowAddr) return;
    setBusy(true);
    setErr(null);
    try {
      setErr('Raising dispute · sign in wallet…');
      await runEscrowAction({ action: 'dispute', contract_address: escrowAddr });
      setEscrowDone('disputed');
      setErr('Dispute raised. Platform will review the case; funds stay locked.');
      persistEscrow({ status: 'disputed' });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const escrowReset = () => {
    if (agent && escrowStorageKey) window.localStorage.removeItem(escrowStorageKey);
    setEscrowAddr(null);
    setEscrowDone(null);
    setAnswer(null);
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
                disabled={busy || connecting || !onChain}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy
                  ? 'Working…'
                  : !address
                    ? 'Connect & Hire'
                    : `Hire · ${mode === 'private' ? 'Private' : 'Public'}`}
              </button>
              {!onChain && (
                <span className="text-xs text-amber-400">
                  Awaiting on-chain registration — the seller must publish this agent before buyers can pay USDC.
                </span>
              )}
              {err && (
                <div className="flex flex-col gap-2">
                  <span className="whitespace-pre-line text-sm text-red-400">{err}</span>
                  {mode === 'private' && /^zk-|private/.test(err) && (
                    <button
                      onClick={switchToPublicAndHire}
                      disabled={busy}
                      className="self-start rounded-lg border border-emerald-600 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:border-emerald-400 hover:text-emerald-200 disabled:opacity-50"
                    >
                      Switch to Public · ${Number(price).toFixed(2)}
                    </button>
                  )}
                </div>
              )}
            </div>
            {answer && (
              <article className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase text-emerald-400">Result</h3>
                <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-100">{answer}</pre>
                {mode === 'escrow' && escrowAddr && !escrowDone && (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                    <span className="text-xs text-amber-300">
                      Funds locked in escrow · <code className="font-mono">{escrowAddr.slice(0, 8)}…{escrowAddr.slice(-4)}</code>
                    </span>
                    <button
                      onClick={escrowApprove}
                      disabled={busy}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500 disabled:opacity-50"
                    >
                      Approve &amp; release
                    </button>
                    <button
                      onClick={escrowDispute}
                      disabled={busy}
                      className="rounded-lg border border-red-600/50 px-3 py-1.5 text-xs font-medium text-red-300 hover:border-red-400 hover:text-red-200 disabled:opacity-50"
                    >
                      Dispute
                    </button>
                  </div>
                )}
                {escrowDone === 'released' && (
                  <div className="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-3 text-xs text-emerald-300">
                    ✅ Payment released to seller.
                    <button onClick={escrowReset} className="underline hover:text-emerald-200">Hire again</button>
                  </div>
                )}
                {escrowDone === 'disputed' && (
                  <div className="mt-4 border-t border-zinc-800 pt-3 text-xs text-amber-300">
                    Dispute raised. Platform will resolve; funds remain in escrow until then.
                  </div>
                )}
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
                  {recent.map((r) => {
                    const explorer = stellarExplorerTxUrl(r.tx_hash);
                    const body = (
                      <>
                        <span className="truncate text-emerald-300">{r.buyer_anon}</span>
                        <span className="text-zinc-100">${fmtUsdcAmount(r.amount_usdc)}</span>
                        <span className="shrink-0 rounded-full border border-zinc-700 px-1.5 py-0.5 text-[9px] uppercase text-zinc-400">
                          {r.method.replace('stellar_', '').replace('privacy_pool', 'private')}
                        </span>
                        <span className="shrink-0 text-zinc-500">{relTime(r.created_at)}</span>
                        {explorer && (
                          <span
                            aria-hidden
                            className="shrink-0 text-zinc-500 group-hover:text-emerald-300"
                            title="View on Stellar Expert"
                          >
                            ↗
                          </span>
                        )}
                      </>
                    );
                    return (
                      <li key={r.tx_hash} className="group" title={r.tx_hash}>
                        {explorer ? (
                          <a
                            href={explorer}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="flex items-center justify-between gap-2 py-1.5 font-mono text-[11px] hover:bg-zinc-800/40 -mx-2 px-2 rounded"
                          >
                            {body}
                          </a>
                        ) : (
                          <div className="flex items-center justify-between gap-2 py-1.5 font-mono text-[11px]">
                            {body}
                          </div>
                        )}
                      </li>
                    );
                  })}
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
