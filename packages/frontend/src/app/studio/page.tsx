'use client';

/**
 * /studio — owner dashboard (Stellar-native, wallet-signed publish).
 *
 * v3.3:
 *   • + Mint agent → inline modal that runs the two-step wallet-signed publish:
 *       1. POST /v3/marketplace/seller/publish/build-xdr   (server prepares)
 *       2. wallet.signTransaction(xdr)                     (Freighter / LOBSTR)
 *       3. POST /v3/marketplace/seller/publish/confirm     (server submits)
 *   • Legacy rows with `soroban_agent_id=null` (from the retired free onboard)
 *     get a "Publish on-chain" button that re-signs and completes the mint
 *     in place — no data loss.
 *
 * SOLID:
 *   • SRP — page still owns "seller dashboard". Mint form is one local modal
 *     component; publish is one local hook (`usePublishAgent`). No new files.
 *   • DIP — depends on `useStellarWallet.signTransaction` — same abstraction
 *     used by the buyer hire flow, so this reuses the wallet plumbing.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { useEscrowActions } from '@/hooks/useEscrowActions';
import { API_URL, stellarExplorerTxUrl } from '@/lib/stellar';

interface Agent {
  id: string;
  slug: string;
  persona: { system_prompt: string; model?: string };
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

interface MintDraft {
  slug: string;
  display_name: string;
  system_prompt: string;
  price_usdc: string;
  // repair mode: prefilled + slug locked, targets existing pending row
  existing_agent_id: string | null;
}

const EMPTY_DRAFT: MintDraft = {
  slug: '',
  display_name: '',
  system_prompt: '',
  price_usdc: '0.05',
  existing_agent_id: null,
};

interface EscrowRow {
  id: string;
  contract_address: string;
  agent_id: string;
  slug: string;
  buyer_address: string;
  seller_address: string;
  question: string | null;
  answer: string | null;
  amount_usdc: string;
  status: string;
  answered_at: string | null;
  timeout_at: string | null;
  created_at: string;
  deploy_tx_hash: string | null;
  fund_tx_hash: string | null;
  approve_tx_hash: string | null;
  release_tx_hash: string | null;
  dispute_tx_hash: string | null;
  resolve_tx_hash: string | null;
}

interface WithdrawState {
  agent: Agent;
  balance_usdc: string | null;   // null while loading on-chain balance
  amount_usdc: string;            // input; defaults to full balance once loaded
  escrow_locked_usdc: string;    // pending buyer approval (locked in TW escrow)
  direct_paid_usdc: string;      // already-in-wallet from private/escrow rails
  hint: string | null;           // human-readable explanation when balance=0
  loading: boolean;
  status: string | null;
  err: string | null;
}

export default function StudioPage() {
  const { address, signTransaction, connect, connecting } = useStellarWallet();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStat>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mintDraft, setMintDraft] = useState<MintDraft | null>(null);
  const [withdrawState, setWithdrawState] = useState<WithdrawState | null>(null);
  const [escrows, setEscrows] = useState<EscrowRow[]>([]);
  const [purchases, setPurchases] = useState<EscrowRow[]>([]);
  const [busyContract, setBusyContract] = useState<string | null>(null);
  const runEscrowAction = useEscrowActions(address, signTransaction);

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
      const entries = await Promise.all(
        j.agents.map(async (a) => {
          const res = await fetch(`${API_URL}/v3/agents/${a.id}/recent-calls?limit=50`).then((r) => r.json());
          const calls = (res?.calls ?? []) as Array<{ amount_usdc: string }>;
          const revenue = calls.reduce((s, c) => s + Number(c.amount_usdc ?? 0), 0);
          return [a.id, { agent_id: a.id, calls: calls.length, revenue_usdc: revenue.toFixed(4) }] as const;
        }),
      );
      setStats(Object.fromEntries(entries));

      // PRD-T — seller escrow queue + buyer purchases inbox.
      // Sales:     rows where I'm seller AND still in flight (funded / answered / disputed).
      // Purchases: rows where I'm buyer (any status) — buyer needs a permanent
      //            entry point to approve/dispute answered rows they missed.
      try {
        const e = await fetch(`${API_URL}/v3/marketplace/escrow/me`, {
          headers: { 'x-stellar-address': address },
        }).then((r) => r.json()) as { escrows: EscrowRow[] };
        const all = e.escrows ?? [];
        setEscrows(
          all.filter(
            (row) =>
              row.seller_address === address &&
              ['funded', 'answered', 'disputed'].includes(row.status),
          ),
        );
        setPurchases(all.filter((row) => row.buyer_address === address));
      } catch { /* non-fatal — escrow tier may be off */ }
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

  const openWithdrawModal = (agent: Agent) => {
    if (!agent.soroban_agent_id) {
      setError('agent must be published on-chain before withdraw');
      return;
    }
    setWithdrawState({
      agent,
      balance_usdc: null,
      amount_usdc: '',
      escrow_locked_usdc: '0',
      direct_paid_usdc: '0',
      hint: null,
      loading: true,
      status: null,
      err: null,
    });
  };
  const closeWithdrawModal = () => setWithdrawState(null);

  const openMintModal = () => setMintDraft({ ...EMPTY_DRAFT });
  const openRepairModal = (agent: Agent) =>
    setMintDraft({
      slug: agent.slug,
      display_name: agent.slug,
      system_prompt: agent.persona.system_prompt,
      price_usdc: agent.pricing?.x402 ?? '0.05',
      existing_agent_id: agent.id,
    });
  const closeMintModal = () => setMintDraft(null);

  const syncEscrowFromChain = async (row: EscrowRow) => {
    if (!address) return;
    setError(null);
    try {
      const r = await fetch(`${API_URL}/v3/marketplace/escrow/${row.contract_address}/reconcile`, {
        method: 'POST',
        headers: { 'x-stellar-address': address },
      });
      if (!r.ok) throw new Error(`reconcile ${r.status}`);
      void refetch();
    } catch (e) {
      setError(`sync failed: ${(e as Error).message}`);
    }
  };

  // Buyer inbox actions: approve+release (2 wallet sigs) or dispute (1 sig).
  const purchaseApprove = async (row: EscrowRow) => {
    if (!address) return;
    setError(null);
    setBusyContract(row.contract_address);
    try {
      await runEscrowAction({ action: 'approve', contract_address: row.contract_address });
      await runEscrowAction({ action: 'release', contract_address: row.contract_address });
      void refetch();
    } catch (e) {
      setError(`approve failed: ${(e as Error).message}`);
    } finally {
      setBusyContract(null);
    }
  };

  const purchaseDispute = async (row: EscrowRow) => {
    if (!address) return;
    if (!confirm('Raise a dispute? Funds stay locked until platform reviews.')) return;
    setError(null);
    setBusyContract(row.contract_address);
    try {
      await runEscrowAction({ action: 'dispute', contract_address: row.contract_address });
      void refetch();
    } catch (e) {
      setError(`dispute failed: ${(e as Error).message}`);
    } finally {
      setBusyContract(null);
    }
  };

  const claimOverdue = async (row: EscrowRow) => {
    if (!address) return;
    setError(null);
    try {
      // Step 1: seller signs the dispute tx.
      const buildRes = await fetch(
        `${API_URL}/v3/marketplace/escrow/${row.contract_address}/claim-timeout`,
        { method: 'POST', headers: { 'x-stellar-address': address } },
      );
      if (!buildRes.ok) throw new Error(`claim-timeout ${buildRes.status}: ${await buildRes.text()}`);
      const { xdr } = (await buildRes.json()) as { xdr: string };
      const signed = await signTransaction(xdr);
      const submitRes = await fetch(`${API_URL}/v3/marketplace/escrow/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({ signed_xdr: signed, contract_address: row.contract_address, action: 'dispute' }),
      });
      if (!submitRes.ok) throw new Error(`dispute:submit ${submitRes.status}`);

      // Step 2: platform auto-resolves 100 % → seller.
      const autoRes = await fetch(
        `${API_URL}/v3/marketplace/escrow/${row.contract_address}/auto-resolve-timeout`,
        { method: 'POST', headers: { 'x-stellar-address': address } },
      );
      if (!autoRes.ok) throw new Error(`auto-resolve ${autoRes.status}: ${await autoRes.text()}`);
      void refetch();
    } catch (e) {
      setError(`claim overdue failed: ${(e as Error).message}`);
    }
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
        <button
          onClick={openMintModal}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
        >
          + Mint agent
        </button>
      </header>

      {loading && <p className="text-zinc-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {purchases.length > 0 && (
        <section className="rounded-xl border border-emerald-800/40 bg-emerald-950/10 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-200">
            Your purchases
            <span className="rounded-full border border-emerald-700/40 bg-emerald-900/30 px-2 py-0.5 font-mono text-[10px] uppercase">
              {purchases.length}
            </span>
            <span className="ml-2 text-[10px] font-normal text-zinc-500">
              Escrow-tier hires you paid for — approve to release USDC to the seller, or dispute.
            </span>
          </h2>
          <ul className="space-y-2">
            {purchases.map((row) => {
              const isBusy = busyContract === row.contract_address;
              const canApprove = row.status === 'answered';
              const canDispute = ['funded', 'answered', 'approved'].includes(row.status);
              return (
                <li key={row.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Link href={`/agent/${row.agent_id}`} className="font-mono text-emerald-300 hover:underline">
                      {row.slug}
                    </Link>
                    <span className="font-mono text-zinc-500">${Number(row.amount_usdc).toFixed(2)}</span>
                    <StatusPill status={row.status} />
                    <span className="ml-auto flex items-center gap-1">
                      <TxLink label="deploy"  hash={row.deploy_tx_hash} />
                      <TxLink label="fund"    hash={row.fund_tx_hash} />
                      <TxLink label="approve" hash={row.approve_tx_hash} />
                      <TxLink label="release" hash={row.release_tx_hash} />
                      <TxLink label="dispute" hash={row.dispute_tx_hash} />
                      <TxLink label="resolve" hash={row.resolve_tx_hash} />
                    </span>
                  </div>
                  {row.question && (
                    <p className="mt-2 line-clamp-2 text-xs text-zinc-400">
                      <span className="font-mono uppercase text-zinc-600">Q:</span> {row.question}
                    </p>
                  )}
                  {row.answer && (
                    <details className="mt-1 text-xs text-zinc-300">
                      <summary className="cursor-pointer text-emerald-400 hover:underline">
                        View answer
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono">
                        {row.answer}
                      </pre>
                    </details>
                  )}
                  {(canApprove || canDispute) && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {canApprove && (
                        <button
                          onClick={() => purchaseApprove(row)}
                          disabled={isBusy}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {isBusy ? 'Signing…' : 'Approve & release'}
                        </button>
                      )}
                      {canDispute && (
                        <button
                          onClick={() => purchaseDispute(row)}
                          disabled={isBusy}
                          className="rounded-lg border border-red-600/50 px-3 py-1 text-xs font-medium text-red-300 hover:border-red-400 hover:text-red-200 disabled:opacity-50"
                        >
                          Dispute
                        </button>
                      )}
                      {row.status === 'released' && (
                        <span className="text-xs text-emerald-300">✅ Released to seller</span>
                      )}
                      {row.status === 'resolved' && (
                        <span className="text-xs text-amber-300">⚖ Resolved by platform</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {escrows.length > 0 && (
        <section className="rounded-xl border border-amber-800/40 bg-amber-950/10 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-200">
            Escrow queue
            <span className="rounded-full border border-amber-700/40 bg-amber-900/30 px-2 py-0.5 font-mono text-[10px] uppercase">
              {escrows.length}
            </span>
            <span className="ml-2 text-[10px] font-normal text-zinc-500">Sales awaiting buyer approval.</span>
          </h2>
          <ul className="divide-y divide-amber-900/20">
            {escrows.map((row) => {
              const timeoutMs = row.timeout_at ? new Date(row.timeout_at).getTime() : 0;
              const remainMs = Math.max(0, timeoutMs - Date.now());
              const overdue = timeoutMs > 0 && remainMs === 0 && row.status === 'answered';
              const countdown =
                remainMs === 0
                  ? row.status === 'answered' ? 'timed out' : row.status
                  : `${Math.floor(remainMs / 3_600_000)}h ${Math.floor((remainMs % 3_600_000) / 60_000)}m left`;
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-3 py-2 text-xs">
                  <Link href={`/agent/${row.agent_id}`} className="font-mono text-emerald-300 hover:underline">
                    {row.slug}
                  </Link>
                  <span className="font-mono text-zinc-500">${Number(row.amount_usdc).toFixed(2)}</span>
                  <span className="font-mono text-zinc-500 truncate">buyer {row.buyer_address.slice(0, 6)}…{row.buyer_address.slice(-4)}</span>
                  <StatusPill status={row.status} />
                  <span className="flex items-center gap-1">
                    <TxLink label="deploy"  hash={row.deploy_tx_hash} />
                    <TxLink label="fund"    hash={row.fund_tx_hash} />
                    <TxLink label="dispute" hash={row.dispute_tx_hash} />
                  </span>
                  <span className="ml-auto font-mono text-zinc-400">{countdown}</span>
                  <button
                    onClick={() => syncEscrowFromChain(row)}
                    className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-200"
                    title="Refresh from on-chain state — if the buyer already released, this will unlock the row."
                  >
                    Sync
                  </button>
                  {overdue && (
                    <button
                      onClick={() => claimOverdue(row)}
                      className="rounded border border-amber-500/60 bg-amber-950/40 px-2 py-1 text-[11px] font-medium text-amber-100 hover:border-amber-400"
                    >
                      Claim overdue
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!loading && agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-10 text-center text-zinc-400">
          You haven&apos;t published an agent yet.{' '}
          <button onClick={openMintModal} className="text-emerald-400 hover:underline">
            Mint your first →
          </button>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {agents.map((a) => {
            const s = stats[a.id];
            const pending = !a.soroban_agent_id;
            return (
              <li
                key={a.id}
                className={`rounded-xl border p-5 ${pending ? 'border-amber-700/50 bg-amber-950/10' : 'border-zinc-800 bg-zinc-900'}`}
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
                {pending && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-amber-300">
                      ⚠ Not yet on-chain — buyers can&apos;t pay until you sign the mint tx.
                    </span>
                    <button
                      onClick={() => openRepairModal(a)}
                      className="rounded border border-amber-500/60 bg-amber-950/40 px-2 py-1 text-xs font-medium text-amber-200 hover:border-amber-400 hover:text-amber-100"
                    >
                      Publish on-chain
                    </button>
                  </div>
                )}
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
                      onClick={() => openWithdrawModal(a)}
                      disabled={!a.soroban_agent_id}
                      className="rounded border border-emerald-700/50 px-2 py-1 text-xs text-emerald-300 hover:border-emerald-400 hover:text-emerald-200 disabled:opacity-30"
                      title="Withdraw accrued USDC to your wallet (paid-call-ledger.agent_payout)"
                    >
                      Withdraw
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

      {mintDraft && (
        <MintModal
          draft={mintDraft}
          setDraft={setMintDraft}
          onClose={closeMintModal}
          address={address}
          signTransaction={signTransaction}
          onPublished={() => {
            closeMintModal();
            void refetch();
          }}
        />
      )}

      {withdrawState && (
        <WithdrawModal
          state={withdrawState}
          setState={setWithdrawState}
          onClose={closeWithdrawModal}
          address={address}
          signTransaction={signTransaction}
          onWithdrawn={() => {
            closeWithdrawModal();
            void refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Mint modal ─────────────────────────────────────────────────────────────

interface MintModalProps {
  draft: MintDraft;
  setDraft: (d: MintDraft) => void;
  onClose: () => void;
  address: string;
  signTransaction: (xdr: string) => Promise<string>;
  onPublished: () => void;
}

function MintModal({ draft, setDraft, onClose, address, signTransaction, onPublished }: MintModalProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isRepair = Boolean(draft.existing_agent_id);

  const validate = (): string | null => {
    if (!/^[a-z0-9-]{3,40}$/.test(draft.slug)) return 'slug must be 3-40 chars: a-z, 0-9, -';
    if (draft.system_prompt.trim().length < 20) return 'system_prompt must be at least 20 chars';
    if (!Number.isFinite(Number(draft.price_usdc)) || Number(draft.price_usdc) <= 0) {
      return 'price must be a positive number';
    }
    return null;
  };

  const publish = async () => {
    const invalid = validate();
    if (invalid) { setErr(invalid); return; }
    setBusy(true);
    setErr(null);
    setStatus('Preparing mint transaction…');
    try {
      const persona = { system_prompt: draft.system_prompt.trim() };
      const body = {
        slug: draft.slug,
        display_name: draft.display_name || draft.slug,
        persona,
        price_usdc: String(Number(draft.price_usdc)),
        manifest: { slug: draft.slug, price_usdc: String(Number(draft.price_usdc)), schema: 1 },
      };

      // 1. Build unsigned XDR
      const buildRes = await fetch(`${API_URL}/v3/marketplace/seller/publish/build-xdr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify(body),
      });
      if (!buildRes.ok) throw new Error(`build_xdr ${buildRes.status}: ${await buildRes.text()}`);
      const built = (await buildRes.json()) as { xdr: string; existing_agent_id: string | null };

      // 2. Wallet signs the register_agent tx envelope
      setStatus('Sign in your wallet to mint on-chain…');
      const signed = await signTransaction(built.xdr);

      // 3. Server submits + mirrors
      setStatus('Submitting to Stellar…');
      const confirmRes = await fetch(`${API_URL}/v3/marketplace/seller/publish/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({
          ...body,
          signed_xdr: signed,
          existing_agent_id: built.existing_agent_id ?? draft.existing_agent_id,
        }),
      });
      if (!confirmRes.ok) throw new Error(`confirm ${confirmRes.status}: ${await confirmRes.text()}`);
      onPublished();
    } catch (e) {
      setErr((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {isRepair ? 'Publish on-chain' : 'Mint a new agent'}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Your wallet will sign one Soroban `register_agent` tx (≈ 0.01 XLM fee).
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">✕</button>
        </header>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">Slug</span>
          <input
            type="text"
            value={draft.slug}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
            disabled={isRepair || busy}
            placeholder="my-agent"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm focus:border-emerald-500 focus:outline-none disabled:opacity-60"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">
            Display name <span className="text-zinc-600">(optional)</span>
          </span>
          <input
            type="text"
            value={draft.display_name}
            onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
            disabled={busy}
            placeholder="My Agent"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">System prompt</span>
          <textarea
            value={draft.system_prompt}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            rows={5}
            disabled={busy}
            placeholder="You are a senior … with 10 years of experience. When asked, you …"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">Price / call (USDC)</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={draft.price_usdc}
            onChange={(e) => setDraft({ ...draft, price_usdc: e.target.value })}
            disabled={busy}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm focus:border-emerald-500 focus:outline-none"
          />
        </label>

        {status && <p className="text-sm text-emerald-300">{status}</p>}
        {err && <p className="text-sm text-red-400">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={publish}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Working…' : isRepair ? 'Sign & publish on-chain' : 'Sign & mint'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Withdraw modal ─────────────────────────────────────────────────────────
//
// Two-step, mirrors the mint flow (SOLID / LSP with MintModal):
//   1. On mount → POST build-payout-xdr with empty body. Server reads the
//      on-chain balance from paid-call-ledger.get_agent_balance() and
//      returns { xdr, balance_usdc, amount_usdc }. UI displays balance and
//      pre-fills the input.
//   2. User edits amount (optional partial withdraw) → clicks Sign & withdraw
//      → wallet signs the tx envelope (source-account auth satisfies the
//      contract's seller.require_auth) → POST /submit → refresh.

interface WithdrawModalProps {
  state: WithdrawState;
  setState: (s: WithdrawState) => void;
  onClose: () => void;
  address: string;
  signTransaction: (xdr: string) => Promise<string>;
  onWithdrawn: () => void;
}

function WithdrawModal({ state, setState, onClose, address, signTransaction, onWithdrawn }: WithdrawModalProps) {
  const { agent } = state;

  // Fetch on-chain balance + pre-built XDR (full-balance default) on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_URL}/v3/marketplace/seller/agent/${agent.id}/build-payout-xdr`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-stellar-address': address },
          body: JSON.stringify({}),
        });
        const j = (await r.json()) as {
          balance_usdc?: string;
          amount_usdc?: string;
          escrow_locked_usdc?: string;
          direct_paid_usdc?: string;
          hint?: string;
          error?: string;
        };
        if (cancelled) return;
        const balance = j.balance_usdc ?? '0';
        setState({
          ...state,
          loading: false,
          balance_usdc: balance,
          amount_usdc: j.amount_usdc ?? balance,
          escrow_locked_usdc: j.escrow_locked_usdc ?? '0',
          direct_paid_usdc: j.direct_paid_usdc ?? '0',
          hint: j.hint ?? null,
          err: !r.ok && Number(balance) > 0 ? (j.error ?? `http ${r.status}`) : null,
        });
      } catch (e) {
        if (!cancelled) setState({ ...state, loading: false, err: (e as Error).message });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (Number(state.amount_usdc) <= 0) {
      setState({ ...state, err: 'amount must be > 0' });
      return;
    }
    setState({ ...state, err: null, status: 'Preparing withdraw transaction…' });
    try {
      // 1. Re-build with the seller-specified amount so the on-chain amount
      //    matches exactly (a stale XDR from mount is fine for full balance,
      //    but a partial edit needs a fresh build).
      const buildRes = await fetch(`${API_URL}/v3/marketplace/seller/agent/${agent.id}/build-payout-xdr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({ amount_usdc: state.amount_usdc }),
      });
      if (!buildRes.ok) throw new Error(`build_payout ${buildRes.status}: ${await buildRes.text()}`);
      const built = (await buildRes.json()) as { xdr: string; amount_usdc: string };

      // 2. Wallet signs
      setState({ ...state, status: `Sign in your wallet to withdraw $${built.amount_usdc}…` });
      const signed = await signTransaction(built.xdr);

      // 3. Submit via reusable /submit endpoint
      setState({ ...state, status: 'Submitting to Stellar…' });
      const submitRes = await fetch(`${API_URL}/v3/marketplace/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({ signed_xdr: signed }),
      });
      if (!submitRes.ok) throw new Error(`submit ${submitRes.status}: ${await submitRes.text()}`);
      const j = (await submitRes.json()) as { tx_hash?: string };
      if (!j.tx_hash) throw new Error('submit returned no tx_hash');

      onWithdrawn();
    } catch (e) {
      setState({ ...state, err: (e as Error).message, status: null });
    }
  };

  const busy = state.status !== null;
  const noBalance = !state.loading && Number(state.balance_usdc ?? '0') <= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Withdraw earnings</h2>
            <p className="mt-1 text-xs text-zinc-500">
              <code className="font-mono text-emerald-300">{agent.slug}</code> · pays USDC to your connected wallet.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">✕</button>
        </header>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <div className="text-xs uppercase tracking-wider text-zinc-500">Withdrawable now (paid-call-ledger)</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-emerald-300">
            {state.loading ? '…' : `$${Number(state.balance_usdc ?? 0).toFixed(4)}`}
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-600">Public-tier hires that settled to your on-chain payout ledger.</div>
        </div>

        {/* Cross-rail balance breakdown so the seller isn't confused when the
             on-chain withdrawable is 0 but Studio shows non-zero revenue. */}
        {(Number(state.escrow_locked_usdc) > 0 || Number(state.direct_paid_usdc) > 0) && (
          <div className="grid grid-cols-2 gap-2">
            {Number(state.escrow_locked_usdc) > 0 && (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
                <div className="text-[10px] uppercase tracking-wider text-amber-300">Locked in escrow</div>
                <div className="mt-1 font-mono text-lg font-semibold text-amber-100">
                  ${Number(state.escrow_locked_usdc).toFixed(4)}
                </div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Pending buyer approval or dispute resolution.</div>
              </div>
            )}
            {Number(state.direct_paid_usdc) > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400">Paid direct to wallet</div>
                <div className="mt-1 font-mono text-lg font-semibold text-zinc-200">
                  ${Number(state.direct_paid_usdc).toFixed(4)}
                </div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Private / released-escrow rails — already in your USDC balance.</div>
              </div>
            )}
          </div>
        )}

        {state.hint && !state.loading && noBalance && (
          <p className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
            💡 {state.hint}
          </p>
        )}

        {!noBalance && (
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-500">Amount to withdraw (USDC)</span>
            <input
              type="number"
              step="0.0001"
              min="0"
              max={state.balance_usdc ?? undefined}
              value={state.amount_usdc}
              onChange={(e) => setState({ ...state, amount_usdc: e.target.value })}
              disabled={state.loading || busy}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm focus:border-emerald-500 focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-zinc-500">
              default = full balance; partial withdraws leave the remainder on-chain
            </p>
          </label>
        )}

        {state.status && <p className="text-sm text-emerald-300">{state.status}</p>}
        {state.err && <p className="text-sm text-red-400">{state.err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={state.loading || busy || noBalance}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Working…' : noBalance ? 'Nothing to withdraw' : 'Sign & withdraw'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── Small pure UI helpers (SRP: one concern each) ─────────────────────────

function TxLink({ label, hash }: { label: string; hash: string | null }) {
  if (!hash) return null;
  const url = stellarExplorerTxUrl(hash);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[9px] uppercase text-zinc-400 hover:border-emerald-500 hover:text-emerald-300"
      title={`${label} tx: ${hash}`}
    >
      {label} ↗
    </a>
  );
}

function StatusPill({ status }: { status: string }) {
  const style =
    status === 'answered' ? 'border-amber-600/50 text-amber-200'
    : status === 'funded' ? 'border-emerald-700/50 text-emerald-200'
    : status === 'approved' ? 'border-emerald-500/50 text-emerald-100'
    : status === 'released' ? 'border-emerald-400/50 text-emerald-100 bg-emerald-900/20'
    : status === 'disputed' ? 'border-red-600/50 text-red-200'
    : status === 'resolved' ? 'border-amber-500/50 text-amber-100'
    : status === 'refunded' ? 'border-zinc-500/50 text-zinc-200'
    : status === 'deploying' ? 'border-zinc-600/50 text-zinc-400'
    : 'border-zinc-700/50 text-zinc-300';
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${style}`}>
      {status}
    </span>
  );
}
