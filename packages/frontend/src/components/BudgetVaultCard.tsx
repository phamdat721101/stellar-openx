'use client';

/**
 * BudgetVaultCard — per-vault display + action affordances.
 *
 * SOLID (SRP): renders one vault. Mutations are delegated to the parent's
 * `onTopup`, `onWithdraw`, `onEditAllowlist`, `onClose` callbacks — this
 * component owns no chain/API state.
 */

import { useState, useEffect } from 'react';
import { API_URL, stellarExplorerTxUrl } from '@/lib/stellar';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import type { BudgetVault } from '@/hooks/useBudgetVaults';

interface Hire {
  id: string;
  slug: string;
  amount_usdc: string;
  asset_code: string;
  method: string;
  tx_hash: string;
  created_at: string;
}

interface Props {
  vault: BudgetVault;
  onTopup: () => void;
  onWithdraw: () => void;
  onEditAllowlist: () => void;
  onClose: () => void;
  onPause: () => void;
  /** Optional yield summary for this vault — falls through when yield flag is off. */
  reward?: {
    monthStroops: string;
    totalStroops: string;
    apyBp: number;
    boostDaysRemaining: number;
  };
}

const STATUS_LABEL: Record<BudgetVault['status'], string> = {
  deploying: '⏳ Deploying',
  active: '🟢 Active',
  paused: '⏸ Paused',
  closed: '⊘ Closed',
};

const STATUS_COLOR: Record<BudgetVault['status'], string> = {
  deploying: 'text-amber-700 bg-amber-50 border-amber-200',
  active: 'text-emerald-800 bg-emerald-50 border-emerald-200',
  paused: 'text-slate-700 bg-slate-100 border-slate-200',
  closed: 'text-slate-500 bg-slate-100 border-slate-200',
};

function shorten(addr: string, chars = 6): string {
  return addr.length <= chars * 2 + 2 ? addr : `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

function contractExplorerUrl(contract: string, network: 'testnet' | 'mainnet'): string {
  return `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}/contract/${contract}`;
}

/**
 * RewardBadge — inline micro-component (PRD-N v0.31 yield-rewards).
 * Renders only when the yield flag is on AND the vault has an APY assigned.
 */
function RewardBadge(props: {
  monthStroops: string;
  totalStroops: string;
  apyBp: number;
  assetCode: string;
  boostDaysRemaining: number;
}) {
  const YIELD_ENABLED = process.env.NEXT_PUBLIC_FEATURE_M2_VAULT_YIELD === 'true';
  if (!YIELD_ENABLED) return null;
  const month = fromStroopsFmt(props.monthStroops);
  const boostChip = props.boostDaysRemaining > 0
    ? <span className="ml-1 rounded-sm bg-emerald-100 px-1 text-emerald-800">boost {props.boostDaysRemaining}d</span>
    : null;
  return (
    <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
      <span>+{month} {props.assetCode}</span>
      <span className="text-emerald-600">this month · {(props.apyBp / 100).toFixed(1)}% APY</span>
      {boostChip}
    </div>
  );
}

function fromStroopsFmt(stroops: string | null | undefined): string {
  if (!stroops || stroops === '0') return '0';
  const s = BigInt(stroops);
  const whole = s / 10_000_000n;
  const frac = s % 10_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

function AllowlistSummary({ vault }: { vault: BudgetVault }) {
  if (vault.allowlist_mode === 'any') return <span>Any agent</span>;
  const n = Array.isArray(vault.allowlist) ? vault.allowlist.length : 0;
  const label = vault.allowlist_mode === 'slugs' ? 'agents' : 'sellers';
  return <span>{n} {label} allowlisted</span>;
}

export default function BudgetVaultCard({ vault, onTopup, onWithdraw, onEditAllowlist, onClose, onPause, reward }: Props) {
  const { address } = useStellarWallet();
  const [showHires, setShowHires] = useState(false);
  const [hires, setHires] = useState<Hire[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!showHires || hires !== null || !address) return;
    let cancelled = false;
    fetch(`${API_URL}/v3/marketplace/budget/${vault.id}/hires?limit=5`, {
      headers: { 'x-stellar-address': address },
    })
      .then((r) => (r.ok ? r.json() : { hires: [] }))
      .then((j: { hires: Hire[] }) => { if (!cancelled) setHires(j.hires ?? []); })
      .catch(() => { if (!cancelled) setHires([]); });
    return () => { cancelled = true; };
  }, [showHires, hires, address, vault.id]);

  const balance = vault.balance_cache ?? '0';
  const disabled = vault.status !== 'active';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-flex rounded-full border px-2 py-0.5 font-medium ${STATUS_COLOR[vault.status]}`}>
              {STATUS_LABEL[vault.status]}
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-slate-600">
              {vault.asset_code}
            </span>
            <a
              href={contractExplorerUrl(vault.contract_address, vault.network)}
              target="_blank"
              rel="noreferrer"
              className="text-slate-500 hover:text-slate-700"
              title="View on Stellar Expert"
            >
              {shorten(vault.contract_address)}
            </a>
            <button
              type="button"
              className="text-slate-400 hover:text-slate-600"
              onClick={() => {
                navigator.clipboard.writeText(vault.contract_address).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? '✓' : '⎘'}
            </button>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-semibold text-slate-900">{balance}</span>
            <span className="text-sm text-slate-500">{vault.asset_code} available</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {vault.hire_count} hire{vault.hire_count === 1 ? '' : 's'} · {vault.total_spent} {vault.asset_code} spent
            {vault.per_hire_cap ? ` · cap ${vault.per_hire_cap}/hire` : ''}
            {' · '}<AllowlistSummary vault={vault} />
          </div>
          {reward ? (
            <RewardBadge
              monthStroops={reward.monthStroops}
              totalStroops={reward.totalStroops}
              apyBp={reward.apyBp}
              assetCode={vault.asset_code}
              boostDaysRemaining={reward.boostDaysRemaining}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onTopup}
          disabled={disabled}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Top up
        </button>
        <button
          type="button"
          onClick={onWithdraw}
          disabled={Number(balance) <= 0}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Withdraw
        </button>
        <button
          type="button"
          onClick={onEditAllowlist}
          disabled={disabled}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Edit allowlist
        </button>
        {vault.status === 'active' ? (
          <button
            type="button"
            onClick={onPause}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Pause
          </button>
        ) : vault.status === 'paused' ? (
          <button
            type="button"
            onClick={() => onPause()}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Resume
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          disabled={vault.status === 'closed'}
          className="ml-auto rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Close vault
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowHires((v) => !v)}
        className="mt-3 flex w-full items-center justify-between text-xs text-slate-500 hover:text-slate-700"
      >
        <span>{showHires ? '▼' : '▶'} Recent hires ({vault.hire_count})</span>
      </button>

      {showHires && (
        <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {hires === null ? (
            <div className="text-slate-400">Loading…</div>
          ) : hires.length === 0 ? (
            <div className="text-slate-400">No hires yet — vault is fresh.</div>
          ) : (
            hires.map((h) => {
              const explorerUrl = stellarExplorerTxUrl(h.tx_hash, vault.network);
              return (
                <div key={h.id} className="flex items-center justify-between">
                  <span className="truncate font-mono">{h.slug}</span>
                  <span className="ml-2 whitespace-nowrap">
                    {h.amount_usdc} {h.asset_code}{' '}
                    {explorerUrl ? (
                      <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">tx↗</a>
                    ) : (
                      <span className="text-slate-400">{h.method}</span>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
