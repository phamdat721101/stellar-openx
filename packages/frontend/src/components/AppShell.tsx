'use client';

/**
 * AppShell — global chrome (top nav + mobile bottom nav + footer).
 *
 * PRD-U (2026-07-08): behind `FEATURE_UI_V2` the nav labels flip to verb-
 * based (Hire / Browse / Publish / Docs / Settings) and every colour comes
 * from the Luminous Utility token set (primary-container, on-surface-
 * variant, outline-variant). Wallet + credits + Top-up pattern is preserved
 * verbatim, just restyled. Mobile bottom-nav mirrors the desktop nav using
 * Material Symbols icons for glanceability.
 *
 * SOLID:
 *   • SRP — one file owns shell layout; nav items are a const at the top.
 *   • OCP — flag adds new render path without touching legacy behaviour.
 *   • DIP — reads `useStellarWallet` + `useCredits` hooks (already
 *           test-friendly abstractions).
 */

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletConnect } from './WalletConnect';
import { TopUpModal } from './TopUpModal';
import { useStellarWallet } from '@/hooks/useStellarWallet';
import { useCredits } from '@/hooks/useCredits';
import { FEATURE_UI_V2 } from '@/lib/uiFlags';

interface NavItem {
  href: string;
  legacyHref?: string; // matched by isActive() so old URLs still highlight
  icon: string;         // Material Symbols name
  emoji: string;        // fallback for the pre-v2 top-nav (kept lightweight)
  label: string;
  labelV2: string;
}

// One array, two label variants — flip is a single boolean read.
const NAV: readonly NavItem[] = [
  { href: '/', icon: 'bolt', emoji: '🏠', label: 'Home', labelV2: 'Hire' },
  { href: '/browse', legacyHref: '/marketplace', icon: 'grid_view', emoji: '🛍️', label: 'Marketplace', labelV2: 'Browse' },
  { href: '/publish', legacyHref: '/studio', icon: 'add_circle', emoji: '🧪', label: 'Studio', labelV2: 'Publish' },
  { href: '/docs', icon: 'menu_book', emoji: '📚', label: 'Docs', labelV2: 'Docs' },
  { href: '/settings', icon: 'tune', emoji: '⚙️', label: 'Settings', labelV2: 'Settings' },
] as const;

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/';
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  if (item.legacyHref && (pathname === item.legacyHref || pathname.startsWith(`${item.legacyHref}/`))) return true;
  return false;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { address } = useStellarWallet();
  const credits = useCredits();
  const [topUpOpen, setTopUpOpen] = useState(false);

  return FEATURE_UI_V2 ? (
    <AppShellV2
      pathname={pathname ?? '/'}
      address={address}
      credits={credits}
      topUpOpen={topUpOpen}
      setTopUpOpen={setTopUpOpen}
    >
      {children}
    </AppShellV2>
  ) : (
    <AppShellLegacy
      pathname={pathname ?? '/'}
      address={address}
      credits={credits}
      topUpOpen={topUpOpen}
      setTopUpOpen={setTopUpOpen}
    >
      {children}
    </AppShellLegacy>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// V2 — Luminous Utility tokens, verb-nav, cyan brand.
// ──────────────────────────────────────────────────────────────────────────

interface ShellProps {
  pathname: string;
  address: string | null;
  credits: ReturnType<typeof useCredits>;
  topUpOpen: boolean;
  setTopUpOpen: (v: boolean) => void;
  children: ReactNode;
}

function AppShellV2({ pathname, address, credits, topUpOpen, setTopUpOpen, children }: ShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-on-surface">
      <header className="sticky top-0 z-40 border-b border-outline-variant bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-margin-mobile md:px-margin-desktop">
          <Link href="/" className="flex items-center gap-sm" aria-label="OpenX home">
            <span className="text-primary-container">
              <OpenXMark size={24} />
            </span>
            <span className="text-lg font-semibold tracking-tight">OpenX</span>
          </Link>
          <nav className="hidden items-center gap-xs md:flex" aria-label="Primary">
            {NAV.map((item) => {
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'rounded-full bg-primary-container px-md py-xs text-sm font-semibold text-on-primary'
                      : 'rounded-full px-md py-xs text-sm text-on-surface-variant transition-colors hover:text-primary-container'
                  }
                >
                  {item.labelV2}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-sm">
            {address && credits.enabled && (
              <button
                type="button"
                onClick={() => setTopUpOpen(true)}
                className={
                  credits.isLow
                    ? 'hidden items-center gap-xs rounded-full border border-tertiary-container/60 px-sm py-xs text-xs text-tertiary-container md:inline-flex'
                    : 'hidden items-center gap-xs rounded-full border border-outline-variant/60 px-sm py-xs text-xs text-on-surface-variant hover:border-primary-container/60 hover:text-primary-container md:inline-flex'
                }
                aria-label="Credits balance — click to top up"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden>account_balance_wallet</span>
                <span className="font-mono">{credits.display}</span>
              </button>
            )}
            <WalletConnect />
          </div>
        </div>
      </header>

      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-margin-mobile pb-24 pt-lg md:px-margin-desktop md:pb-lg">
        {children}
      </main>

      {/* Mobile bottom-nav — matches desktop labels; icons via Material Symbols. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant bg-background/95 backdrop-blur md:hidden"
        aria-label="Primary (mobile)"
      >
        <ul className="mx-auto flex max-w-md items-stretch">
          {NAV.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] text-primary-container'
                      : 'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] text-on-surface-variant'
                  }
                >
                  <span className="material-symbols-outlined text-[20px]" aria-hidden>
                    {item.icon}
                  </span>
                  {item.labelV2}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <footer className="mb-14 border-t border-outline-variant bg-surface-container-low px-margin-mobile py-lg text-center text-sm text-on-surface-variant md:mb-0 md:px-margin-desktop">
        <span className="font-mono text-label-caps">OPENX-S · Stellar-native AI-agent marketplace · MIT</span>
      </footer>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Legacy shell — kept byte-identical to pre-PRD-U so rollback is a flag flip.
// ──────────────────────────────────────────────────────────────────────────

function AppShellLegacy({ pathname, address, credits, topUpOpen, setTopUpOpen, children }: ShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-xl">⭐</span>
            <span className="text-lg font-bold tracking-tight">OpenX-S</span>
            <span className="text-xs uppercase text-emerald-500">Stellar</span>
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  isActive(pathname, item)
                    ? 'rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-white'
                    : 'rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white'
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {address && credits.enabled && (
              <button
                type="button"
                onClick={() => setTopUpOpen(true)}
                className={
                  credits.isLow
                    ? 'rounded-full border border-amber-500/60 px-3 py-1 text-xs text-amber-500'
                    : 'rounded-full border border-zinc-700 px-3 py-1 text-xs hover:border-emerald-500'
                }
              >
                {credits.display}
              </button>
            )}
            <WalletConnect />
          </div>
        </div>
      </header>
      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-8 md:px-8 md:pb-8">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur md:hidden">
        <ul className="mx-auto flex max-w-md items-stretch">
          {NAV.map((item) => (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={
                  isActive(pathname, item)
                    ? 'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] text-emerald-400'
                    : 'flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] text-zinc-400'
                }
              >
                <span className="text-base">{item.emoji}</span>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <footer className="mb-14 border-t border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center text-sm text-zinc-500 md:mb-0 md:px-8">
        OpenX-S · Stellar-native AI assistant marketplace · MIT
      </footer>
    </div>
  );
}

// Tiny inline OpenX SVG mark — matches src/app/icon.svg but inlined so nav
// pill picks up `currentColor` from Tailwind. Kept in AppShell to avoid
// creating a new component file for a 5-path graphic.
function OpenXMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1" />
      <path d="M12 9V15M9 12H15" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

// Exported for re-use on the homepage (large-scale render) without a new file.
export { OpenXMark };
