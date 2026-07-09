/**
 * CertifiedBadge — PRD-T-S public trust signal on the marketplace + detail page.
 *
 * Renders a pill for the agent's training stage. Public (buyers see it too).
 * SRP: pure presentational — no data fetching, no state.
 */

const LABEL: Record<string, { text: string; cls: string }> = {
  certified: {
    text: '✓ Certified Stellar Agent',
    cls: 'border-primary-container/50 bg-primary-container/15 text-primary-container',
  },
  legacy_certified: {
    text: 'Legacy Certified',
    cls: 'border-outline-variant/60 bg-surface-container text-on-surface-variant',
  },
  evaluating: {
    text: 'Certification in Progress',
    cls: 'border-tertiary-container/50 bg-tertiary-container/15 text-on-tertiary-container',
  },
};

export function CertifiedBadge({ stage }: { stage?: string | null }) {
  const meta = stage ? LABEL[stage] : undefined;
  if (!meta) return null;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${meta.cls}`}
    >
      {meta.text}
    </span>
  );
}
