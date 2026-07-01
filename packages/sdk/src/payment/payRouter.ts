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

/**
 * PrivateXdrBuilder — DIP seam for the `'private'` payment mode.
 *
 * The SDK never touches HTTP, never generates ZK proofs, never holds keys.
 * It hands a `StellarPaymentChallenge` to the caller-injected builder, which
 * is responsible for returning a wallet-ready XDR (either the platform-relay
 * 2-op tx in v3.0.0 or a real `privacy-pool.private_transfer` envelope in
 * v3.1+). The SDK then walks the standard sign → submit pipeline.
 *
 * Frontends typically inject a `fetch`-backed implementation that calls
 * `/v3/marketplace/seller/agent/:id/build-hire-xdr` and `/v3/marketplace/submit`
 * on the OpenX API. Tests can inject an in-memory stub.
 */
export interface PrivateXdrBuilder {
  /** Returns a pre-prepared, optionally pre-signed XDR for the buyer to co-sign. */
  buildHireXdr(challenge: StellarPaymentChallenge, buyer: string): Promise<string>;
  /** Broadcasts the buyer-signed XDR and returns the Stellar tx hash + ledger. */
  submit(signedXdr: string): Promise<{ tx_hash: string; ledger?: number }>;
}

export interface PaidEndpointResult {
  /** Settled receipt; ready to attach to `X-PAYMENT` for the retry. */
  receipt: StellarPaymentReceipt;
}

export interface PayOptions {
  signer: WalletSigner;
  rpc: StellarRpc;
  /** Required when `challenge.payment_mode === 'private'`. */
  privateBuilder?: PrivateXdrBuilder;
}

/**
 * Single entry — given a Stellar payment challenge, dispatch to either
 * the paywall-router (public) or privacy-pool envelope (private) flow.
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

  if (challenge.payment_mode === 'public') {
    const contract = new Contract(challenge.contract_id);
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

  // Private — delegate XDR construction to the caller's builder so the SDK
  // stays free of HTTP and ZK proof gen. Builder is responsible for picking
  // the platform-relay path (v3.0) or the real `privacy-pool.private_transfer`
  // path (v3.1+) based on whether the buyer has a shielded deposit + proof.
  if (!opts.privateBuilder) {
    throw new Error(
      'payRouter: private mode requires opts.privateBuilder — inject an XDR delegate that hits your platform-relay or privacy-pool endpoint',
    );
  }
  const xdr = await opts.privateBuilder.buildHireXdr(challenge, buyer);
  const signedXdr = await opts.signer.signTransaction(xdr, passphrase);
  const submitted = await opts.privateBuilder.submit(signedXdr);
  return {
    receipt: {
      tx_hash: submitted.tx_hash,
      payment_mode: 'private',
      ledger: submitted.ledger,
      amount_stroops: challenge.amount_stroops,
    },
  };
}

/** Lightweight check used by the frontend toggle before calling payChallenge. */
export function isPrivate(mode: PaymentMode): mode is 'private' {
  return mode === 'private';
}
