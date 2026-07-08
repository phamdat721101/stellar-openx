import Link from 'next/link';

/**
 * AgentCard — canonical marketplace tile (PRD-U restyle, 2026-07-08).
 *
 * Uses semantic tokens (primary-container / surface-container-low /
 * on-surface-variant / outline-variant) so a palette change ripples via
 * `tailwind.config.ts` without touching this component.
 */
export interface AgentCardProps {
  id: string | number;
  title: string;
  description: string;
  tags?: string[];
  ownerAddress?: string;
  priceUsdc?: string;
  href?: string;
  slug?: string;
  acceptsPrivate?: boolean;
}

export function AgentCard({
  id,
  title,
  description,
  tags = [],
  ownerAddress,
  priceUsdc,
  href,
  slug,
  acceptsPrivate,
}: AgentCardProps) {
  const target = href ?? `/agent/${id}`;
  return (
    <Link
      href={target}
      className="group flex h-full flex-col gap-md rounded-2xl border border-outline-variant/40 bg-surface-container-low p-lg transition-colors hover:border-primary-container/60"
    >
      <div className="flex items-start justify-between gap-md">
        <div className="rounded-lg bg-primary-container/10 px-sm py-xs text-xs text-primary-container">⭐ Stellar</div>
        {acceptsPrivate && (
          <span className="rounded-full bg-tertiary-container/20 px-sm py-xs text-[10px] text-on-tertiary-container">
            Privacy ready
          </span>
        )}
      </div>
      <div className="space-y-xs">
        <h3 className="font-semibold leading-snug text-on-surface group-hover:text-primary-container">{title}</h3>
        <p className="line-clamp-2 text-sm text-on-surface-variant">{description}</p>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-xs">
          {tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded-full border border-outline-variant/60 px-sm py-xs text-[10px] text-on-surface-variant">
              #{tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-end justify-between gap-sm border-t border-outline-variant/40 pt-md">
        {ownerAddress && (
          <span className="font-mono text-[11px] text-on-surface-variant/70">
            {ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)}
          </span>
        )}
        {priceUsdc ? (
          <span className="text-sm font-semibold text-on-surface">
            <span className="font-mono">${priceUsdc}</span>{' '}
            <span className="text-xs text-on-surface-variant">USDC/call</span>
          </span>
        ) : (
          <span className="text-[11px] text-on-surface-variant/70">Free preview</span>
        )}
      </div>
      {slug && <div className="font-mono text-[10px] text-on-surface-variant/70">/api/v1/{slug}</div>}
    </Link>
  );
}
