'use client';

/**
 * BudgetVaultForm — reusable modal for create / topup / withdraw.
 *
 * Single component, three modes (via `mode` prop) to keep the file surface
 * small while respecting SRP: all three actions are "vault balance change"
 * flows sharing 90 %+ of validation + signing UX. Parent decides which
 * mode + which vault (for topup / withdraw) — form owns only its own inputs.
 */

import { useState } from 'react';
import { STELLAR_KNOWN_ASSETS } from '@openx/sdk';
import type { BudgetVault, DeployVaultInput } from '@/hooks/useBudgetVaults';

type Mode = 'create' | 'topup' | 'withdraw';

interface Props {
  mode: Mode;
  vault?: BudgetVault;                                 // required for topup / withdraw
  network: 'testnet' | 'mainnet';
  onSubmit: (input: {
    // create
    deploy?: DeployVaultInput;
    // topup / withdraw
    amount?: string;
  }) => Promise<void>;
  onCancel: () => void;
}

const TITLES: Record<Mode, string> = {
  create: 'Create budget vault',
  topup: 'Top up vault',
  withdraw: 'Withdraw from vault',
};

export default function BudgetVaultForm({ mode, vault, network, onSubmit, onCancel }: Props) {
  const [asset, setAsset] = useState<string>(vault?.asset_code ?? (network === 'mainnet' ? 'USDC' : 'USDC'));
  const [amount, setAmount] = useState<string>('');
  const [totalCap, setTotalCap] = useState<string>('');
  const [perHireCap, setPerHireCap] = useState<string>('');
  const [allowlistMode, setAllowlistMode] = useState<'any' | 'slugs' | 'sellers'>('any');
  const [allowlistRaw, setAllowlistRaw] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withdrawAll, setWithdrawAll] = useState(false);

  const availableAssets = Object.keys(STELLAR_KNOWN_ASSETS[network] ?? {});
  const isCreate = mode === 'create';
  const isWithdraw = mode === 'withdraw';
  const currentBalance = vault?.balance_cache ?? '0';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    // Basic validation.
    if (isCreate) {
      if (!amount || Number(amount) <= 0) { setErr('Deposit amount must be > 0'); return; }
    } else if (isWithdraw) {
      if (!withdrawAll && (!amount || Number(amount) <= 0)) { setErr('Amount must be > 0 (or check Withdraw all)'); return; }
      if (!withdrawAll && Number(amount) > Number(currentBalance)) {
        setErr(`Amount exceeds balance (${currentBalance} ${vault?.asset_code})`); return;
      }
    } else { // topup
      if (!amount || Number(amount) <= 0) { setErr('Amount must be > 0'); return; }
    }

    try {
      setSubmitting(true);
      if (isCreate) {
        const entries = allowlistRaw
          .split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        await onSubmit({
          deploy: {
            asset_code: asset,
            initial_deposit: amount,
            total_cap: totalCap || undefined,
            per_hire_cap: perHireCap || undefined,
            allowlist_mode: allowlistMode,
            allowlist: allowlistMode === 'any' ? [] : entries,
          },
        });
      } else if (isWithdraw) {
        await onSubmit({ amount: withdrawAll ? '0' : amount });
      } else {
        await onSubmit({ amount });
      }
    } catch (submitErr) {
      setErr((submitErr as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl bg-surface-container p-6 shadow-xl"
      >
        <h3 className="text-lg font-semibold text-on-surface">{TITLES[mode]}</h3>
        {vault && !isCreate && (
          <p className="mt-1 text-xs text-on-surface-variant/70">
            Vault balance: <span className="font-mono">{currentBalance} {vault.asset_code}</span>
          </p>
        )}

        <div className="mt-4 space-y-4">
          {isCreate && (
            <div>
              <label className="block text-sm font-medium text-on-surface-variant">Asset</label>
              <select
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                className="mt-1 block w-full rounded-lg border-outline-variant/60 shadow-sm focus:border-primary-container focus:ring-primary-container"
              >
                {availableAssets.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-on-surface-variant/70">
                {network === 'testnet' && asset === 'TMGUSD' ? 'MoneyGram USD on Stellar testnet.' : ''}
                {network === 'mainnet' && asset === 'MGUSD' ? 'MoneyGram USD — cashable at 500K retail locations.' : ''}
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-on-surface-variant">
              {isWithdraw ? 'Amount to withdraw' : isCreate ? 'Initial deposit' : 'Top-up amount'}
            </label>
            <input
              type="number"
              min="0"
              step="0.0000001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isWithdraw && withdrawAll}
              placeholder="0.0000000"
              className="mt-1 block w-full rounded-lg border-outline-variant/60 font-mono shadow-sm focus:border-primary-container focus:ring-primary-container disabled:bg-surface-container"
            />
            {isWithdraw && (
              <label className="mt-2 flex items-center gap-2 text-xs text-on-surface-variant">
                <input
                  type="checkbox"
                  checked={withdrawAll}
                  onChange={(e) => setWithdrawAll(e.target.checked)}
                  className="rounded border-outline-variant/60 text-primary-container focus:ring-primary-container"
                />
                Withdraw all + close vault
              </label>
            )}
          </div>

          {isCreate && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-on-surface-variant">Total cap (optional)</label>
                  <input
                    type="number" min="0" step="0.0000001" placeholder="unlimited"
                    value={totalCap} onChange={(e) => setTotalCap(e.target.value)}
                    className="mt-1 block w-full rounded-lg border-outline-variant/60 font-mono shadow-sm focus:border-primary-container focus:ring-primary-container"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-on-surface-variant">Per-hire cap (optional)</label>
                  <input
                    type="number" min="0" step="0.0000001" placeholder="no cap"
                    value={perHireCap} onChange={(e) => setPerHireCap(e.target.value)}
                    className="mt-1 block w-full rounded-lg border-outline-variant/60 font-mono shadow-sm focus:border-primary-container focus:ring-primary-container"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-on-surface-variant">Allowlist mode</label>
                <div className="mt-2 flex gap-3 text-sm">
                  {(['any', 'slugs', 'sellers'] as const).map((m) => (
                    <label key={m} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        checked={allowlistMode === m}
                        onChange={() => setAllowlistMode(m)}
                        className="text-primary-container focus:ring-primary-container"
                      />
                      {m === 'any' ? 'Any agent' : m === 'slugs' ? 'Specific agents' : 'Specific sellers'}
                    </label>
                  ))}
                </div>
                {allowlistMode !== 'any' && (
                  <textarea
                    value={allowlistRaw}
                    onChange={(e) => setAllowlistRaw(e.target.value)}
                    placeholder={allowlistMode === 'slugs'
                      ? 'agent-slug-1, agent-slug-2, …'
                      : 'GABCD…, GEFGH… (Stellar G-addresses, one per line)'}
                    rows={2}
                    className="mt-2 block w-full rounded-lg border-outline-variant/60 font-mono text-xs shadow-sm focus:border-primary-container focus:ring-primary-container"
                  />
                )}
              </div>
            </>
          )}
        </div>

        {err && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-outline-variant/60 bg-surface-container px-4 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-primary-container px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting
              ? 'Signing…'
              : isCreate ? 'Create & fund' : isWithdraw ? 'Sign withdraw' : 'Sign topup'}
          </button>
        </div>
      </form>
    </div>
  );
}
