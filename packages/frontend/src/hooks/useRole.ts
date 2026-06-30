'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/stellar';

export type Role = 'producer' | 'consumer' | 'unknown';

/**
 * useRole — reads `/v3/me/agents`; producer if the caller owns at least one
 * published agent, consumer otherwise. Single GET per session.
 */
export function useRole(address: string | undefined) {
  const [role, setRole] = useState<Role>('unknown');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setRole('unknown');
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${API_URL}/v3/me/agents`, { headers: { 'x-stellar-address': address } })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((data: { agents: unknown[] }) => {
        if (!cancelled) setRole(data.agents?.length ? 'producer' : 'consumer');
      })
      .catch(() => {
        if (!cancelled) setRole('consumer');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return { role, loading };
}
