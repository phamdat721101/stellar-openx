/**
 * payRouter — Stellar x402 buyer-side helper.
 *
 * Replaces the EVM multi-rail router with a single Stellar rail that dispatches
 * by `PaymentMode`. The router does not sign — it composes Stellar Transaction
 * objects that the wallet (Freighter / LOBSTR / etc.) signs.
 *
 * SOLID:
 *   - SRP: only payment-flow orchestration. Wallet signing + RPC submission
 *     are abstracted behind the WalletSigner + StellarRpc interfaces.
 *   - DIP: callers inject their wallet signer + rpc; tests inject fakes.
 */

import {
  Contract,
  Networks,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import type {
  PaymentMode,
  StellarPaymentChallenge,
  StellarPaymentReceipt,
} from './paymentTypes';

const NETWORK_PASSPHRASE: Record<string, string> = {
  'stellar:testnet': Networks.TESTNET,
  'stellar:mainnet': Networks.PUBLIC,
};

export interface WalletSigner {
  /** Returns G…/C… address of the connected account. */
  getAddress(): Promise<string>;
  /** Signs a tx XDR; returns signed XDR. */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}

export interface StellarRpc {
  /** Builds a tx envelope from a Contract.call() invocation + signs + submits. */
  invoke(args: {
    contract: Contract;
    method: string;
    args: unknown[];
    signer: WalletSigner;
    networkPassphrase: string;
  }): Promise<{ tx_hash: string; ledger?: number }>;
}

export interface PaidEndpointResult {
  /** Settled receipt; ready to attach to `X-PAYMENT` for the retry. */
  receipt: StellarPaymentReceipt;
}

export interface PayOptions {
  signer: WalletSigner;
  rpc: StellarRpc;
}

/**
 * Single entry — given a Stellar payment challenge, dispatch to either
 * the paywall-router (public) or privacy-pool (private) flow.
 */
export async function payChallenge(
  challenge: StellarPaymentChallenge,
  opts: PayOptions,
): Promise<PaidEndpointResult> {
  const passphrase = NETWORK_PASSPHRASE[challenge.network];
  if (!passphrase) {
    throw new Error(`payRouter: unsupported network ${challenge.network}`);
  }
  if (Date.now() > challenge.expires_at) {
    throw new Error('payRouter: challenge expired');
  }

  const buyer = await opts.signer.getAddress();
  const contract = new Contract(challenge.contract_id);

  if (challenge.payment_mode === 'public') {
    const result = await opts.rpc.invoke({
      contract,
      method: 'hire_agent',
      args: [
        buyer,
        Buffer.from(challenge.agent_id, 'hex'),
        Buffer.from(challenge.nonce, 'hex'),
        { tag: 'Public', values: [] },
      ],
      signer: opts.signer,
      networkPassphrase: passphrase,
    });
    return {
      receipt: {
        tx_hash: result.tx_hash,
        payment_mode: 'public',
        ledger: result.ledger,
        amount_stroops: challenge.amount_stroops,
      },
    };
  }

  // Private: invoke privacy_pool.private_transfer. The buyer must have a
  // pre-existing deposit + zk proof in the wallet's signer (off-chain wallet
  // plumbing — the SDK does not generate proofs).
  throw new Error(
    'payRouter: private mode requires PrivacyPoolTransfer prepared off-chain (see services/stellar/privacyPool.ts on the API side)',
  );
}

/** Lightweight check used by the frontend toggle before calling payChallenge. */
export function isPrivate(mode: PaymentMode): mode is 'private' {
  return mode === 'private';
}
