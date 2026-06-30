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
