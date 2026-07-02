'use client';

import { type PaymentMode } from '@openx/sdk';

interface Props {
  mode: PaymentMode;
  onChange: (next: PaymentMode) => void;
  basePriceUsdc: string;
  privateMultiplier?: number;
  escrowMultiplier?: number;
  escrowEnabled?: boolean;
}

/**
 * PrivacyModeToggle — buyer-side tier picker (3 modes).
 *
 * Public   → paywall-router, 1× base price, instant settlement.
 * Private  → Privacy Pool, 1.5× base price, hides counterparty on-chain.
 * Escrow   → Trustless Work single-release, 2× base price, buyer approves
 *            or disputes AFTER seeing the answer; 24h seller-claim fallback.
 *
 * SOLID (SRP): pure UI, no fetches. Parent owns the mode state.
 */
export function PrivacyModeToggle({
  mode,
  onChange,
  basePriceUsdc,
  privateMultiplier = 1.5,
  escrowMultiplier = 2.0,
  escrowEnabled = true,
}: Props) {
  const base = Number(basePriceUsdc);
  const privatePrice = (base * privateMultiplier).toFixed(2);
  const escrowPrice = (base * escrowMultiplier).toFixed(2);

  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-zinc-700 p-1 text-sm">
      <button
        onClick={() => onChange('public')}
        className={`rounded px-3 py-1 ${mode === 'public' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'}`}
        title="Instant settlement; buyer and seller both visible on Stellar Expert"
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
      {escrowEnabled && (
        <button
          onClick={() => onChange('escrow')}
          className={`rounded px-3 py-1 ${mode === 'escrow' ? 'bg-amber-700 text-white' : 'text-zinc-400 hover:text-white'}`}
          title="Trustless Work escrow — funds held on-chain until you approve the delivered answer (24h auto-release)"
        >
          Escrow · ${escrowPrice}
        </button>
      )}
    </div>
  );
}
