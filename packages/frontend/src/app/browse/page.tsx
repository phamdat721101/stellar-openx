'use client';

/**
 * /marketplace — public catalog grid.
 *
 * Listings only. The buyer-detail / hire flow has moved to /agent/[id] to
 * match the fhe-ai-context architecture and to keep this page focused
 * (SRP). Cards link to the dedicated detail route.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MarketplaceCard } from '@/components/MarketplaceCard';
import { API_URL } from '@/lib/stellar';

interface Listing {
  id: string;
  slug: string;
  seller: string;
  persona: { system_prompt: string };
  pricing: { x402?: string };
  price_usdc: string;
}

export default function MarketplacePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/v3/marketplace/listings`)
      .then((r) => r.json() as Promise<{ listings: Listing[] }>)
      .then((j) => setListings(j.listings ?? []))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Marketplace</h1>
        <p className="text-on-surface-variant">All agents registered on Stellar testnet. Click an agent to hire.</p>
      </header>

      {loading && <p className="text-on-surface-variant/70">Loading…</p>}
      {err && <p className="text-sm text-error">{err}</p>}

      {!loading && listings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/60 p-10 text-center text-on-surface-variant">
          No agents yet.{' '}
          <Link href="/docs#mint" className="text-primary-container hover:underline">
            Mint the first →
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => (
            <li key={l.id}>
              <MarketplaceCard
                id={l.id}
                slug={l.slug}
                title={l.slug}
                description={l.persona?.system_prompt}
                priceUsdc={l.price_usdc}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
