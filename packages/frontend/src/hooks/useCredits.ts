'use client';

/**
 * useCredits — buyer's API-side credit balance (PRD-G).
 *
 * Reads `/v3/credits/me` (auth-gated). Returns a minimal shape sufficient
 * for the header pill + low-balance prompt. When the credit-system feature
 * flag is off, `enabled: false` and callers hide the pill.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStellarWallet } from './useStellarWallet';
import { API_URL } from '@/lib/stellar';

interface CreditMe {
  wallet: string;
  balance_usdc: string;
  welcome_granted: boolean;
}

export function useCredits(lowThreshold = 1) {
  const { address } = useStellarWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!address) {
      setBalance(null);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/v3/credits/me`, {
        headers: { 'x-stellar-address': address },
      });
      if (r.status === 404) {
        setEnabled(false);
        return;
      }
      if (!r.ok) return;
      const j = (await r.json()) as CreditMe;
      setBalance(Number(j.balance_usdc));
      setEnabled(true);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    balance,
    display: balance === null ? '—' : `$${balance.toFixed(2)}`,
    isLow: balance !== null && balance < lowThreshold,
    enabled,
    loading,
    refetch,
  };
}
