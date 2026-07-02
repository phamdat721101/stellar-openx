/**
 * trustlessWork/client.ts — thin typed wrapper around the Trustless Work REST API.
 *
 * Design goals (SOLID):
 *   • SRP — this module owns HTTP transport + auth header + 429 backoff + JSON
 *     codec. It knows nothing about escrow business logic.
 *   • DIP — `EscrowService` depends on this interface, not fetch directly.
 *
 * Trustless Work API quirks captured here so the rest of the codebase can't
 * make these mistakes (see SKILL.md gotchas):
 *   • auth header is `x-api-key` (NOT `Authorization: Bearer …`)
 *   • rate limit: 50 req / 60 s → retry on 429 with exponential backoff
 *   • write endpoints return `{ unsignedTransaction: string, ... }` OR
 *     `{ xdr: string, ... }` depending on version — normalize to a single
 *     `.xdr` field for callers.
 *   • testnet: https://dev.api.trustlesswork.com
 *   • mainnet: https://api.trustlesswork.com
 */

import { logger } from '../../lib';

const TW_BASE_URL = process.env.TW_BASE_URL ?? 'https://dev.api.trustlesswork.com';
const TW_API_KEY = process.env.TW_API_KEY ?? '';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 400;

export interface TWXdrResponse {
  /** Unsigned Soroban XDR for the wallet to sign. */
  xdr: string;
  /** Escrow contract address — only present on deploy. */
  contractId?: string;
  /** Anything else TW returns; we keep it for logging/debugging. */
  [k: string]: unknown;
}

export interface TWSendResponse {
  status: 'SUCCESS' | 'FAILED';
  txHash?: string;
  hash?: string;              // some endpoints return .hash, some .txHash
  returnValue?: unknown;
  [k: string]: unknown;
}

export class TrustlessWorkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'TrustlessWorkError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function requestJson<T>(path: string, body: unknown): Promise<T> {
  if (!TW_API_KEY) throw new Error('trustlessWork: TW_API_KEY not configured');
  const url = `${TW_BASE_URL}${path}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': TW_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Rate limit — exponential backoff.
    if (res.status === 429 && attempt < MAX_RETRIES - 1) {
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn({ path, attempt, wait }, 'trustlessWork:429 retry');
      await sleep(wait);
      continue;
    }

    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep as text */ }

    if (!res.ok) {
      logger.warn({ path, status: res.status, body: parsed }, 'trustlessWork:error');
      throw new TrustlessWorkError(
        `trustlessWork ${res.status} on ${path}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }
  throw new Error(`trustlessWork: exhausted retries on ${path}`);
}

/** Normalize TW's `unsignedTransaction | xdr` field to `.xdr`. */
function pickXdr(raw: Record<string, unknown>): TWXdrResponse {
  const xdr = (raw.xdr ?? raw.unsignedTransaction ?? raw.unsignedTx) as string | undefined;
  if (!xdr || typeof xdr !== 'string') {
    throw new Error('trustlessWork: response missing xdr field');
  }
  return { ...raw, xdr };
}

// ── Deployer ────────────────────────────────────────────────────────────────

export interface DeploySingleReleaseInput {
  engagementId: string;
  title: string;
  description: string;
  amount: number;              // number on deploy (gotcha)
  platformFee: number;         // basis points, e.g. 500 for 5%
  roles: {
    approver: string;
    serviceProvider: string;
    platformAddress: string;
    releaseSigner: string;
    disputeResolver: string;
    receiver: string;
  };
  trustline: {
    address: string;           // issuer G-address (NOT the C-contract address)
    symbol: string;            // e.g. "USDC"
  };
  milestones: Array<{ description: string }>;   // no status/approvedFlag on deploy (gotcha)
  signer: string;              // buyer address — needed by TW to build the tx
}

export async function deploySingleRelease(input: DeploySingleReleaseInput): Promise<TWXdrResponse> {
  const raw = await requestJson<Record<string, unknown>>(
    '/deployer/single-release',
    input,
  );
  return pickXdr(raw);
}

// ── Escrow write endpoints (single-release) ─────────────────────────────────

export interface FundInput {
  contractId: string;
  amount: number;              // number (schema truth; SKILL.md docs said string but TW rejects strings)
  signer: string;
}
export const fundEscrow = (i: FundInput) =>
  requestJson<Record<string, unknown>>('/escrow/single-release/fund-escrow', i).then(pickXdr);

export interface ApproveInput {
  contractId: string;
  milestoneIndex: string;      // "0" — always string (gotcha)
  approver: string;
  // NOTE: no `newFlag` — TW's schema rejects it explicitly.
}
export const approveMilestone = (i: ApproveInput) =>
  requestJson<Record<string, unknown>>('/escrow/single-release/approve-milestone', i).then(pickXdr);

export interface ReleaseInput {
  contractId: string;
  releaseSigner: string;
}
export const releaseFunds = (i: ReleaseInput) =>
  requestJson<Record<string, unknown>>('/escrow/single-release/release-funds', i).then(pickXdr);

export interface DisputeInput {
  contractId: string;
  signer: string;              // either party can raise
}
export const disputeEscrow = (i: DisputeInput) =>
  requestJson<Record<string, unknown>>('/escrow/single-release/dispute-escrow', i).then(pickXdr);

export interface ResolveDistribution {
  /** Stellar G-address receiving this slice of the distribution. */
  address: string;
  /** USDC amount (number) — must be zero or positive; array must sum to post-fee balance. */
  amount: number;
}
export interface ResolveInput {
  contractId: string;
  disputeResolver: string;
  distributions: ResolveDistribution[];
}
export const resolveDispute = (i: ResolveInput) =>
  requestJson<Record<string, unknown>>('/escrow/single-release/resolve-dispute', i).then(pickXdr);

// ── Helpers ─────────────────────────────────────────────────────────────────

export const sendTransaction = (signedXdr: string) =>
  requestJson<TWSendResponse>('/helper/send-transaction', { signedXdr });

export interface GetEscrowsByRoleInput {
  role: 'approver' | 'serviceProvider' | 'releaseSigner' | 'disputeResolver' | 'receiver';
  roleAddress: string;
  type?: 'single-release' | 'multi-release';
  isActive?: boolean;
  validateOnChain?: boolean;
}
export const getEscrowsByRole = (i: GetEscrowsByRoleInput) =>
  requestJson<{ escrows: Array<Record<string, unknown>> }>('/helper/get-escrows-by-role', i);

// ── Health / probe ──────────────────────────────────────────────────────────

/** Cheap round-trip: TW rejects malformed input fast so we get a 400 back if reachable. */
export async function ping(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await requestJson('/helper/get-multiple-escrow-balance', { escrows: [] });
    return { ok: true };
  } catch (err) {
    if (err instanceof TrustlessWorkError && err.status >= 400 && err.status < 500) {
      // 4xx means TW responded — auth + connectivity are fine.
      return { ok: true, reason: `status=${err.status}` };
    }
    return { ok: false, reason: (err as Error).message };
  }
}

export const TW_CONFIG = Object.freeze({
  BASE_URL: TW_BASE_URL,
  API_KEY_SET: Boolean(TW_API_KEY),
});
