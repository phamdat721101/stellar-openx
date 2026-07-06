/**
 * x402/v2Header.ts — x402 v2 spec header builder / parser for Stellar SEP-41.
 *
 * Wire format (per x402.org v2 + Stellar Facilitator spec):
 *   X-PAYMENT-REQUIRED: v=2; scheme=stellar-sep41; chain=stellar-testnet;
 *                       asset=CCWJ…7HM; asset-code=TMGUSD; amount=1000000;
 *                       precision=7; payTo=GABC…; memo=agent:slug;
 *                       expires=1780000000; request-id=abc; nonce=<token>
 *
 * Zero external dependencies. Pure functions — safe to call in hot paths.
 *
 * SOLID:
 *   • SRP — just format/parse the header. Semantic validation
 *     (asset enabled, amount ≥ min, memo binds to slug) is the payment
 *     gate's job.
 */

export interface V2RequiredHeader {
  scheme: 'stellar-sep41';
  chain: string;               // `stellar-testnet` | `stellar-mainnet`
  asset: string;               // SAC contract id (C…)
  assetCode: string;           // 'USDC' | 'MGUSD' | 'TMGUSD'
  amount: string;              // stroops as decimal string
  precision: number;           // typically 7
  payTo: string;               // platform G-address
  memo?: string;               // `agent:<slug>` or vault-specific tag
  expires: number;             // unix seconds
  requestId: string;           // client-side idempotency key
  nonce?: string;              // HMAC nonce from the challenge (echoed in reply)
  facilitator?: string;        // optional URL of an external facilitator
}

export interface V2PaymentHeader {
  scheme: 'stellar-sep41';
  txHash?: string;             // 64-hex Stellar tx hash (when settled directly)
  authXdr?: string;            // base64 signed auth-entry envelope (when facilitator settles)
  requestId?: string;
  nonce?: string;
  buyer?: string;              // G-address of the payer
}

/** Encode a value into `k=v;` — escapes semicolons + equals defensively. */
function esc(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  return String(v).replace(/;/g, '%3B').replace(/=/g, '%3D');
}

export function buildV2RequiredHeader(h: V2RequiredHeader): string {
  const parts = [
    'v=2',
    `scheme=${esc(h.scheme)}`,
    `chain=${esc(h.chain)}`,
    `asset=${esc(h.asset)}`,
    `asset-code=${esc(h.assetCode)}`,
    `amount=${esc(h.amount)}`,
    `precision=${esc(h.precision)}`,
    `payTo=${esc(h.payTo)}`,
    h.memo ? `memo=${esc(h.memo)}` : '',
    `expires=${esc(h.expires)}`,
    `request-id=${esc(h.requestId)}`,
    h.nonce ? `nonce=${esc(h.nonce)}` : '',
    h.facilitator ? `facilitator=${esc(h.facilitator)}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

export function parseV2RequiredHeader(raw: string | undefined | null): V2RequiredHeader | null {
  if (!raw) return null;
  const map = new Map<string, string>();
  for (const chunk of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    map.set(chunk.slice(0, eq).trim().toLowerCase(), decodeURIComponent(chunk.slice(eq + 1).trim()));
  }
  if (map.get('v') !== '2' || map.get('scheme') !== 'stellar-sep41') return null;
  const required = ['chain', 'asset', 'asset-code', 'amount', 'precision', 'payto', 'expires', 'request-id'];
  for (const k of required) if (!map.has(k)) return null;
  return {
    scheme: 'stellar-sep41',
    chain: map.get('chain')!,
    asset: map.get('asset')!,
    assetCode: map.get('asset-code')!,
    amount: map.get('amount')!,
    precision: Number(map.get('precision')),
    payTo: map.get('payto')!,
    memo: map.get('memo'),
    expires: Number(map.get('expires')),
    requestId: map.get('request-id')!,
    nonce: map.get('nonce'),
    facilitator: map.get('facilitator'),
  };
}

export function parseV2PaymentHeader(raw: string | undefined | null): V2PaymentHeader | null {
  if (!raw) return null;
  // Two accepted shapes:
  //   1. Legacy (v1 + v0.29): "stellar <tx_hash>" — kept for backward compat.
  //   2. v2 structured:       "v=2; scheme=stellar-sep41; tx=<hash>; nonce=..."
  const trimmed = raw.trim();
  if (trimmed.startsWith('stellar ')) {
    const parts = trimmed.split(/\s+/);
    return { scheme: 'stellar-sep41', txHash: parts[1] };
  }
  const map = new Map<string, string>();
  for (const chunk of trimmed.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    map.set(chunk.slice(0, eq).trim().toLowerCase(), decodeURIComponent(chunk.slice(eq + 1).trim()));
  }
  if (map.get('v') !== '2') return null;
  return {
    scheme: 'stellar-sep41',
    txHash: map.get('tx'),
    authXdr: map.get('auth'),
    requestId: map.get('request-id'),
    nonce: map.get('nonce'),
    buyer: map.get('buyer'),
  };
}
