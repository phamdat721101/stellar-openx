'use client';

import Link from 'next/link';

/**
 * MarketplaceCard — /browse grid tile (PRD-U restyle, 2026-07-08).
 */
export interface MarketplaceCardProps {
  id: string;
  slug: string;
  title: string;
  description?: string;
  priceUsdc: string;
  acceptsPrivate?: boolean;
}

export function MarketplaceCard(props: MarketplaceCardProps) {
  return (
    <Link
      href={`/agent/${props.id}`}
      className="group flex h-full flex-col gap-md rounded-2xl border border-outline-variant/40 bg-surface-container-low p-lg transition-colors hover:border-primary-container/60"
    >
      <div className="flex items-start justify-between gap-sm">
        <span className="inline-flex items-center gap-xs rounded-full bg-primary-container/10 px-sm py-xs text-[10px] uppercase tracking-wider text-primary-container">
          Agent
        </span>
        {props.acceptsPrivate && (
          <span className="rounded-full bg-tertiary-container/20 px-sm py-xs text-[10px] text-on-tertiary-container">
            Privacy ready
          </span>
        )}
      </div>
      <div className="space-y-xs">
        <h3 className="font-semibold leading-snug text-on-surface group-hover:text-primary-container">{props.title}</h3>
        {props.description && (
          <p className="line-clamp-2 text-sm text-on-surface-variant">{props.description}</p>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-outline-variant/40 pt-md text-xs text-on-surface-variant/70">
        <span className="font-mono">/api/v1/{props.slug}</span>
        <span className="rounded-full bg-primary-container/10 px-sm py-xs font-mono text-primary-container">
          ${Number(props.priceUsdc).toFixed(2)} · Hire
        </span>
      </div>
    </Link>
  );
}
