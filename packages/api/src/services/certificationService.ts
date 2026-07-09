/**
 * certificationService — PRD-T-S S5 (Certify + earn) and re-certification.
 *
 * Awards the "Certified Stellar Agent" credential once an agent clears the S4
 * eval gate (stage = 'evaluating'):
 *   1. Compute a SHA-256 canonical certificate hash (audit-only, mirrors the
 *      concierge signServicePermit pattern).
 *   2. Attest ON-CHAIN via agent-registry.certify_agent (platform-signed).
 *      Best-effort: if the agent isn't on-chain yet or the network is down, the
 *      off-chain credential still issues with tx_hash = null (graceful deploy).
 *   3. Mirror to `agent_certifications` + set the fast badge columns on `agents`.
 *   4. Optional opt-in: open a Raven catalog PR (ravenCatalogPublisher).
 *
 * Re-certification (quarterly cron) re-runs the eval; on failure the agent is
 * downgraded to 'legacy_certified' (still earns, with a disclosure banner).
 *
 * SOLID: SRP — owns the certification lifecycle. On-chain glue is delegated to
 * stellar/marketplace.submitCertifyAgent; stage writes reuse trainingService.
 */

import { createHash } from 'node:crypto';
import { usdcToStroops } from '@openx/sdk';
import { pool } from '../db';
import { logger } from '../lib';
import {
  submitCertifyAgent,
  submitRegisterAgent,
  submitRevokeCertification,
  getCertification,
} from './stellar/marketplace';
import {
  recordTrainingEvent,
  setTrainingStage,
  requireOwnedAgent,
  trainingService,
  type TrainingState,
} from './trainingService';

const NETWORK_TAG = `stellar:${process.env.STELLAR_NETWORK ?? 'testnet'}`;
const RECERT_DAYS = Math.max(1, Number(process.env.RAVEN_RECERT_DAYS ?? 90));

export interface ICertificationService {
  certify(agentId: string, owner: string, opts?: { auto_publish?: boolean }): Promise<TrainingState>;
  revoke(agentId: string, toLegacy: boolean): Promise<void>;
  runRecertification(): Promise<{ checked: number; downgraded: number }>;
}

interface CertAgentRow {
  id: string;
  slug: string;
  owner_address: string;
  soroban_agent_id: string | null;
  cert_score: number | null;
  persona: { name?: string; system_prompt?: string } | null;
  pricing: { x402?: string } | null;
}

class CertificationService implements ICertificationService {
  async certify(
    agentId: string,
    owner: string,
    opts: { auto_publish?: boolean } = {},
  ): Promise<TrainingState> {
    const agent = await requireOwnedAgent(agentId, owner);
    if (agent.training_stage === 'certified') return trainingService.getState(agentId);
    if (agent.training_stage !== 'evaluating') {
      throw new Error('stage_precondition: agent must pass evaluation before certification');
    }

    const row = await this.loadCertAgent(agentId);
    const score = clamp01(row.cert_score ?? 0);
    const scoreBps = Math.round(score * 10_000);
    const version = (await this.currentVersion(agentId)) + 1;
    const certHash = canonicalCertHash({ agentId, slug: row.slug, scoreBps, version });

    // Ensure the agent has an on-chain identity, then attest on-chain. The whole
    // block is best-effort: if the network is unreachable the credential still
    // issues off-chain (txHash/onChain null) so certification never hard-blocks.
    let txHash: string | null = null;
    let onChainAgentId = row.soroban_agent_id;
    let onChainVerified = false;
    try {
      if (!onChainAgentId) {
        onChainAgentId = await this.ensureOnChainRegistration(row);
      }
      if (onChainAgentId) {
        const res = await submitCertifyAgent(onChainAgentId, scoreBps, certHash, version);
        txHash = res.hash;
        // Read-back verification — the on-chain record is the trust anchor.
        const chain = await getCertification(Buffer.from(onChainAgentId.replace(/^0x/, ''), 'hex'));
        onChainVerified = chain?.status === 'certified' && chain.version === version;
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, agentId }, 'cert:onchain:failed_offchain_only');
    }

    const expiresAt = new Date(Date.now() + RECERT_DAYS * 86_400_000);
    await pool.query(
      `INSERT INTO agent_certifications
         (agent_id, score, cert_hash, tx_hash, version, status, auto_publish, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'certified', $6, $7)`,
      [agentId, score, certHash, txHash, version, opts.auto_publish ?? false, expiresAt.toISOString()],
    );
    await pool.query(
      `UPDATE agents
          SET training_stage = 'certified', certificate_hash = $1, certified_at = NOW(), cert_score = $2
        WHERE id = $3`,
      [certHash, score, agentId],
    );
    await recordTrainingEvent({
      agentId,
      stage: 'certified',
      eventType: 'certify',
      passed: true,
      score,
      detail: {
        score_bps: scoreBps,
        version,
        tx_hash: txHash,
        on_chain_agent_id: onChainAgentId,
        on_chain_verified: onChainVerified,
        network: NETWORK_TAG,
      },
    });

    // Optional opt-in: publish back into the Raven catalog (closed loop).
    if (opts.auto_publish) {
      try {
        const { ravenCatalogPublisher } = await import('./ravenCatalogPublisher');
        const prUrl = await ravenCatalogPublisher.publish({
          slug: row.slug,
          scoreBps,
          certHash,
          agentId,
        });
        if (prUrl) {
          await pool.query(
            `UPDATE agent_certifications SET raven_pr_url = $1
              WHERE agent_id = $2 AND version = $3`,
            [prUrl, agentId, version],
          );
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, agentId }, 'cert:raven_publish:failed');
      }
    }

    logger.info({ agentId, scoreBps, txHash }, 'cert:issued');
    return trainingService.getState(agentId);
  }

  async revoke(agentId: string, toLegacy: boolean): Promise<void> {
    const row = await this.loadCertAgent(agentId).catch(() => null);
    if (row?.soroban_agent_id) {
      try {
        await submitRevokeCertification(row.soroban_agent_id, toLegacy);
      } catch (err) {
        logger.warn({ err: (err as Error).message, agentId }, 'cert:onchain_revoke:failed');
      }
    }
    const status = toLegacy ? 'legacy' : 'revoked';
    await pool.query(
      `UPDATE agent_certifications SET status = $1
        WHERE agent_id = $2 AND status = 'certified'`,
      [status, agentId],
    );
    await setTrainingStage(agentId, toLegacy ? 'legacy_certified' : 'evaluating');
    await recordTrainingEvent({
      agentId,
      stage: toLegacy ? 'legacy_certified' : 'evaluating',
      eventType: 'recert',
      passed: false,
      detail: { action: status },
    });
  }

  /** Quarterly cron: downgrade certs past their expiry to legacy. */
  async runRecertification(): Promise<{ checked: number; downgraded: number }> {
    const lock = await pool.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('recert_cron')::bigint) AS ok`,
    );
    if (!lock.rows[0]?.ok) return { checked: 0, downgraded: 0 };
    try {
      const due = await pool.query<{ agent_id: string }>(
        `SELECT agent_id FROM agent_certifications
          WHERE status = 'certified' AND expires_at < NOW()`,
      );
      for (const r of due.rows) {
        await this.revoke(r.agent_id, true).catch((err) =>
          logger.warn({ err: (err as Error).message, agentId: r.agent_id }, 'recert:downgrade:failed'),
        );
      }
      return { checked: due.rowCount ?? 0, downgraded: due.rowCount ?? 0 };
    } finally {
      await pool.query(`SELECT pg_advisory_unlock(hashtext('recert_cron')::bigint)`);
    }
  }

  /** Mint an on-chain identity for an agent that reached certification without
   *  one (platform-registrar). Persists the new id back to the DB. Returns the
   *  32-byte hex id, or null if registration didn't yield one. */
  private async ensureOnChainRegistration(row: CertAgentRow): Promise<string | null> {
    const priceStroops = usdcToStroops(row.pricing?.x402 ?? '0');
    const manifestHashHex = createHash('sha256')
      .update(`${row.slug}:${row.owner_address}`)
      .digest('hex');
    const { agentIdHex } = await submitRegisterAgent({
      seller: row.owner_address,
      slug: row.slug,
      displayName: row.persona?.name || row.slug,
      priceStroops,
      manifestHashHex,
      kyaRequired: false,
    });
    if (!agentIdHex) return null;
    await pool.query(`UPDATE agents SET soroban_agent_id = $1 WHERE id = $2`, [agentIdHex, row.id]);
    logger.info({ agentId: row.id, soroban_agent_id: agentIdHex }, 'cert:onchain:registered');
    return agentIdHex;
  }

  private async loadCertAgent(agentId: string): Promise<CertAgentRow> {
    const r = await pool.query<CertAgentRow>(
      `SELECT id, slug, owner_address, soroban_agent_id, cert_score, persona, pricing
         FROM agents WHERE id = $1`,
      [agentId],
    );
    if (r.rowCount === 0) throw new Error('not_found');
    return r.rows[0];
  }

  private async currentVersion(agentId: string): Promise<number> {
    const r = await pool.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM agent_certifications WHERE agent_id = $1`,
      [agentId],
    );
    return r.rows[0]?.max ?? 0;
  }
}

// ─── canonical certificate hash (SHA-256, audit-only) ────────────────────────

function canonicalCertHash(input: {
  agentId: string;
  slug: string;
  scoreBps: number;
  version: number;
}): string {
  const canonical = JSON.stringify({
    agent_id: input.agentId,
    slug: input.slug,
    score_bps: input.scoreBps,
    version: input.version,
    network: NETWORK_TAG,
    kind: 'stellar-agent-certification',
  });
  return '0x' + createHash('sha256').update(canonical).digest('hex');
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export const certificationService: ICertificationService = new CertificationService();
