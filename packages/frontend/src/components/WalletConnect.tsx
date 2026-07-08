'use client';

import { useStellarWallet } from '@/hooks/useStellarWallet';

/**
 * WalletConnect — Stellar Wallets Kit trigger + connected pill (PRD-U
 * restyle, 2026-07-08).
 */
export function WalletConnect() {
  const { address, usdcBalance, connecting, connect, disconnect } = useStellarWallet();

  if (!address) {
    return (
      <button
        type="button"
        onClick={connect}
        disabled={connecting}
        className="rounded-full bg-primary-container px-md py-sm text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {connecting ? 'Connecting…' : 'Connect Wallet'}
      </button>
    );
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return (
    <div className="flex items-center gap-md">
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-wider text-on-surface-variant">USDC</div>
        <div className="font-mono text-sm font-semibold text-on-surface">{usdcBalance}</div>
      </div>
      <button
        type="button"
        onClick={disconnect}
        title="Click to disconnect"
        className="rounded-full border border-outline-variant/60 px-md py-sm text-sm text-on-surface transition-colors hover:border-primary-container/60 hover:text-primary-container"
      >
        <span className="font-mono">{short}</span>
      </button>
    </div>
  );
}
