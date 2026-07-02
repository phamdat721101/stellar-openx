'use client';

import { useCallback } from 'react';
import { API_URL } from '@/lib/stellar';

/**
 * useEscrowActions — single source of truth for the Trustless Work escrow
 * HTTP dance (build XDR → wallet sign → submit).
 *
 * Used by both `/agent/[id]` (fresh hire flow) and `/studio` (buyer inbox
 * for pending approvals). SOLID:
 *   • SRP — this hook only orchestrates the 3 HTTP calls + 1 wallet sign.
 *   • DIP — depends on `signTransaction` interface + `address` prop, both
 *           injected by the caller. Trivially stubbable in tests.
 *   • OCP — action list is a literal type; adding a new action = one arm.
 */

export type EscrowAction = 'deploy' | 'fund' | 'approve' | 'release' | 'dispute';

export interface EscrowActionParams {
  action: EscrowAction;
  agent_id?: string;         // deploy only
  contract_address?: string; // everything except deploy
  question?: string;         // deploy only
}

export interface EscrowActionResult {
  tx_hash: string;
  contract_address: string;
  status: string;
}

export function useEscrowActions(
  address: string | null,
  signTransaction: (xdr: string) => Promise<string>,
) {
  return useCallback(
    async (params: EscrowActionParams): Promise<EscrowActionResult> => {
      if (!address) throw new Error('wallet not connected');

      // 1. Server prepares an unsigned XDR for the given action.
      const buildRes = await fetch(`${API_URL}/v3/marketplace/escrow/build-action-xdr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify(params),
      });
      if (!buildRes.ok) {
        throw new Error(`${params.action}:build ${buildRes.status}: ${await buildRes.text()}`);
      }
      const built = (await buildRes.json()) as { xdr: string; contract_address: string };

      // 2. Wallet signs the envelope (source-account auth satisfies TW's
      //    contract-level require_auth for the caller's role).
      const signed = await signTransaction(built.xdr);

      // 3. Server forwards to TW `/helper/send-transaction` and confirms.
      //    For `deploy`, the response carries the *real* on-chain contract
      //    address (build only had `pending:*` placeholder).
      const submitRes = await fetch(`${API_URL}/v3/marketplace/escrow/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stellar-address': address },
        body: JSON.stringify({
          signed_xdr: signed,
          contract_address: built.contract_address,
          action: params.action,
        }),
      });
      if (!submitRes.ok) {
        throw new Error(`${params.action}:submit ${submitRes.status}: ${await submitRes.text()}`);
      }
      const j = (await submitRes.json()) as {
        tx_hash: string;
        status: string;
        contract_address?: string;
      };
      return {
        tx_hash: j.tx_hash,
        contract_address: j.contract_address ?? built.contract_address,
        status: j.status,
      };
    },
    [address, signTransaction],
  );
}
