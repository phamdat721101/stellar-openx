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
 * TopUpModal — fiat onramp via Coinflow Stellar.
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-full max-w-lg rounded-xl bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Top up USDC</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white">
            ✕
          </button>
        </div>
        {!hostedUrl ? (
          <>
            <p className="mb-4 text-sm text-zinc-400">
              Pay by SEPA, card, or Apple Pay. USDC arrives in your Stellar wallet in ≤15s.
            </p>
            <div className="grid grid-cols-3 gap-3">
              {PACKS.map((p) => (
                <button
                  key={p}
                  onClick={() => buyPack(p)}
                  className="rounded-lg border border-zinc-700 py-4 hover:bg-zinc-800"
                >
                  <div className="text-xl font-semibold">${p}</div>
                  <div className="text-xs text-zinc-400">{p} USDC</div>
                </button>
              ))}
            </div>
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          </>
        ) : (
          <iframe src={hostedUrl} className="h-[500px] w-full rounded-lg" title="Coinflow Stellar deposit" />
        )}
      </div>
    </div>
  );
}
