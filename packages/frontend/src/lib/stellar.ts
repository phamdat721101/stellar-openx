'use client';

/**
 * Stellar Wallets Kit singleton — Freighter / LOBSTR / Albedo / xBull / Rabet.
 *
 * Initialised lazily inside `getKit()` so SSR-side bundles never touch the
 * `window` references inside the kit. Returns the same instance on every call.
 */

import {
  allowAllModules,
  FREIGHTER_ID,
  StellarWalletsKit,
  WalletNetwork,
} from '@creit.tech/stellar-wallets-kit';

const NETWORK =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet') === 'mainnet'
    ? WalletNetwork.PUBLIC
    : WalletNetwork.TESTNET;

let kit: StellarWalletsKit | null = null;

export function getKit(): StellarWalletsKit {
  if (typeof window === 'undefined') {
    throw new Error('stellar wallets kit must be initialised in the browser');
  }
  if (kit) return kit;
  kit = new StellarWalletsKit({
    network: NETWORK,
    selectedWalletId: FREIGHTER_ID,
    modules: allowAllModules(),
  });
  return kit;
}

export const STELLAR_NETWORK = NETWORK;
export const STELLAR_RPC =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * stellarExplorerTxUrl — canonical block-explorer link for a Stellar tx.
 *
 * Returns `null` for pseudo-hashes that don't correspond to on-chain
 * transactions (e.g. off-chain credit debits prefixed `credit-…`). Callers
 * use the null return to decide whether to render a clickable link.
 *
 * SOLID (SRP): one job — map (tx_hash, network) → explorer URL. No fetch,
 * no side effects; safe to call in render.
 */
export function stellarExplorerTxUrl(
  txHash: string | null | undefined,
  network: 'testnet' | 'mainnet' = NETWORK === WalletNetwork.PUBLIC ? 'mainnet' : 'testnet',
): string | null {
  if (!txHash || txHash.startsWith('credit-')) return null;
  const hex = txHash.startsWith('0x') ? txHash.slice(2) : txHash;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const segment = network === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${segment}/tx/${hex.toLowerCase()}`;
}

/**
 * fmtUsdcAmount — display a raw ledger amount as USDC.
 *
 * The DB grew a mix of two conventions over v3.x — some rows store USDC as
 * a decimal string ("1.50"), others were mistakenly stored as stroops
 * ("22500000.000000"). Chain view (Stellar Expert) always reads stroops as
 * 7-decimal USDC, so we normalise here to keep the numbers consistent.
 *
 * Heuristic: values ≥ 1000 with 6+ trailing zeros in the fractional part
 * are stroops-shaped and get divided by 1e7. Everything else is treated as
 * already-USDC. Safe for hackathon volumes (< $1000 per call).
 */
export function fmtUsdcAmount(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '0.00';
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return '0.00';
  const looksLikeStroops = n >= 1000 && Math.abs(n - Math.round(n)) < 1e-6;
  const usdc = looksLikeStroops ? n / 1e7 : n;
  return usdc.toFixed(2);
}
