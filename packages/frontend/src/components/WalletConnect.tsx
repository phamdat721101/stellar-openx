'use client';

import { useStellarWallet } from '@/hooks/useStellarWallet';

export function WalletConnect() {
  const { address, usdcBalance, connecting, connect, disconnect } = useStellarWallet();

  if (!address) {
    return (
      <button
        onClick={connect}
        disabled={connecting}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {connecting ? 'Connecting…' : 'Connect Stellar Wallet'}
      </button>
    );
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return (
    <div className="flex items-center gap-3">
      <div className="text-right">
        <div className="text-xs uppercase tracking-wide text-zinc-400">USDC</div>
        <div className="text-sm font-semibold">{usdcBalance}</div>
      </div>
      <button
        onClick={disconnect}
        className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
        title="Click to disconnect"
      >
        {short}
      </button>
    </div>
  );
}
