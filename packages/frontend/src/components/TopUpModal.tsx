'use client';

import { useEffect, useState } from 'react';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { API_URL } from '@/lib/stellar';

const PACKS = [25, 50, 100];

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * TopUpModal — fiat onramp via Coinflow Stellar (PRD-U restyle, 2026-07-08).
 *
 * Step 1: buyer picks pack → API mints a SEP-24 deposit session.
 * Step 2: hosted iframe handles SEPA / Apple Pay / Card.
 * Step 3: Coinflow webhook → API credits buyer_credits.
 */
export function TopUpModal({ open, onClose, onSuccess }: Props) {
  const { address, refresh } = useStellarWallet();
  const [hostedUrl, setHostedUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`${API_URL}/api/v1/credits/status/${sessionId}`);
        const j = await r.json();
        if (j.status === 'completed') {
          clearInterval(interval);
          onSuccess?.();
          await refresh();
          onClose();
        }
      } catch {
        /* ignore */
      }
    }, 3_000);
    return () => clearInterval(interval);
  }, [sessionId, onClose, onSuccess, refresh]);

  if (!open) return null;

  const buyPack = async (usd: number) => {
    setError(null);
    if (!address) {
      setError('Connect a Stellar wallet first');
      return;
    }
    try {
      const r = await fetch(`${API_URL}/api/v1/credits/buy-pack-${usd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stellar_address: address }),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = await r.json();
      setHostedUrl(j.hosted_url);
      setSessionId(j.session_id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-margin-mobile">
      <div className="w-full max-w-lg rounded-2xl border border-outline-variant/40 bg-surface-container-high p-lg shadow-2xl">
        <div className="mb-md flex items-center justify-between">
          <h2 className="text-lg font-semibold text-on-surface">Top up USDC</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-on-surface"
          >
            ✕
          </button>
        </div>
        {!hostedUrl ? (
          <>
            <p className="mb-md text-sm text-on-surface-variant">
              Pay by SEPA, card, or Apple Pay. USDC arrives in your Stellar wallet in ≤15s.
            </p>
            <div className="grid grid-cols-3 gap-md">
              {PACKS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => buyPack(p)}
                  className="rounded-lg border border-outline-variant/60 py-md transition-colors hover:border-primary-container/60 hover:bg-surface-container"
                >
                  <div className="font-mono text-xl font-semibold text-on-surface">${p}</div>
                  <div className="text-xs text-on-surface-variant">{p} USDC</div>
                </button>
              ))}
            </div>
            {error && <p className="mt-md text-sm text-error">{error}</p>}
          </>
        ) : (
          <iframe src={hostedUrl} className="h-[500px] w-full rounded-lg" title="Coinflow Stellar deposit" />
        )}
      </div>
    </div>
  );
}
