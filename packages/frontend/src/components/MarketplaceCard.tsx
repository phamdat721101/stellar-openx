'use client';

import Link from 'next/link';

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
      className="group flex h-full flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 hover:border-emerald-500/40"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase text-emerald-400">
          Agent
        </span>
        {props.acceptsPrivate && (
          <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] text-purple-300">
            Privacy ready
          </span>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold leading-snug group-hover:text-emerald-300">{props.title}</h3>
        {props.description && <p className="line-clamp-2 text-sm text-zinc-400">{props.description}</p>}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-500">
        <span className="font-mono">/api/v1/{props.slug}</span>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-emerald-300">
          ${Number(props.priceUsdc).toFixed(2)} · Hire
        </span>
      </div>
    </Link>
  );
}
