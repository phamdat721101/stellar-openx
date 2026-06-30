'use client';

/**
 * /onboard — buyer onboard fast-path.
 *
 * Three steps, one page:
 *   1. Intro — what OpenX-S is.
 *   2. Connect a Stellar Wallets Kit wallet.
 *   3. Optionally top up USDC, then go to /marketplace.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { useCredits } from '@/hooks/useCredits';
import { TopUpModal } from '@/components/TopUpModal';

export default function OnboardPage() {
  const { address, usdcBalance, connect, connecting } = useStellarWallet();
  const credits = useCredits();
  const [topUpOpen, setTopUpOpen] = useState(false);

  const step = !address ? 1 : Number(usdcBalance) === 0 && (!credits.balance || credits.balance < 1) ? 2 : 3;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-wider text-emerald-400">⭐ Welcome to OpenX-S</p>
        <h1 className="text-3xl font-bold leading-tight tracking-tight">
          Hire your first AI assistant in three steps.
        </h1>
      </header>

      <Step n={1} done={step > 1} title="Connect a Stellar wallet">
        {!address ? (
          <button
            onClick={connect}
            disabled={connecting}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {connecting ? 'Opening wallet…' : 'Connect Freighter / LOBSTR / Albedo'}
          </button>
        ) : (
          <p className="font-mono text-xs text-zinc-400">{address}</p>
        )}
      </Step>

      <Step n={2} done={step > 2} title="Top up USDC">
        {!address ? (
          <p className="text-sm text-zinc-500">Connect a wallet first.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-zinc-400">
              Current balance: <span className="font-mono">${usdcBalance}</span>
              {credits.enabled && ` · credits ${credits.display}`}
            </p>
            <button
              onClick={() => setTopUpOpen(true)}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-emerald-500"
            >
              Top up via Coinflow Stellar
            </button>
          </div>
        )}
      </Step>

      <Step n={3} done={false} title="Hire your first assistant">
        <Link
          href="/marketplace"
          className="inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
        >
          Open marketplace →
        </Link>
      </Step>

      <p className="pt-4 text-center text-sm text-zinc-500">
        Building an assistant?{' '}
        <Link href="/docs#mint" className="text-emerald-400 hover:underline">
          Mint in one prompt →
        </Link>
      </p>

      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} />
    </div>
  );
}

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border p-5 ${done ? 'border-emerald-800/60 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-900'}`}
    >
      <div className="mb-2 flex items-center gap-3">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs ${
            done ? 'bg-emerald-600 text-white' : 'border border-zinc-700 text-zinc-400'
          }`}
        >
          {done ? '✓' : n}
        </span>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="pl-10">{children}</div>
    </section>
  );
}
