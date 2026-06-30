'use client';

import { type PaymentMode } from '@openx/sdk';

interface Props {
  mode: PaymentMode;
  onChange: (next: PaymentMode) => void;
  basePriceUsdc: string;
  privateMultiplier?: number;
}

/**
 * PrivacyModeToggle — buyer-side tier picker.
 *
 * Default is Public (`paywall-router` + plain x402-on-Stellar). Flipping to
 * Private routes through the Privacy Pool, hiding amount + counterparty on
 * Stellar Expert at a 1.5× premium (configurable via env).
 */
export function PrivacyModeToggle({ mode, onChange, basePriceUsdc, privateMultiplier = 1.5 }: Props) {
  const privatePrice = (Number(basePriceUsdc) * privateMultiplier).toFixed(2);
  return (
    <div className="inline-flex rounded-lg border border-zinc-700 p-1 text-sm">
      <button
        onClick={() => onChange('public')}
        className={`rounded px-3 py-1 ${mode === 'public' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
      >
        Public · ${basePriceUsdc}
      </button>
      <button
        onClick={() => onChange('private')}
        className={`rounded px-3 py-1 ${mode === 'private' ? 'bg-emerald-700 text-white' : 'text-zinc-400 hover:text-white'}`}
        title="Privacy Pool — amount and counterparty are hidden on-chain"
      >
        Private · ${privatePrice}
      </button>
    </div>
  );
}
