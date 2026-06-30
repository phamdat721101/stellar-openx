'use client';

/**
 * useStellarWallet — single source of truth for wallet state in the UI.
 *
 * Returns the connected G… address, current USDC balance (read from the SAC
 * via Soroban RPC), a `connect()` action that opens the Wallets Kit modal,
 * and a `signTransaction()` helper for submitting paywall/privacy-pool tx.
 */

import { useCallback, useEffect, useState } from 'react';
import { Contract, rpc, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { STELLAR_USDC_SAC, stroopsToUsdc } from '@openx/sdk';
import { getKit, STELLAR_RPC } from '@/lib/stellar';

const STORAGE_KEY = 'openx-s.wallet-address';

export interface StellarWalletState {
  address: string | null;
  usdcBalance: string; // display string, e.g. "12.5"
  network: 'testnet' | 'mainnet';
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  refresh: () => Promise<void>;
}

export function useStellarWallet(): StellarWalletState {
  const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
  const [address, setAddress] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState('0');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached) setAddress(cached);
  }, []);

  const refresh = useCallback(async () => {
    if (!address) {
      setUsdcBalance('0');
      return;
    }
    try {
      const sorobanRpc = new rpc.Server(STELLAR_RPC, {
        allowHttp: STELLAR_RPC.startsWith('http://'),
      });
      const sac = new Contract(STELLAR_USDC_SAC[network]);
      const account = await sorobanRpc.getAccount(address);
      const { TransactionBuilder, Networks, TimeoutInfinite } = await import('@stellar/stellar-sdk');
      const tx = new TransactionBuilder(account, {
        fee: '1000000',
        networkPassphrase: network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
      })
        .addOperation(sac.call('balance', nativeToScVal(address, { type: 'address' })))
        .setTimeout(TimeoutInfinite)
        .build();
      const sim = await sorobanRpc.simulateTransaction(tx);
      if ('result' in sim && sim.result?.retval) {
        const bal = scValToNative(sim.result.retval) as bigint | number;
        setUsdcBalance(stroopsToUsdc(BigInt(bal)));
      }
    } catch {
      // Wallet might not have a Stellar account yet (unfunded). Keep balance at 0.
    }
  }, [address, network]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const kit = getKit();
      await kit.openModal({
        onWalletSelected: async (option) => {
          kit.setWallet(option.id);
          const { address: addr } = await kit.getAddress();
          window.localStorage.setItem(STORAGE_KEY, addr);
          setAddress(addr);
        },
      });
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setAddress(null);
    setUsdcBalance('0');
  }, []);

  const signTransaction = useCallback(
    async (xdr: string) => {
      if (!address) throw new Error('wallet not connected');
      const kit = getKit();
      const { signedTxXdr } = await kit.signTransaction(xdr, {
        address,
        networkPassphrase: network === 'mainnet' ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015',
      });
      return signedTxXdr;
    },
    [address, network],
  );

  return { address, usdcBalance, network, connecting, connect, disconnect, signTransaction, refresh };
}
