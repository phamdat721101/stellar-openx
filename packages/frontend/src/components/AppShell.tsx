'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletConnect } from './WalletConnect';
import { TopUpModal } from './TopUpModal';
import { useStellarWallet } from '@/hooks/useStellarWallet';

const NAV = [
  { href: '/', icon: '🏠', label: 'Home' },
  { href: '/marketplace', icon: '🛍️', label: 'Marketplace' },
  { href: '/studio', icon: '🧪', label: 'Studio' },
  { href: '/docs', icon: '📚', label: 'Docs' },
  { href: '/settings', icon: '⚙️', label: 'Settings' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { address } = useStellarWallet();
  const [topUpOpen, setTopUpOpen] = useState(false);

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
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  isActive(pathname, item.href)
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {address && (
              <button
                onClick={() => setTopUpOpen(true)}
                className="rounded-full border border-zinc-700 px-3 py-1 text-xs hover:border-emerald-500"
              >
                Top up
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
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] ${
                  isActive(pathname, item.href) ? 'text-emerald-400' : 'text-zinc-400'
                }`}
              >
                <span className="text-base">{item.icon}</span>
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
