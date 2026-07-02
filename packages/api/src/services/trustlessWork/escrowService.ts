/**
 * trustlessWork/escrowService.ts — orchestrate the OpenX-S ↔ Trustless Work
 * single-release escrow lifecycle.
 *
 * Fully on-chain trustless roles (PRD-T, choice 3=a):
 *   • buyer  → payer, approver, releaseSigner
 *   • seller → serviceProvider, receiver
 *   • platform → platformAddress (fee), disputeResolver (arbitrator only)
 *
 * State machine (mirrored in Supabase.hire_escrows.status):
 *   deploying → funded → answered → approved → released
 *                                 ↘ disputed → resolved | refunded
 *
 * SOLID:
 *   • SRP — this service knows escrow lifecycle. TW HTTP transport lives in
 *     `client.ts`. DB mirror lives here (single write-path per status).
 *   • DIP — every method takes typed inputs and returns typed outputs; unit
 *     tests can stub `tw.*` freely.
 */

import { pool } from '../../db';
import { logger } from '../../lib';
import { getStellar } from '../stellar/client';
import * as tw from './client';

const PLATFORM_FEE_BPS = Number(process.env.ESCROW_PLATFORM_FEE_BPS ?? 500);
const TIMEOUT_HOURS = Number(process.env.ESCROW_TIMEOUT_HOURS ?? 24);
const ESCROW_TIER_MULTIPLIER = Number(process.env.ESCROW_TIER_MULTIPLIER ?? 2.0);

// USDC issuer per network (mirrors TW gotcha — always the G-issuer, never a
// C-contract address). Circle-issued USDC on Stellar:
//   testnet:  GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
//   mainnet:  GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
const USDC_ISSUERS: Record<'testnet' | 'mainnet', string> = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};
function usdcIssuerAddress(): string {
  const explicit = process.env.STELLAR_USDC_ISSUER;
  if (explicit) return explicit;
  const network = (process.env.STELLAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
  return USDC_ISSUERS[network] ?? USDC_ISSUERS.testnet;
}

export interface HireEscrowRow {
  id: string;
  contract_address: string;
  agent_id: string;
  slug: string;
  buyer_address: string;
  seller_address: string;
  question: string | null;
  answer: string | null;
  amount_usdc: string;
  platform_fee_bps: number;
  status:
    | 'deploying' | 'funded' | 'answered'
    | 'approved' | 'released'
    | 'disputed' | 'resolved' | 'refunded';
  deploy_tx_hash: string | null;
  fund_tx_hash: string | null;
  approve_tx_hash: string | null;
  release_tx_hash: string | null;
  dispute_tx_hash: string | null;
  resolve_tx_hash: string | null;
  timeout_at: string | null;
  answered_at: string | null;
  released_at: string | null;
  created_at: string;
}

export interface BuildActionOutput {
  xdr: string;
  contract_address: string;
  action: EscrowAction;
  escrow_id: string;
}

export type EscrowAction = 'deploy' | 'fund' | 'approve' | 'release' | 'dispute';

// ── Helpers ────────────────────────────────────────────────────────────────

function computeEscrowAmountUsdc(basePriceUsdc: string): string {
  const n = Number(basePriceUsdc) * ESCROW_TIER_MULTIPLIER;
  return n.toFixed(7).replace(/\.?0+$/, '') || '0';
}

async function loadEscrowByContract(contractAddress: string): Promise<HireEscrowRow | null> {
  const r = await pool.query<HireEscrowRow>(
    `SELECT * FROM hire_escrows WHERE contract_address = $1 LIMIT 1`,
    [contractAddress],
  );
  return r.rows[0] ?? null;
}

async function loadAgentBrief(agentId: string): Promise<{
  id: string; slug: string; owner_address: string; pricing: { x402?: string } | null;
} | null> {
  const r = await pool.query(
    `SELECT id, slug, owner_address, pricing FROM agents WHERE id = $1 LIMIT 1`,
    [agentId],
  );
  return r.rows[0] ?? null;
}

function platformAddress(): string {
  const s = getStellar();
  return s.platformKeypair.publicKey();
}

// ── Service ────────────────────────────────────────────────────────────────

class EscrowService {
  /**
   * Step 1 — buyer initiates hire. Calls TW deploy, gets unsigned XDR +
   * contract address, INSERTs a `hire_escrows` row with status='deploying'.
   */
  async buildDeployXdr(input: {
    buyer: string;
    agent_id: string;
    question?: string;
  }): Promise<BuildActionOutput> {
    const agent = await loadAgentBrief(input.agent_id);
    if (!agent) throw new Error('agent_not_found');
    const basePrice = agent.pricing?.x402 ?? '0';
    if (Number(basePrice) <= 0) throw new Error('agent_has_no_price');
    const amount = computeEscrowAmountUsdc(basePrice);

    const engagementId = `openx-${agent.slug}-${Date.now()}`;
    const platform = platformAddress();

    const twResp = await tw.deploySingleRelease({
      engagementId,
      title: `OpenX hire · ${agent.slug}`,
      description: (input.question ?? `Hire ${agent.slug}`).slice(0, 240),
      amount: Number(amount),
      // TW expects `platformFee` as a PERCENTAGE (0..99), not basis points.
      // We store bps internally (`platform_fee_bps`) so the payout ledger is
      // basis-point precise; convert on the way out.
      platformFee: PLATFORM_FEE_BPS / 100,
      roles: {
        approver: input.buyer,
        serviceProvider: agent.owner_address,
        platformAddress: platform,
        releaseSigner: input.buyer,
        disputeResolver: platform,
        receiver: agent.owner_address,
      },
      trustline: {
        address: usdcIssuerAddress(),
        symbol: 'USDC',
      },
      milestones: [{ description: 'Deliver the AI answer for buyer question.' }],
      signer: input.buyer,
    });
    // TW's deploy endpoint returns the unsigned XDR only. The on-chain
    // contract address emerges from the Soroban tx result AFTER the buyer
    // signs & we call `/helper/send-transaction`. We track the row by the
    // engagementId placeholder (satisfies UNIQUE NOT NULL) and swap in the
    // real contract address on `confirmAction` for deploy.
    const contract_address = twResp.contractId ?? `pending:${engagementId}`;

    // Optimistic INSERT. `contract_address` is UNIQUE — a repeat deploy on
    // the same engagementId becomes a no-op.
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO hire_escrows
         (contract_address, agent_id, slug, buyer_address, seller_address,
          question, amount_usdc, platform_fee_bps, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deploying')
       ON CONFLICT (contract_address) DO NOTHING
       RETURNING id`,
      [
        contract_address,
        agent.id,
        agent.slug,
        input.buyer,
        agent.owner_address,
        input.question ?? null,
        amount,
        PLATFORM_FEE_BPS,
      ],
    );
    const existing = ins.rowCount === 0
      ? (await loadEscrowByContract(contract_address))
      : null;
    const escrow_id = existing?.id ?? ins.rows[0].id;

    logger.info({ escrow_id, contract_address, buyer: input.buyer }, 'escrow:deploy:built');
    return { xdr: twResp.xdr, contract_address, action: 'deploy', escrow_id };
  }

  async buildFundXdr(input: { buyer: string; contract_address: string }): Promise<BuildActionOutput> {
    const escrow = await loadEscrowByContract(input.contract_address);
    if (!escrow) throw new Error('escrow_not_found');
    if (escrow.buyer_address !== input.buyer) throw new Error('not_buyer');
    if (escrow.status !== 'deploying' && escrow.status !== 'funded') {
      throw new Error(`invalid_state:${escrow.status}`);
    }
    const twResp = await tw.fundEscrow({
      contractId: escrow.contract_address,
      amount: Number(escrow.amount_usdc),
      signer: escrow.buyer_address,
    });
    return { xdr: twResp.xdr, contract_address: escrow.contract_address, action: 'fund', escrow_id: escrow.id };
  }

  async buildApproveXdr(input: { buyer: string; contract_address: string }): Promise<BuildActionOutput> {
    const escrow = await loadEscrowByContract(input.contract_address);
    if (!escrow) throw new Error('escrow_not_found');
    if (escrow.buyer_address !== input.buyer) throw new Error('not_buyer');
    if (escrow.status !== 'answered') throw new Error(`invalid_state:${escrow.status}`);
    const twResp = await tw.approveMilestone({
      contractId: escrow.contract_address,
      milestoneIndex: '0',
      approver: escrow.buyer_address,
    });
    return { xdr: twResp.xdr, contract_address: escrow.contract_address, action: 'approve', escrow_id: escrow.id };
  }

  async buildReleaseXdr(input: { buyer: string; contract_address: string }): Promise<BuildActionOutput> {
    const escrow = await loadEscrowByContract(input.contract_address);
    if (!escrow) throw new Error('escrow_not_found');
    if (escrow.buyer_address !== input.buyer) throw new Error('not_buyer');
    if (escrow.status !== 'approved') throw new Error(`invalid_state:${escrow.status}`);
    const twResp = await tw.releaseFunds({
      contractId: escrow.contract_address,
      releaseSigner: escrow.buyer_address,
    });
    return { xdr: twResp.xdr, contract_address: escrow.contract_address, action: 'release', escrow_id: escrow.id };
  }

  /** Either party can raise a dispute. */
  async buildDisputeXdr(input: { signer: string; contract_address: string }): Promise<BuildActionOutput> {
    const escrow = await loadEscrowByContract(input.contract_address);
    if (!escrow) throw new Error('escrow_not_found');
    if (![escrow.buyer_address, escrow.seller_address].includes(input.signer)) {
      throw new Error('not_participant');
    }
    if (!['funded', 'answered', 'approved'].includes(escrow.status)) {
      throw new Error(`invalid_state:${escrow.status}`);
    }
    const twResp = await tw.disputeEscrow({
      contractId: escrow.contract_address,
      signer: input.signer,
    });
    return { xdr: twResp.xdr, contract_address: escrow.contract_address, action: 'dispute', escrow_id: escrow.id };
  }

  /**
   * Called AFTER a signed XDR lands on-chain via /helper/send-transaction.
   * Transitions status in one write and records the tx hash for auditability.
   *
   * On `deploy`, TW's send-transaction returns the on-chain contract address
   * (typically as `contractId` on the response). We swap it into the row
   * that was inserted with a `pending:<engagementId>` sentinel.
   */
  async confirmAction(input: {
    contract_address: string;
    action: EscrowAction;
    tx_hash: string;
    /** Populated by the route from TW's send-transaction response (deploy only). */
    real_contract_address?: string;
  }): Promise<HireEscrowRow> {
    // Special case: deploy — swap the placeholder key with the real address.
    if (input.action === 'deploy' && input.real_contract_address && input.real_contract_address !== input.contract_address) {
      const r = await pool.query<HireEscrowRow>(
        `UPDATE hire_escrows
            SET contract_address = $1,
                deploy_tx_hash   = $2
          WHERE contract_address = $3
          RETURNING *`,
        [input.real_contract_address, input.tx_hash, input.contract_address],
      );
      if ((r.rowCount ?? 0) === 0) throw new Error('escrow_not_found');
      logger.info(
        { placeholder: input.contract_address, real: input.real_contract_address, tx_hash: input.tx_hash },
        'escrow:deploy:confirmed',
      );
      return r.rows[0];
    }

    const nextStatus: Record<EscrowAction, HireEscrowRow['status']> = {
      deploy: 'deploying',            // deploy alone doesn't move past 'deploying' — funding does
      fund: 'funded',
      approve: 'approved',
      release: 'released',
      dispute: 'disputed',
    };
    const column: Record<EscrowAction, string> = {
      deploy: 'deploy_tx_hash',
      fund: 'fund_tx_hash',
      approve: 'approve_tx_hash',
      release: 'release_tx_hash',
      dispute: 'dispute_tx_hash',
    };
    const status = nextStatus[input.action];
    const ts = {
      fund: null,                          // no dedicated timestamp column
      deploy: null,
      approve: 'approved_at',
      release: 'released_at',
      dispute: 'disputed_at',
    }[input.action];
    const setTs = ts ? `, ${ts} = NOW()` : '';

    const r = await pool.query<HireEscrowRow>(
      `UPDATE hire_escrows
          SET status = $1,
              ${column[input.action]} = $2
              ${setTs}
        WHERE contract_address = $3
        RETURNING *`,
      [status, input.tx_hash, input.contract_address],
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('escrow_not_found');
    logger.info(
      { contract_address: input.contract_address, action: input.action, tx_hash: input.tx_hash, status },
      'escrow:action:confirmed',
    );
    return r.rows[0];
  }

  /**
   * Server-marks the escrow as `answered` after inference. Sets timeout_at
   * to now + ESCROW_TIMEOUT_HOURS so the seller can claim on abandonment.
   */
  async markAnswered(input: {
    contract_address: string;
    answer: string;
  }): Promise<HireEscrowRow> {
    const r = await pool.query<HireEscrowRow>(
      `UPDATE hire_escrows
          SET status = 'answered',
              answer = $1,
              answered_at = NOW(),
              timeout_at  = NOW() + ($2 || ' hours')::interval
        WHERE contract_address = $3 AND status = 'funded'
        RETURNING *`,
      [input.answer, String(TIMEOUT_HOURS), input.contract_address],
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('escrow_not_funded_or_missing');
    return r.rows[0];
  }

  /**
   * Platform-signed dispute resolution. Only callable via the admin route.
   * TW distributes the escrow across the given `distributions` list — array
   * of `{address, amount}` (USDC-decimal number). The sum must equal the
   * post-fee balance held by the escrow (mainnet also deducts a 0.3 %
   * protocol fee; on testnet the deposit == balance).
   */
  async resolveDispute(input: {
    contract_address: string;
    buyer_bps: number;                // 0..10000 — refund to buyer
    seller_bps: number;               // 0..10000 — release to seller
  }): Promise<{ xdr: string; escrow: HireEscrowRow }> {
    if (input.buyer_bps + input.seller_bps !== 10000) {
      throw new Error('bps_sum_must_be_10000');
    }
    const escrow = await loadEscrowByContract(input.contract_address);
    if (!escrow) throw new Error('escrow_not_found');
    if (escrow.status !== 'disputed') throw new Error(`invalid_state:${escrow.status}`);

    // The escrow holds `amount_usdc` gross. Split by basis points.
    const gross = Number(escrow.amount_usdc);
    const buyerAmount = Math.floor(gross * input.buyer_bps) / 10000;
    const sellerAmount = gross - buyerAmount;

    const distributions: Array<{ address: string; amount: number }> = [];
    if (buyerAmount > 0) distributions.push({ address: escrow.buyer_address, amount: buyerAmount });
    if (sellerAmount > 0) distributions.push({ address: escrow.seller_address, amount: sellerAmount });
    if (distributions.length === 0) throw new Error('nothing_to_distribute');

    const twResp = await tw.resolveDispute({
      contractId: escrow.contract_address,
      disputeResolver: platformAddress(),
      distributions,
    });
    return { xdr: twResp.xdr, escrow };
  }

  async markResolved(input: { contract_address: string; tx_hash: string; refund: boolean }): Promise<HireEscrowRow> {
    const status: HireEscrowRow['status'] = input.refund ? 'refunded' : 'resolved';
    const r = await pool.query<HireEscrowRow>(
      `UPDATE hire_escrows
          SET status = $1,
              resolve_tx_hash = $2,
              resolved_at = NOW()
        WHERE contract_address = $3
        RETURNING *`,
      [status, input.tx_hash, input.contract_address],
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('escrow_not_found');
    return r.rows[0];
  }

  /**
   * List stale escrows (`answered` past timeout) — used by both the cron
   * notifier and the seller Studio queue to surface Claim-overdue rows.
   */
  async listStale(sellerAddress?: string): Promise<HireEscrowRow[]> {
    const params: string[] = [];
    let where = `status = 'answered' AND timeout_at IS NOT NULL AND timeout_at < NOW()`;
    if (sellerAddress) {
      params.push(sellerAddress);
      where += ` AND seller_address = $1`;
    }
    const r = await pool.query<HireEscrowRow>(
      `SELECT * FROM hire_escrows WHERE ${where} ORDER BY timeout_at ASC LIMIT 100`,
      params,
    );
    return r.rows;
  }

  async listForBuyerOrSeller(address: string): Promise<HireEscrowRow[]> {
    // PRD-T reconcile: before returning, sync any in-flight escrows with
    // on-chain truth. If the escrow contract has zero USDC balance, funds
    // moved out (buyer approved+released, or platform resolved a dispute) —
    // update our DB even if we never saw the submit callback. This heals the
    // "seller sees ANSWERED forever" class of drift where the tx landed but
    // our /escrow/submit was never called.
    await this.reconcileInFlightForAddress(address);
    const r = await pool.query<HireEscrowRow>(
      `SELECT * FROM hire_escrows
        WHERE buyer_address = $1 OR seller_address = $1
        ORDER BY created_at DESC LIMIT 200`,
      [address],
    );
    return r.rows;
  }

  /**
   * Sync in-flight escrows (funded / answered / disputed) touching this
   * address with on-chain state. Called opportunistically from listing
   * endpoints — cheap when there are few in-flight rows, safe to skip on
   * chain-read errors (we keep the DB state, next refresh retries).
   */
  private async reconcileInFlightForAddress(address: string): Promise<void> {
    const r = await pool.query<{ id: string; contract_address: string; status: string }>(
      `SELECT id, contract_address, status FROM hire_escrows
        WHERE (buyer_address = $1 OR seller_address = $1)
          AND status IN ('funded', 'answered', 'disputed')
          AND contract_address NOT LIKE 'pending:%'`,
      [address],
    );
    if (r.rowCount === 0) return;
    const s = getStellar();
    const { Contract, Address, nativeToScVal, scValToNative } = await import('@stellar/stellar-sdk');
    await Promise.all(r.rows.map(async (row) => {
      try {
        // Simulate USDC SAC .balance(escrow_contract) — zero-balance = funds moved out.
        const tx = (await s.buildTx(s.platformKeypair.publicKey()))
          .addOperation(
            new Contract(s.usdcSacId).call(
              'balance',
              new Address(row.contract_address).toScVal(),
            ),
          )
          .build();
        const sim = await s.rpc.simulateTransaction(tx);
        const retVal = 'result' in sim && sim.result?.retval;
        if (!retVal) return;
        const balance = BigInt((scValToNative(retVal) as number | bigint) ?? 0);
        if (balance !== 0n) return;
        // Zero balance → funds distributed. Map to terminal status.
        const newStatus = row.status === 'disputed' ? 'resolved' : 'released';
        const tsCol = newStatus === 'resolved' ? 'resolved_at' : 'released_at';
        await pool.query(
          `UPDATE hire_escrows
              SET status = $1, ${tsCol} = COALESCE(${tsCol}, NOW())
            WHERE id = $2 AND status = $3`,
          [newStatus, row.id, row.status],
        );
        logger.info(
          { contract: row.contract_address, from: row.status, to: newStatus },
          'escrow:reconciled-from-chain',
        );
      } catch (err) {
        logger.debug(
          { contract: row.contract_address, err: (err as Error).message },
          'escrow:reconcile:skip',
        );
      }
    }));
  }

  async listForAgent(agentId: string): Promise<HireEscrowRow[]> {
    const r = await pool.query<HireEscrowRow>(
      `SELECT * FROM hire_escrows WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [agentId],
    );
    return r.rows;
  }
}

export const escrowService = new EscrowService();
export { PLATFORM_FEE_BPS, TIMEOUT_HOURS, ESCROW_TIER_MULTIPLIER };
