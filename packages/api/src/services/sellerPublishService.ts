/**
 * sellerPublishService — single entry point for `/v3/marketplace/seller/publish`.
 *
 * v3.1 flow (chain-first, atomic):
 *   0. Pre-check slug uniqueness in Supabase (cheap, avoids burning chain
 *      fees on a duplicate).
 *   1. Register on Soroban `agent-registry` — failures throw and the
 *      Supabase row is never written. This kills the v3.0 "demo short
 *      circuit" path that let `soroban_agent_id=null` leak through and
 *      reach buyers as free demo calls.
 *   2. Insert into `agents` with `soroban_agent_id` + `stellar_tx_hash`
 *      already populated, so the buyer paywall gate sees an on-chain
 *      agent from the first request.
 *
 * SOLID:
 *  - SRP: only "publish a new agent" lives here.
 *  - DIP: chain side is an injected concern, but it is now the
 *    authoritative gate — Supabase is a typed mirror of the chain state.
 */

import crypto from 'node:crypto';
import { Address, Contract, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
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
    // 0. Idempotent chain-repair: if a row with this slug already exists
    //    but never got its on-chain id (legacy "best-effort" failure mode),
    //    treat this call as "finish the chain step", not a duplicate.
    //    Same-owner check prevents slug hijacking.
    const existing = await pool.query(
      `SELECT id, owner_address, soroban_agent_id FROM agents WHERE slug = $1 LIMIT 1`,
      [input.slug],
    );
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as { id: string; owner_address: string; soroban_agent_id: string | null };
      if (row.owner_address !== input.seller || row.soroban_agent_id) {
        throw new Error(`duplicate slug: ${input.slug}`);
      }
      const chain = await this.registerOnChain(input);
      await pool.query(
        `UPDATE agents SET soroban_agent_id = $1, stellar_tx_hash = $2, published = true WHERE id = $3`,
        [chain.soroban_agent_id, chain.tx_hash, row.id],
      );
      logger.info(
        { agentId: row.id, sorobanAgentId: chain.soroban_agent_id, stellarTxHash: chain.tx_hash, slug: input.slug },
        'seller:repaired',
      );
      return {
        agent_id: row.id,
        soroban_agent_id: chain.soroban_agent_id,
        stellar_tx_hash: chain.tx_hash,
        slug: input.slug,
      };
    }

    // 1. Chain registration is the gate — if Soroban fails, nothing else
    //    happens (no Supabase row, no demo bypass, no silent fallback).
    const chain = await this.registerOnChain(input);

    // 2. Mirror the on-chain state into Supabase. ON CONFLICT defends
    //    against a slug race between step 0 and now. On collision we throw
    //    and leave a reconcilable orphan on chain (rare; queryable via
    //    /seller/agent/:id/onchain-status).
    const r = await pool.query(
      `INSERT INTO agents (slug, owner_address, persona, pricing, soroban_agent_id, stellar_tx_hash, published, archived_at, created_at, kind, privacy_mode)
       VALUES ($1, $2, $3, $4, $5, $6, true, NULL, NOW(), 'public', 'off')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [
        input.slug,
        input.seller,
        JSON.stringify(input.persona),
        JSON.stringify({ x402: input.price_usdc }),
        chain.soroban_agent_id,
        chain.tx_hash,
      ],
    );
    if ((r.rowCount ?? 0) === 0) throw new Error(`duplicate slug: ${input.slug}`);
    const agentId = r.rows[0].id as string;

    logger.info(
      { agentId, sorobanAgentId: chain.soroban_agent_id, stellarTxHash: chain.tx_hash, slug: input.slug },
      'seller:published',
    );
    return {
      agent_id: agentId,
      soroban_agent_id: chain.soroban_agent_id,
      stellar_tx_hash: chain.tx_hash,
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

    // Decode the *real* on-chain agent_id (BytesN<32>) from the contract's
    // return value. Pre-v3.1 this was a sha256(seller, slug) fiction that
    // never matched any registry row — `paywall-router.hire_agent` then
    // panicked at `registry.get_agent(fake_id)`. Reading `returnValue`
    // makes the off-chain mirror authoritative against the chain.
    if (!result.returnValue) {
      throw new Error('agent-registry register_agent returned no value');
    }
    const decoded = scValToNative(result.returnValue);
    const agentIdBytes =
      decoded instanceof Uint8Array ? decoded : decoded && (decoded as { data?: Uint8Array }).data;
    if (!agentIdBytes || agentIdBytes.length !== 32) {
      throw new Error('agent-registry returned invalid agent_id');
    }
    return {
      soroban_agent_id: Buffer.from(agentIdBytes).toString('hex'),
      tx_hash: result.hash,
    };
  }
}

export const sellerPublishService = new SellerPublishService();
