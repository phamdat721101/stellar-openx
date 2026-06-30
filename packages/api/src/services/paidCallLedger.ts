/**
 * paidCallLedger — single insertion point for /api/v1 settlement records.
 *
 * Chain-agnostic on purpose: `network` is just a label (`stellar:testnet`,
 * `stellar:mainnet`, …) and `method` is the rail-side dispatcher tag. The
 * Stellar gate writes `stellar_x402` / `privacy_pool` / `credit` / `free`.
 *
 * SOLID:
 *   - SRP: this module owns writes to `paid_calls` and nothing else.
 *   - DIP: every payment path (stellar gate + credit short-circuit + freemium)
 *     funnels through `record()`. Idempotent on (network, tx_hash).
 */

import { randomUUID } from 'node:crypto';
import { pool } from '../db';
import { logger } from '../lib';
import { notifyService } from './notifyService';

/** Per (wallet × agent) freemium quota. 0 disables freemium entirely. */
export const FREE_PREVIEW_LIMIT = Number(process.env.FREE_PREVIEW_LIMIT ?? 5);

export type PaidCallMethod =
  | 'stellar_x402'
  | 'privacy_pool'
  | 'credit'
  | 'free'
  | 'demo';

export interface PaidCallRecord {
  agentId: string;
  slug: string;
  buyer: string;
  amountUsdc: string;
  txHash: string;
  network: string;
  method: PaidCallMethod;
  sellerId?: number | null;
}

export async function record(call: PaidCallRecord): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO paid_calls (agent_id, slug, buyer, amount_usdc, tx_hash, network, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (network, tx_hash) DO NOTHING
     RETURNING id`,
    [call.agentId, call.slug, call.buyer.toLowerCase(), call.amountUsdc, call.txHash, call.network, call.method],
  );
  const fresh = (r.rowCount ?? 0) > 0;
  if (fresh) {
    logger.info({ slug: call.slug, txHash: call.txHash, method: call.method }, 'paidCall:recorded');
    await notifyService.notify(
      call.agentId,
      'paid_call.completed',
      {
        paid_call_id: r.rows[0]?.id,
        slug: call.slug,
        buyer: call.buyer.toLowerCase(),
        amount_usdc: call.amountUsdc,
        tx_hash: call.txHash,
        network: call.network,
        method: call.method,
      },
      `paid_call:${call.network}:${call.txHash}`,
    );
  } else {
    logger.debug({ txHash: call.txHash }, 'paidCall:duplicate');
  }
  return fresh;
}

export async function countToday(slug: string): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM paid_calls
      WHERE slug = $1 AND created_at >= NOW() - INTERVAL '1 day'`,
    [slug],
  );
  return r.rows[0]?.c ?? 0;
}

const NETWORK = process.env.STELLAR_NETWORK
  ? `stellar:${process.env.STELLAR_NETWORK}`
  : 'stellar:testnet';

export async function checkFreePreview(buyer: string, agentId: string): Promise<number> {
  if (FREE_PREVIEW_LIMIT === 0) return 0;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS used FROM paid_calls
      WHERE buyer = $1 AND agent_id = $2 AND method = 'free'`,
    [buyer.toLowerCase(), agentId],
  );
  return Math.max(0, FREE_PREVIEW_LIMIT - (r.rows[0]?.used ?? 0));
}

export async function recordFree(buyer: string, agentId: string, slug: string): Promise<void> {
  await record({
    agentId,
    slug,
    buyer,
    amountUsdc: '0',
    txHash: `free-${randomUUID()}`,
    network: NETWORK,
    method: 'free',
  });
}
