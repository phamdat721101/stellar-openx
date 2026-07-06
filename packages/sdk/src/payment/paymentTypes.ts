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

export type PaymentMode = 'public' | 'private' | 'escrow';

/**
 * Wire-level info about the settlement asset. Backward-compat: prior
 * clients that never read this field keep working (they'll assume USDC
 * from the `asset` field). New clients (n-payment, x402 v2 tooling) read
 * this block for the SAC contract to pass into `hire_agent(..., asset)`.
 */
export interface AssetInfo {
  code: string;              // 'USDC' | 'MGUSD' | 'TMGUSD' …
  sac_contract: string;      // SEP-41 SAC (C…)
  precision: number;         // decimals — always 7 for USDC / MGUSD
  display_name?: string;
}

export interface StellarPaymentChallenge {
  /** `stellar:testnet` or `stellar:mainnet` */
  network: `stellar:${string}`;
  /** Kept for pre-v0.30 clients. Semantically means "the asset's short code". */
  asset: string;
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
  /** human-readable amount, e.g. "1.50" (any 7-dec asset — USDC or MGUSD) */
  display_amount_usdc: string;
  /** v0.30+ — structured asset info for multi-asset settlement (optional). */
  asset_info?: AssetInfo;
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
