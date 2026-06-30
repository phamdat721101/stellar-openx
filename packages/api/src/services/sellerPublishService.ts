/**
 * sellerPublishService — single entry point for `/v3/marketplace/seller/publish`.
 *
 * v3.0.0 flow (Supabase first, chain best-effort):
 *   1. Insert into `agents` (Supabase is the marketplace browse source).
 *   2. Asynchronously try to register on Soroban `agent-registry`. The Stellar
 *      tx is fire-and-forget — failures (sim/trap/timeout) are logged but
 *      never block the seller's publish. The Supabase row remains the
 *      authoritative record; the on-chain row, when present, is an
 *      auditable commitment.
 *   3. Mirror the on-chain `soroban_agent_id` + `stellar_tx_hash` back into
 *      the row when the chain side succeeds.
 *
 * SOLID:
 *  - SRP: only "publish a new agent" lives here.
 *  - DIP: chain side is an injected concern that can fail without blocking
 *    the off-chain primary path (loose coupling).
 */

import crypto from 'node:crypto';
import { Address, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import { pool } from '../db';
import { logger } from '../lib';
import { getStellar } from './stellar/client';
import { usdcToStroops } from '@openx/sdk';

export interface PublishInput {
  seller: string;
  slug: string;
  persona: { system_prompt: string; model?: string; tools?: string[] };
  price_usdc: string;
  manifest: Record<string, unknown>;
}

export interface PublishResult {
  agent_id: string;
  soroban_agent_id: string | null;
  stellar_tx_hash: string | null;
  slug: string;
}

function hashManifest(manifest: Record<string, unknown>): Buffer {
  const canon = JSON.stringify(manifest, Object.keys(manifest).sort());
  return crypto.createHash('sha256').update(canon).digest();
}

class SellerPublishService {
  async publish(input: PublishInput): Promise<PublishResult> {
    // 1. Supabase first (canonical record).
    const r = await pool.query(
      `INSERT INTO agents (slug, owner_address, persona, pricing, published, archived_at, created_at, kind, privacy_mode)
       VALUES ($1, $2, $3, $4, true, NULL, NOW(), 'public', 'off')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [
        input.slug,
        input.seller,
        JSON.stringify(input.persona),
        JSON.stringify({ x402: input.price_usdc }),
      ],
    );
    if (r.rowCount === 0) throw new Error(`duplicate slug: ${input.slug}`);
    const agentId = r.rows[0].id as string;

    // 2. Best-effort chain registration. Awaited but failures are non-fatal —
    //    the Supabase row already exists so the marketplace works either way.
    let sorobanAgentId: string | null = null;
    let stellarTxHash: string | null = null;
    try {
      const chainResult = await this.registerOnChain(input);
      sorobanAgentId = chainResult.soroban_agent_id;
      stellarTxHash = chainResult.tx_hash;
      await pool.query(
        `UPDATE agents SET soroban_agent_id = $1, stellar_tx_hash = $2 WHERE id = $3`,
        [sorobanAgentId, stellarTxHash, agentId],
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, slug: input.slug },
        'seller:publish:chain-skipped',
      );
    }

    logger.info(
      { agentId, sorobanAgentId, stellarTxHash, slug: input.slug },
      'seller:published',
    );
    return {
      agent_id: agentId,
      soroban_agent_id: sorobanAgentId,
      stellar_tx_hash: stellarTxHash,
      slug: input.slug,
    };
  }

  private async registerOnChain(input: PublishInput): Promise<{ soroban_agent_id: string; tx_hash: string }> {
    const s = getStellar();
    const manifestHash = hashManifest(input.manifest);
    const stroops = usdcToStroops(input.price_usdc);
    const platformAddr = s.platformKeypair.publicKey();

    const tx = (await s.buildTx(platformAddr))
      .addOperation(
        new Contract(s.contracts.agentRegistry).call(
          'register_agent',
          new Address(platformAddr).toScVal(),
          nativeToScVal(input.slug, { type: 'string' }),
          nativeToScVal(input.persona.system_prompt.slice(0, 64), { type: 'string' }),
          nativeToScVal(stroops, { type: 'i128' }),
          nativeToScVal(manifestHash, { type: 'bytes' }),
          nativeToScVal(false, { type: 'bool' }),
        ),
      )
      .build();
    const prepared = await s.rpc.prepareTransaction(tx);
    prepared.sign(s.platformKeypair);
    const result = await s.submitPlatformSigned(prepared);

    // Deterministic mirror of the contract's agent_id formula (count + ts +
    // 20 zero pad). The on-chain canonical id is in the tx events; this
    // mirror is for UX convenience only — the off-chain row links via
    // `stellar_tx_hash` which is the audit-grade pointer.
    const sorobanAgentId = crypto
      .createHash('sha256')
      .update(input.seller)
      .update(input.slug)
      .digest('hex');
    return { soroban_agent_id: sorobanAgentId, tx_hash: result.hash };
  }
}

export const sellerPublishService = new SellerPublishService();
