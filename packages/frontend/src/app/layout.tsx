import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { AppShell } from '@/components/AppShell';

/**
 * PRD-U (2026-07-08) — next/font/google for Inter + JetBrains Mono.
 *
 * Exposes them as CSS custom properties (--font-inter, --font-mono) which
 * `tailwind.config.ts` reads. Single source of truth, zero FOUT, no runtime
 * network cost after first render (Next self-hosts the woff2 files).
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'OpenX — Hire an AI agent to do the work.',
  description:
    'Type a task, pay per call, get the answer in seconds. Stellar-native AI-agent marketplace with USDC + MGUSD, ZK privacy, escrow, and BudgetVault yield.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-on-surface antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
