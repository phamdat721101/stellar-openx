import Link from 'next/link';

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
      className="group flex h-full flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 hover:border-emerald-500/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="rounded-lg bg-emerald-500/10 px-2 py-1 text-xs text-emerald-400">⭐ Stellar</div>
        {acceptsPrivate && (
          <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] text-purple-300">
            Privacy ready
          </span>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold leading-snug group-hover:text-emerald-300">{title}</h3>
        <p className="line-clamp-2 text-sm text-zinc-400">{description}</p>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
              #{tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-end justify-between gap-2 border-t border-zinc-800 pt-3">
        {ownerAddress && (
          <span className="font-mono text-[11px] text-zinc-500">
            {ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)}
          </span>
        )}
        {priceUsdc ? (
          <span className="text-sm font-semibold">
            ${priceUsdc} <span className="text-xs text-zinc-500">USDC/call</span>
          </span>
        ) : (
          <span className="text-[11px] text-zinc-500">Free preview</span>
        )}
      </div>
      {slug && <div className="font-mono text-[10px] text-zinc-500">/api/v1/{slug}</div>}
    </Link>
  );
}
