/**
 * sellerPublishService — wallet-signed publish flow for `/v3/marketplace/seller/publish/*`.
 *
 * v3.3 flow (seller-signed, two-step):
 *   1. buildPublishXdr()  — server prepares an unsigned Soroban XDR that
 *      invokes `agent-registry.register_agent(seller, …)`. The **seller's
 *      wallet is the transaction source account** (pays XLM fee + signs).
 *      Idempotent: if a legacy row with the same slug exists and belongs to
 *      the same seller with soroban_agent_id=null, we treat this as a
 *      "finish on-chain" repair and reuse it.
 *   2. confirmPublish()   — server submits the signed XDR to Soroban RPC,
 *      decodes the returned `BytesN<32>` agent_id from the contract, and
 *      inserts (or updates) the Supabase mirror row with soroban_agent_id +
 *      stellar_tx_hash populated. Row is *only* created after the chain
 *      write succeeds — no more `soroban_agent_id=null` orphans.
 *
 * This retires the v3.1 gasless (platform-signed) path that let sellers
 * onboard for free. Every listing on the marketplace is now provably a
 * real Soroban register_agent tx signed by the seller's wallet.
 *
 * SOLID:
 *   • SRP — this service owns "publish an agent". Chain glue is delegated
 *     to `services/stellar/marketplace` shape (build-tx + submit-tx).
 *   • DIP — depends on the `StellarHandle` interface, not the RPC concretes.
 *   • OCP — the two-step surface trivially extends to a "publish-with-cover-
 *     image" future step without touching callers.
 */

import crypto from 'node:crypto';
import {
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';
import { pool } from '../db';
import { logger } from '../lib';
import { getStellar } from './stellar/client';
import { usdcToStroops } from '@openx/sdk';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PublishInput {
  seller: string;                                 // G… address (also tx source)
  slug: string;
  display_name?: string;                          // optional, defaults to slug
  persona: { system_prompt: string; model?: string; tools?: string[] };
  price_usdc: string;
  manifest: Record<string, unknown>;
}

export interface BuildPublishResult {
  xdr: string;                                    // unsigned Soroban XDR for wallet
  slug: string;
  existing_agent_id: string | null;               // Supabase row.id if repairing legacy
}

export interface ConfirmPublishInput extends PublishInput {
  signed_xdr: string;                             // seller-signed envelope
  existing_agent_id?: string | null;              // pass through from build step
}

export interface PublishResult {
  agent_id: string;
  soroban_agent_id: string;
  stellar_tx_hash: string;
  slug: string;
}

// ── Helpers (pure) ─────────────────────────────────────────────────────────

function hashManifest(manifest: Record<string, unknown>): Buffer {
  const canon = JSON.stringify(manifest, Object.keys(manifest).sort());
  return crypto.createHash('sha256').update(canon).digest();
}

function normalizeDisplayName(input: PublishInput): string {
  const dn = (input.display_name ?? '').trim();
  if (dn.length >= 3) return dn.slice(0, 64);
  return input.slug.slice(0, 64);
}

// ── Service ────────────────────────────────────────────────────────────────

class SellerPublishService {
  /**
   * Step 1: build the unsigned register_agent transaction. Seller is source,
   * seller is the `seller: Address` contract arg. No DB mutation happens
   * here — a slug-conflict from a *different* owner is rejected up-front so
   * the seller doesn't burn a signature on a doomed tx.
   */
  async buildPublishXdr(input: PublishInput): Promise<BuildPublishResult> {
    const existing = await pool.query(
      `SELECT id, owner_address, soroban_agent_id FROM agents WHERE slug = $1 LIMIT 1`,
      [input.slug],
    );
    let existing_agent_id: string | null = null;
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as {
        id: string;
        owner_address: string;
        soroban_agent_id: string | null;
      };
      if (row.owner_address !== input.seller || row.soroban_agent_id) {
        throw new Error(`duplicate slug: ${input.slug}`);
      }
      // Legacy row stuck at "awaiting on-chain registration" — same owner,
      // no soroban id yet. Fall through to build a fresh XDR; confirmPublish()
      // will UPDATE this row in place.
      existing_agent_id = row.id;
    }

    const s = getStellar();
    const manifestHash = hashManifest(input.manifest);
    const stroops = usdcToStroops(input.price_usdc);
    const displayName = normalizeDisplayName(input);

    const tx = (await s.buildTx(input.seller))
      .addOperation(
        new Contract(s.contracts.agentRegistry).call(
          'register_agent',
          new Address(input.seller).toScVal(),                       // seller is the real seller now
          nativeToScVal(input.slug, { type: 'string' }),
          nativeToScVal(displayName, { type: 'string' }),
          nativeToScVal(stroops, { type: 'i128' }),
          nativeToScVal(manifestHash, { type: 'bytes' }),
          nativeToScVal(false, { type: 'bool' }),
        ),
      )
      .build();

    const prepared = await s.rpc.prepareTransaction(tx);
    return { xdr: prepared.toXDR(), slug: input.slug, existing_agent_id };
  }

  /**
   * Step 2: submit the seller-signed XDR. Decodes the on-chain agent_id from
   * the contract return value and mirrors the row into Supabase. Insert is
   * atomic with the on-chain write — if RPC fails, nothing hits the DB.
   */
  async confirmPublish(input: ConfirmPublishInput): Promise<PublishResult> {
    const s = getStellar();
    const tx = TransactionBuilder.fromXDR(input.signed_xdr, s.passphrase);
    const send = await s.rpc.sendTransaction(tx as never);
    if (send.status === 'ERROR') {
      throw new Error(`stellar:send_failed:${JSON.stringify(send.errorResult ?? {})}`);
    }
    // Poll for confirmation (Soroban txs typically land in ≤ 5s).
    let attempt = 0;
    let returnValue: import('@stellar/stellar-sdk').xdr.ScVal | undefined;
    let landed = false;
    while (attempt < 30) {
      const r = await s.rpc.getTransaction(send.hash);
      if (r.status === 'SUCCESS') {
        // Inside this branch TS narrows r to GetSuccessfulTransactionResponse,
        // which is the only shape carrying `returnValue`.
        returnValue = r.returnValue;
        landed = true;
        break;
      }
      if (r.status === 'FAILED') throw new Error(`stellar:tx_failed:${send.hash}`);
      await new Promise((res) => setTimeout(res, 1_000));
      attempt += 1;
    }
    if (!landed) throw new Error(`stellar:tx_timeout:${send.hash}`);
    if (!returnValue) throw new Error('agent-registry returned no value');

    const decoded = scValToNative(returnValue) as unknown;
    const agentIdBytes: Uint8Array | undefined =
      decoded instanceof Uint8Array
        ? decoded
        : (decoded as { data?: Uint8Array } | null | undefined)?.data;
    if (!agentIdBytes || agentIdBytes.length !== 32) {
      throw new Error('agent-registry returned invalid agent_id');
    }
    const soroban_agent_id = Buffer.from(agentIdBytes).toString('hex');
    const stellar_tx_hash = send.hash;

    // Mirror to Supabase. Two shapes:
    //   (a) legacy repair — UPDATE the existing pending row in place.
    //   (b) fresh publish — INSERT a new row. ON CONFLICT guards against a
    //       slug race between build-xdr and confirm.
    if (input.existing_agent_id) {
      const upd = await pool.query(
        `UPDATE agents
            SET soroban_agent_id = $1,
                stellar_tx_hash  = $2,
                persona          = $3,
                pricing          = $4,
                published        = true,
                archived_at      = NULL
          WHERE id = $5 AND owner_address = $6
          RETURNING id`,
        [
          soroban_agent_id,
          stellar_tx_hash,
          JSON.stringify(input.persona),
          JSON.stringify({ x402: input.price_usdc }),
          input.existing_agent_id,
          input.seller,
        ],
      );
      if ((upd.rowCount ?? 0) === 0) {
        throw new Error('confirm_publish:legacy_row_not_found_or_not_owner');
      }
      logger.info(
        { agentId: input.existing_agent_id, soroban_agent_id, stellar_tx_hash, slug: input.slug },
        'seller:repaired',
      );
      return {
        agent_id: input.existing_agent_id,
        soroban_agent_id,
        stellar_tx_hash,
        slug: input.slug,
      };
    }

    const ins = await pool.query(
      `INSERT INTO agents
         (slug, owner_address, persona, pricing, soroban_agent_id, stellar_tx_hash,
          published, archived_at, created_at, kind, privacy_mode)
       VALUES ($1, $2, $3, $4, $5, $6, true, NULL, NOW(), 'public', 'off')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [
        input.slug,
        input.seller,
        JSON.stringify(input.persona),
        JSON.stringify({ x402: input.price_usdc }),
        soroban_agent_id,
        stellar_tx_hash,
      ],
    );
    if ((ins.rowCount ?? 0) === 0) throw new Error(`duplicate slug: ${input.slug}`);
    const agent_id = ins.rows[0].id as string;

    logger.info(
      { agentId: agent_id, soroban_agent_id, stellar_tx_hash, slug: input.slug },
      'seller:published',
    );
    return { agent_id, soroban_agent_id, stellar_tx_hash, slug: input.slug };
  }
}

export const sellerPublishService = new SellerPublishService();
