'use client';

/**
 * BudgetVaultAllowlistModal — edit the on-chain allowlist for one vault.
 * Buyer signs one tx (`set_allowlist`) which atomically replaces the mode +
 * entries. Preview shows the resulting rule so a mistake is caught before
 * the wallet prompt.
 */

import { useState } from 'react';
import type { BudgetVault } from '@/hooks/useBudgetVaults';

interface Props {
  vault: BudgetVault;
  onSubmit: (mode: 'any' | 'slugs' | 'sellers', slugs: string[], sellers: string[]) => Promise<void>;
  onCancel: () => void;
}

export default function BudgetVaultAllowlistModal({ vault, onSubmit, onCancel }: Props) {
  const [mode, setMode] = useState<'any' | 'slugs' | 'sellers'>(vault.allowlist_mode);
  const [raw, setRaw] = useState<string>(
    Array.isArray(vault.allowlist) ? vault.allowlist.join('\n') : '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const entries = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const slugs = mode === 'slugs' ? entries : [];
  const sellers = mode === 'sellers' ? entries : [];

  const preview = mode === 'any'
    ? 'This vault will accept hires from ANY agent.'
    : mode === 'slugs'
      ? entries.length
        ? `Only these agents can be hired: ${entries.slice(0, 3).join(', ')}${entries.length > 3 ? `, +${entries.length - 3} more` : ''}`
        : 'You must list at least one agent slug.'
      : entries.length
        ? `Only these sellers can be hired: ${entries.slice(0, 3).map((s) => s.slice(0, 8) + '…').join(', ')}${entries.length > 3 ? `, +${entries.length - 3} more` : ''}`
        : 'You must list at least one seller G-address.';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (mode === 'slugs' && slugs.length === 0) { setErr('Slugs mode requires at least one agent slug'); return; }
    if (mode === 'sellers') {
      if (sellers.length === 0) { setErr('Sellers mode requires at least one G-address'); return; }
      const bad = sellers.find((s) => !/^G[A-Z2-7]{55}$/.test(s));
      if (bad) { setErr(`Not a Stellar G-address: ${bad.slice(0, 12)}…`); return; }
    }
    try {
      setSubmitting(true);
      await onSubmit(mode, slugs, sellers);
    } catch (submitErr) {
      setErr((submitErr as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-surface-container p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-on-surface">Edit allowlist</h3>
        <p className="mt-1 text-xs text-on-surface-variant/70">
          Vault: <span className="font-mono">{vault.contract_address.slice(0, 12)}…</span>
        </p>

        <div className="mt-4">
          <label className="block text-sm font-medium text-on-surface-variant">Allowlist mode</label>
          <div className="mt-2 flex flex-col gap-2 text-sm">
            {(['any', 'slugs', 'sellers'] as const).map((m) => (
              <label key={m} className="flex items-start gap-2">
                <input
                  type="radio" checked={mode === m} onChange={() => setMode(m)}
                  className="mt-1 text-primary-container focus:ring-primary-container"
                />
                <span>
                  <span className="font-medium">
                    {m === 'any' ? 'Any agent' : m === 'slugs' ? 'Specific agents' : 'Specific sellers'}
                  </span>
                  <span className="ml-2 text-xs text-on-surface-variant/70">
                    {m === 'any' ? 'Server relays hires against any published agent.' :
                     m === 'slugs' ? 'Whitelist by agent slug.' :
                     'Whitelist by seller G-address.'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {mode !== 'any' && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-on-surface-variant">
              {mode === 'slugs' ? 'Agent slugs' : 'Seller G-addresses'}
              <span className="ml-2 text-xs font-normal text-on-surface-variant/70">(one per line, or comma-separated)</span>
            </label>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={5}
              placeholder={mode === 'slugs'
                ? 'translator-en-vi\nlegal-review'
                : 'GABCDEFGH…\nGIJKLMNOP…'}
              className="mt-1 block w-full rounded-lg border-outline-variant/60 font-mono text-xs shadow-sm focus:border-primary-container focus:ring-primary-container"
            />
          </div>
        )}

        <p className="mt-4 rounded-lg bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant">
          <strong>Preview:</strong> {preview}
        </p>

        {err && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-outline-variant/60 bg-surface-container px-4 py-2 text-sm font-medium text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-primary-container px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Signing…' : 'Sign & apply'}
          </button>
        </div>
      </form>
    </div>
  );
}
