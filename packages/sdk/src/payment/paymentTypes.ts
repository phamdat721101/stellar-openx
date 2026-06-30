/**
 * Stellar payment types — shared between API, frontend, and smokes.
 *
 * One rail (x402-on-Stellar), two modes:
 *   - 'public'  → paywall-router contract; amount + counterparty on-ledger.
 *   - 'private' → privacy-pool contract; amount + counterparty hidden.
 *
 * The challenge envelope is JSON inside the 402 body (not WWW-Authenticate),
 * because Stellar tx signing wants structured fields, not opaque tokens.
 */

export type PaymentMode = 'public' | 'private';

export interface StellarPaymentChallenge {
  /** `stellar:testnet` or `stellar:mainnet` */
  network: `stellar:${string}`;
  /** `USDC` — only asset supported in v3.0.0 */
  asset: 'USDC';
  /** stroops (7-decimal) as decimal string for safety on the wire */
  amount_stroops: string;
  /** paywall-router or privacy-pool contract id (G…/C…) */
  contract_id: string;
  /** agent id (32-byte hex) */
  agent_id: string;
  /** server-side nonce for idempotent replay protection */
  nonce: string;
  /** unix ms */
  expires_at: number;
  /** echoed back for client convenience */
  payment_mode: PaymentMode;
  /** human-readable USDC amount, e.g. "1.50" */
  display_amount_usdc: string;
}

export interface StellarPaymentReceipt {
  /** Stellar tx hash (64-char hex) — proof of settlement */
  tx_hash: string;
  /** echoed mode the gate used to dispatch */
  payment_mode: PaymentMode;
  /** ledger sequence when the tx landed */
  ledger?: number;
  /** stroops paid (matches challenge.amount_stroops) */
  amount_stroops: string;
}
