'use client';

/**
 * /settings — wallet + on-chain receipts.
 *
 * Stellar-native mirror of the original Arbitrum settings: shows the
 * connected Stellar account, USDC balance, network, and the four deployed
 * Soroban contract ids with deep-links to Stellar Expert.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { useCredits } from '@/hooks/useCredits';
import { TopUpModal } from '@/components/TopUpModal';
import { API_URL } from '@/lib/stellar';

interface PlatformInfo {
  network: string;
  contracts: Record<string, string>;
}

const EXPLORER = (network: string, id: string) =>
  `https://stellar.expert/explorer/${network}/contract/${id}`;

export default function SettingsPage() {
  const { address, usdcBalance, network, connect, disconnect, connecting } = useStellarWallet();
  const credits = useCredits();
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/platform`)
      .then((r) => r.json())
      .then(setPlatform)
      .catch(() => setPlatform(null));
  }, []);

  if (!address) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-20 text-center">
        <h1 className="text-2xl font-bold">Sign in to manage settings</h1>
        <button
          onClick={connect}
          disabled={connecting}
          className="rounded-lg bg-primary-container text-on-primary px-5 py-2.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {connecting ? 'Connecting…' : 'Connect Stellar wallet'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-on-surface-variant">Account, balance, and Stellar receipts.</p>
      </header>

      {/* Account */}
      <section className="space-y-3 rounded-xl border border-outline-variant/40 bg-surface-container-low p-6">
        <h2 className="text-lg font-semibold">Account</h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-xs text-on-surface-variant/70">Stellar address</div>
            <div className="truncate font-mono text-sm">{address}</div>
            <div className="mt-1 font-mono text-[10px] text-on-surface-variant/70">network: stellar:{network}</div>
          </div>
          <button
            onClick={disconnect}
            className="rounded-lg border border-outline-variant/60 px-4 py-2 text-sm text-error hover:border-error"
          >
            Sign out
          </button>
        </div>
      </section>

      {/* Balance */}
      <section className="space-y-3 rounded-xl border border-outline-variant/40 bg-surface-container-low p-6">
        <h2 className="text-lg font-semibold">USDC balance</h2>
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold">${usdcBalance}</span>
          <span className="text-sm text-on-surface-variant/70">USDC on Stellar {network}</span>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            onClick={() => setTopUpOpen(true)}
            className="rounded-lg bg-primary-container text-on-primary px-4 py-2 text-sm hover:opacity-90"
          >
            Top up
          </button>
          {credits.enabled && (
            <span className="rounded-lg border border-outline-variant/60 px-3 py-2 text-sm">
              Credit balance: {credits.display}
            </span>
          )}
        </div>
      </section>

      {/* Contracts */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Soroban contracts ({platform?.network ?? network})</h2>
        <div className="overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container-low">
          <table className="w-full text-sm">
            <thead className="bg-surface-container text-left font-mono text-[10px] uppercase text-on-surface-variant">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Contract id</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {platform &&
                Object.entries(platform.contracts).map(([name, id]) => (
                  <tr key={name} className="border-t border-outline-variant/40">
                    <td className="px-4 py-3 font-medium capitalize">{name.replace(/([A-Z])/g, ' $1').toLowerCase()}</td>
                    <td className="px-4 py-3 font-mono text-xs text-on-surface-variant">
                      {id ? `${id.slice(0, 8)}…${id.slice(-6)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {id && (
                        <Link
                          href={EXPLORER(platform.network, id)}
                          target="_blank"
                          rel="noopener"
                          className="text-xs text-primary-container hover:underline"
                        >
                          Stellar Expert ↗
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} />
    </div>
  );
}
