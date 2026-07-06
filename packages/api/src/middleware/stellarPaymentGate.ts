/**
 * stellarPaymentGate — single middleware, single rail, two modes.
 *
 * Replaces the EVM `paymentGate.ts` (x402 + MPP across Arbitrum/Base).
 *
 * Flow:
 *   1. Buyer GETs `/api/v1/<slug>` with no payment header.
 *   2. Gate looks up the agent (Supabase), computes price stroops, builds a
 *      `StellarPaymentChallenge`, signs an HMAC nonce, returns 402 with the
 *      challenge JSON body.
 *   3. Buyer signs the appropriate Stellar tx (paywall-router or privacy-pool)
 *      with their Wallets Kit wallet and submits via Soroban RPC. They retry
 *      `/api/v1/<slug>` with `X-PAYMENT: stellar <tx_hash>` and
 *      `X-PAYMENT-MODE: public|private`.
 *   4. Gate verifies the tx landed (Soroban RPC `getTransaction`) and matches
 *      the expected contract id; on success records to `paid_calls` and lets
 *      the request through.
 *
 * SOLID:
 *  - SRP: gate composes challenge + verification + ledger write. Contract
 *    knowledge is delegated to `stellar/marketplace.ts` / `stellar/privacyPool.ts`.
 *  - DIP: the gate depends on `getStellar()` and the ledger record() — both
 *    swappable for tests.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import * as ledger from '../services/paidCallLedger';
import { getStellar } from '../services/stellar/client';
import { getAssetByCode, resolveAssetForRequest, type AssetRow } from '../services/stellar/assetsRegistry';
import { buildV2RequiredHeader } from '../services/x402/v2Header';
import { verifyHireProof, type ProofBundle } from '../services/zk/verifier';
import { stroopsToUsdc, usdcToStroops, type PaymentMode, type StellarPaymentChallenge } from '@openx/sdk';
import type { AuthRequest } from './auth';

const PAYMENT_SECRET = process.env.PAYMENT_SECRET ?? 'dev-only-rotate-me';
const NETWORK_TAG: string = `stellar:${process.env.STELLAR_NETWORK ?? 'testnet'}`;
const PRIVATE_TIER_MULTIPLIER = Number(process.env.PRIVATE_TIER_MULTIPLIER ?? 1.5);

export interface StellarPriceableRequest extends AuthRequest {
  pricedAgent?: {
    id: string;
    slug: string;
    seller_id: number | null;
    pricing: {
      x402?: string | null;
      /** v0.30 — per-asset override (`{MGUSD:'0.55', USDC:'0.50'}`). Optional. */
      assets?: Record<string, string>;
      /** v0.30 — agent's default asset code (falls through to 'USDC'). */
      asset_code?: string;
    } | null;
    soroban_agent_id?: string | null;
  };
  receipt?: {
    tx_hash: string;
    amount_usdc: string;
    payment_mode: PaymentMode;
    /** v0.30 — asset actually settled (USDC by default). */
    asset_code?: string;
  };
}

function signNonce(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', PAYMENT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyNonce(token: string): (Record<string, unknown> & { exp: number }) | null {
  try {
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', PAYMENT_SECRET).update(body).digest('base64url');
    if (sig !== expected) return null;
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildChallenge(
  agent: NonNullable<StellarPriceableRequest['pricedAgent']>,
  mode: PaymentMode,
  asset: AssetRow,
): StellarPaymentChallenge {
  // Per-asset pricing precedence:
  //   1. pricing.assets[<code>]  — explicit seller-set price for this asset
  //   2. pricing.x402            — legacy single-asset price (USDC-equivalent)
  //   3. '0'                     — free/broken pricing
  const basePrice =
    agent.pricing?.assets?.[asset.code] ??
    agent.pricing?.x402 ??
    '0';
  const baseStroops = usdcToStroops(basePrice);
  const stroops =
    mode === 'private'
      ? (baseStroops * BigInt(Math.round(PRIVATE_TIER_MULTIPLIER * 1000))) / 1000n
      : baseStroops;

  const exp = Date.now() + 5 * 60 * 1000;
  const nonceTok = signNonce({
    aid: agent.soroban_agent_id ?? agent.id,
    mode,
    stroops: stroops.toString(),
    asset_code: asset.code,
    exp,
  });

  return {
    network: NETWORK_TAG as `stellar:${string}`,
    asset: asset.code,
    amount_stroops: stroops.toString(),
    contract_id: settlementContractIds(mode, asset.sac_contract)[0],
    agent_id: agent.soroban_agent_id ?? agent.id.replaceAll('-', ''),
    nonce: nonceTok,
    expires_at: exp,
    payment_mode: mode,
    display_amount_usdc: (Number(stroops) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
    asset_info: {
      code: asset.code,
      sac_contract: asset.sac_contract,
      precision: asset.precision,
      display_name: (asset.metadata as Record<string, string>)?.display_name,
    },
  };
}

/**
 * emitV2RequiredHeader — dual-emit the x402 v2 `X-PAYMENT-REQUIRED` header
 * alongside the JSON challenge body. New clients (n-payment, x402 tooling)
 * read the header; pre-v0.30 clients keep reading the JSON body. Zero break.
 */
function emitV2RequiredHeader(
  res: Response,
  agent: NonNullable<StellarPriceableRequest['pricedAgent']>,
  challenge: StellarPaymentChallenge,
  asset: AssetRow,
): void {
  const s = getStellar();
  const header = buildV2RequiredHeader({
    scheme: 'stellar-sep41',
    chain: NETWORK_TAG.replace(':', '-'),      // stellar-testnet | stellar-mainnet
    asset: asset.sac_contract,
    assetCode: asset.code,
    amount: challenge.amount_stroops,
    precision: asset.precision,
    payTo: s.platformKeypair.publicKey(),
    memo: `agent:${agent.slug}`,
    expires: Math.floor(challenge.expires_at / 1000),
    requestId: crypto.randomBytes(8).toString('hex'),
    nonce: challenge.nonce,
  });
  res.setHeader('X-Payment-Required', header);
}

/**
 * settlementContractIds — asset-aware source of truth for "which Soroban
 * contract(s) may legitimately settle this payment mode".
 *
 *  public  → [paywallRouter, asset.sac_contract]
 *  private → [asset.sac_contract, privacyPool?, privacyPoolToken?, paywallRouter]
 *            v3.2 default is the platform-relay strategy: buyer signs a SAC
 *            transfer(buyer → platform) — the SAC contract emits the
 *            settlement event we verify. The pool contracts stay accepted
 *            for the v3.3 ZK opt-in path. paywallRouter is the fallback.
 */
function settlementContractIds(mode: PaymentMode, assetSac?: string): string[] {
  const s = getStellar();
  const sac = assetSac ?? s.usdcSacId;
  if (mode === 'private') {
    const ids: string[] = [sac];
    if (s.contracts.privacyPool) ids.push(s.contracts.privacyPool);
    if (s.contracts.privacyPoolToken) ids.push(s.contracts.privacyPoolToken);
    ids.push(s.contracts.paywallRouter);
    return ids;
  }
  return [s.contracts.paywallRouter, sac];
}

/**
 * verifyZkHeaders — decode + verify the buyer's Groth16 proof off the request.
 *
 * Headers:
 *   x-zk-proof   base64(proof JSON — snarkjs shape)
 *   x-zk-public  base64(publicSignals JSON — [commitment, agent_bind, agent_id])
 *
 * We validate the proof against the vk at services/zk/verification_key.json
 * AND enforce publicSignals[2] === Keccak(slug)[:31] so a proof for agent A
 * cannot be replayed against agent B.
 */
async function verifyZkHeaders(
  req: Request,
  agentSlug: string,
): Promise<{ ok: true; commitment: string } | { ok: false; reason: string }> {
  const proofHdr = req.headers['x-zk-proof'] as string | undefined;
  const publicsHdr = req.headers['x-zk-public'] as string | undefined;
  if (!proofHdr || !publicsHdr) return { ok: false, reason: 'x-zk-proof / x-zk-public required for private tier' };
  let bundle: ProofBundle;
  try {
    bundle = {
      proof: JSON.parse(Buffer.from(proofHdr, 'base64').toString('utf8')),
      publicSignals: JSON.parse(Buffer.from(publicsHdr, 'base64').toString('utf8')),
    };
  } catch {
    return { ok: false, reason: 'x-zk-proof / x-zk-public base64/JSON decode failed' };
  }
  const r = await verifyHireProof(bundle, { expectedAgentSlug: agentSlug });
  if ('reason' in r) {
    return { ok: false, reason: r.reason };
  }
  return { ok: true, commitment: r.commitment };
}

async function verifyTxHash(
  txHash: string,
  expectedContractIds: string[],
): Promise<{ ledger: number } | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const s = getStellar();
  try {
    const r = await s.rpc.getTransaction(txHash);
    if (r.status !== 'SUCCESS') return null;
    // Cheap heuristic — Soroban events for any acceptable settlement
    // contract id must be present in the same ledger.
    const eventsResp = await s.rpc.getEvents({
      startLedger: r.ledger,
      filters: [{ type: 'contract', contractIds: expectedContractIds }],
      limit: 50,
    });
    const matches = eventsResp.events.some((e) => e.txHash === txHash);
    return matches ? { ledger: r.ledger } : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, txHash }, 'stellarPaymentGate:verify-error');
    return null;
  }
}

export async function stellarPaymentGate(
  req: StellarPriceableRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const slug = (req.params.id ?? req.params.agentId ?? req.params.slug) as string | undefined;
  if (!slug) {
    res.status(400).json({ error: 'agent id required' });
    return;
  }
  const r = await pool.query(
    `SELECT id, slug, seller_id, pricing, soroban_agent_id
       FROM agents WHERE (id::text = $1 OR slug = $1)
              AND published = true AND archived_at IS NULL`,
    [slug],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const agent = r.rows[0];
  req.pricedAgent = agent;

  // Strict-chain policy (v3.1): every paywalled call MUST settle on Soroban.
  // The v3.0 "demo short-circuit" (free answer when soroban_agent_id is
  // null) is gone — it silently bypassed wallet signing and USDC payment,
  // which broke the private-x402 contract this gate exists to enforce.
  // Atomic publish now guarantees `soroban_agent_id` is populated when
  // `published=true`; the 412 below is the defensive last line for any
  // legacy row left in a half-published state.
  if (!agent.soroban_agent_id) {
    res.status(412).json({
      error: 'agent_pending_onchain_registration',
      detail:
        'This agent has no Soroban registration yet — ask the seller to (re-)publish so the on-chain agent_id is committed.',
    });
    return;
  }

  const mode = ((req.headers['x-payment-mode'] as string) ?? 'public').toLowerCase() as PaymentMode;
  if (mode !== 'public' && mode !== 'private' && mode !== 'escrow') {
    res.status(400).json({ error: 'invalid X-PAYMENT-MODE; expected public|private|escrow' });
    return;
  }

  // ── BudgetVault tier (PRD-M2) ───────────────────────────────────────────
  // Zero-signature hire path: buyer opts to pay from a vault they pre-funded.
  // Server-side allowlist + cap enforcement (mirrors on-chain rules); the
  // platform-signed debit fails on-chain if we miss any check.
  const vaultHeader = req.headers['x-budget-vault'] as string | undefined;
  if (vaultHeader && process.env.FEATURE_M2_BUDGET_VAULT === 'true') {
    const buyerAddr = req.headers['x-stellar-address'] as string | undefined;
    if (!buyerAddr || !/^G[A-Z2-7]{55}$/.test(buyerAddr)) {
      res.status(400).json({ error: 'x-stellar-address required for budget-vault tier' });
      return;
    }
    try {
      const budgetVault = await import('../services/stellar/budgetVault');
      const vault = await budgetVault.getVaultByContract(vaultHeader);
      if (!vault) { res.status(400).json({ error: 'vault_not_found' }); return; }
      if (vault.buyer_address !== buyerAddr) {
        res.status(403).json({ error: 'vault_ownership_mismatch' });
        return;
      }
      if (vault.status !== 'active') {
        res.status(400).json({ error: `vault_${vault.status}` });
        return;
      }
      const preferredHeader = req.headers['x-preferred-asset'] as string | undefined;
      const assetForVault = await getAssetByCode(vault.asset_code);
      if (!assetForVault) {
        res.status(400).json({ error: 'vault_asset_not_registered' });
        return;
      }
      if (preferredHeader && preferredHeader.toUpperCase() !== vault.asset_code) {
        res.status(400).json({ error: 'vault_asset_mismatch', vault_asset: vault.asset_code, requested: preferredHeader });
        return;
      }
      // Price the hire in the vault's asset.
      const priceStr =
        (agent.pricing?.assets?.[assetForVault.code] as string | undefined) ??
        agent.pricing?.x402 ??
        '0';
      if (!priceStr || Number(priceStr) <= 0) {
        res.status(400).json({ error: 'agent_free_or_unpriced' });
        return;
      }
      // Allowlist + cap enforcement (fail fast so we don't burn gas on-chain).
      const allowlist = Array.isArray(vault.allowlist) ? vault.allowlist : [];
      if (vault.allowlist_mode === 'slugs' && !allowlist.includes(agent.slug)) {
        res.status(403).json({ error: 'agent_not_in_allowlist' });
        return;
      }
      if (vault.allowlist_mode === 'sellers') {
        const sellerCheck = await pool.query<{ owner_address: string }>(
          `SELECT owner_address FROM agents WHERE id = $1 LIMIT 1`,
          [agent.id],
        );
        const sellerAddr = sellerCheck.rows[0]?.owner_address;
        if (!sellerAddr || !allowlist.includes(sellerAddr)) {
          res.status(403).json({ error: 'seller_not_in_allowlist' });
          return;
        }
      }
      if (vault.per_hire_cap && Number(priceStr) > Number(vault.per_hire_cap)) {
        res.status(402).json({ error: 'per_hire_cap_exceeded', per_hire_cap: vault.per_hire_cap, requested: priceStr });
        return;
      }
      // On-chain balance check (self-healing, freshest source of truth).
      const balance = await budgetVault.getOnChainBalance(vault.contract_address);
      if (Number(balance) < Number(priceStr)) {
        res.status(402).json({ error: 'insufficient_vault_balance', balance, required: priceStr });
        return;
      }
      // Resolve seller.
      const sellerRes = await pool.query<{ owner_address: string }>(
        `SELECT owner_address FROM agents WHERE id = $1 LIMIT 1`,
        [agent.id],
      );
      const seller = sellerRes.rows[0]?.owner_address;
      if (!seller) { res.status(404).json({ error: 'seller_address_missing' }); return; }
      const receipt = await budgetVault.debitForHire({
        contractAddress: vault.contract_address,
        seller,
        agentSlug: agent.slug,
        amount: priceStr,
      });
      await budgetVault.bumpAfterHire(vault.id, priceStr);
      await ledger.record({
        agentId: agent.id,
        slug: agent.slug,
        buyer: buyerAddr,
        amountUsdc: priceStr,
        txHash: receipt.tx_hash,
        network: NETWORK_TAG,
        method: 'budget_vault',
        sellerId: agent.seller_id ?? null,
        assetCode: vault.asset_code,
        vaultId: vault.id,
      });
      req.receipt = {
        tx_hash: receipt.tx_hash,
        amount_usdc: priceStr,
        payment_mode: 'public',
        asset_code: vault.asset_code,
      };
      next();
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message, vault: vaultHeader }, 'stellarPaymentGate:budget-vault:failed');
      res.status(500).json({ error: 'budget_vault_debit_failed', detail: (err as Error).message.slice(0, 200) });
      return;
    }
  }

  // ── Escrow tier (PRD-T) ──────────────────────────────────────────────────
  // The buyer has already deployed + funded a Trustless Work escrow. We
  // treat the funded escrow as the receipt: no 402 challenge, no separate
  // Stellar tx to verify — the funded state is enforced by the on-chain
  // TW contract and mirrored in hire_escrows.status = 'funded'.
  //
  // NOTE: /api/v1/* is not behind the `auth` middleware (paymentGate IS the
  // auth). So `req.user` is undefined here — we read `x-stellar-address`
  // directly and validate its shape before use.
  if (mode === 'escrow') {
    const rawAddr = req.headers['x-stellar-address'];
    const buyer = typeof rawAddr === 'string' && /^G[A-Z2-7]{55}$/.test(rawAddr) ? rawAddr : null;
    const escrowAddr = (req.headers['x-payment'] as string | undefined)?.replace(/^escrow\s+/, '').trim();
    if (!buyer || !escrowAddr) {
      res.status(400).json({
        error: 'escrow tier requires x-stellar-address + X-PAYMENT: escrow <contract_address>',
      });
      return;
    }
    const esc = await pool.query(
      `SELECT id, contract_address, buyer_address, agent_id, status, amount_usdc, answer
         FROM hire_escrows
        WHERE contract_address = $1 AND buyer_address = $2 AND agent_id = $3
        LIMIT 1`,
      [escrowAddr, buyer, agent.id],
    );
    if (esc.rowCount === 0) {
      res.status(402).json({ error: 'no_funded_escrow_for_this_agent', hint: 'POST /v3/marketplace/escrow/build-action-xdr with action:"deploy"' });
      return;
    }
    const row = esc.rows[0] as {
      contract_address: string;
      status: string;
      amount_usdc: string;
      answer: string | null;
    };
    // The buyer can only cash in a `funded` escrow once — subsequent hits
    // where status is answered/approved/released just return the cached
    // answer via the /api/v1 route.
    if (row.status !== 'funded') {
      // Idempotent: allow the route to re-serve the cached answer if the
      // buyer refreshes the page. The route handler checks req.receipt.
      if (['answered', 'approved', 'released'].includes(row.status) && row.answer) {
        req.receipt = { tx_hash: row.contract_address, amount_usdc: row.amount_usdc, payment_mode: 'escrow' };
        next();
        return;
      }
      res.status(402).json({ error: `escrow_not_funded:${row.status}` });
      return;
    }
    await ledger.record({
      agentId: agent.id,
      slug: agent.slug,
      buyer,
      amountUsdc: row.amount_usdc,
      txHash: `escrow-${row.contract_address}`,
      network: NETWORK_TAG,
      method: 'escrow',
      sellerId: agent.seller_id ?? null,
      assetCode: 'USDC',
    });
    req.receipt = { tx_hash: row.contract_address, amount_usdc: row.amount_usdc, payment_mode: 'escrow', asset_code: 'USDC' };
    next();
    return;
  }

  // PRD-G credit-first short-circuit (chain-agnostic). When buyer has enough
  // balance in `buyer_credits`, debit and bypass the chain dance.
  if (process.env.FEATURE_CREDIT_SYSTEM === 'true') {
    const buyer = req.user?.address;
    const price = agent.pricing?.x402;
    if (buyer && price && Number(price) > 0) {
      try {
        const credits = await import('../services/creditService');
        const debit = await credits.tryDebit({
          wallet_address: buyer,
          amount_usdc: price,
          agent_id: agent.id,
          seller_id: agent.seller_id ?? null,
        });
        if (debit.ok) {
          await ledger.record({
            agentId: agent.id,
            slug: agent.slug,
            buyer,
            amountUsdc: String(price),
            txHash: `credit-${debit.ledger_id}`,
            network: NETWORK_TAG,
            method: 'credit',
            sellerId: agent.seller_id ?? null,
            assetCode: 'USDC',
          });
          res.setHeader('X-Credit-Balance', debit.new_balance);
          req.receipt = { tx_hash: `credit-${debit.ledger_id}`, amount_usdc: String(price), payment_mode: 'public', asset_code: 'USDC' };
          next();
          return;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'stellarPaymentGate:credit-debit:failed');
      }
    }
  }

  const xPayment = (req.headers['x-payment'] as string | undefined) ?? '';
  // v0.30 — asset resolution: X-PREFERRED-ASSET header → agent's default → 'USDC'.
  const preferredHeader = req.headers['x-preferred-asset'] as string | undefined;
  let resolvedAsset: AssetRow;
  try {
    resolvedAsset = await resolveAssetForRequest({
      preferredCode: preferredHeader ?? null,
      agentDefaultCode: agent.pricing?.asset_code ?? null,
    });
  } catch (err) {
    res.status(400).json({ error: 'asset_not_supported', detail: (err as Error).message });
    return;
  }

  if (!xPayment.startsWith('stellar ')) {
    const challenge = buildChallenge(agent, mode, resolvedAsset);
    emitV2RequiredHeader(res, agent, challenge, resolvedAsset);
    res.status(402).json(challenge);
    return;
  }
  const [, txHash] = xPayment.trim().split(/\s+/);
  const nonceTok = req.headers['x-payment-nonce'] as string | undefined;
  const nonce = nonceTok ? verifyNonce(nonceTok) : null;
  if (!nonce || nonce.mode !== mode) {
    const challenge = buildChallenge(agent, mode, resolvedAsset);
    emitV2RequiredHeader(res, agent, challenge, resolvedAsset);
    res.status(402).json(challenge);
    return;
  }
  // Reject cross-asset replay — a nonce minted for USDC cannot settle MGUSD.
  if (nonce.asset_code && nonce.asset_code !== resolvedAsset.code) {
    const challenge = buildChallenge(agent, mode, resolvedAsset);
    emitV2RequiredHeader(res, agent, challenge, resolvedAsset);
    res.status(402).json({ ...challenge, error: 'asset_mismatch' });
    return;
  }
  const expectedContracts = settlementContractIds(mode, resolvedAsset.sac_contract);
  const verified = await verifyTxHash(txHash, expectedContracts);
  if (!verified) {
    const challenge = buildChallenge(agent, mode, resolvedAsset);
    emitV2RequiredHeader(res, agent, challenge, resolvedAsset);
    res.status(402).json(challenge);
    return;
  }

  // Private tier: also require a valid Groth16 ZK proof bound to this agent.
  // Real snarkjs proof; server-side verification (Path B'); on-chain verifier
  // deployment is v3.4. See docs/runbooks/ZK_DEPLOY.md.
  let zkCommitment: string | null = null;
  if (mode === 'private') {
    const zkResult = await verifyZkHeaders(req, agent.slug);
    if ('reason' in zkResult) {
      logger.info({ slug: agent.slug, reason: zkResult.reason }, 'stellarPaymentGate:zk-reject');
      const challenge = buildChallenge(agent, mode, resolvedAsset);
      emitV2RequiredHeader(res, agent, challenge, resolvedAsset);
      res.status(402).json({ ...challenge, zk_error: zkResult.reason });
      return;
    }
    zkCommitment = zkResult.commitment;
    if (await ledger.isZkCommitmentUsed(zkCommitment)) {
      logger.info({ slug: agent.slug, commitment: zkCommitment.slice(0, 12) }, 'stellarPaymentGate:zk-replay');
      const challenge = buildChallenge(agent, mode, resolvedAsset);
      emitV2RequiredHeader(res, agent, challenge, resolvedAsset);
      res.status(402).json({ ...challenge, zk_error: 'proof replay: commitment already used' });
      return;
    }
  }
  await ledger.record({
    agentId: agent.id,
    slug: agent.slug,
    buyer: req.user?.address ?? 'anonymous',
    amountUsdc: stroopsToUsdc(BigInt(String(nonce.stroops ?? '0'))),
    txHash,
    network: NETWORK_TAG,
    method: mode === 'private' ? 'privacy_pool' : 'stellar_x402',
    sellerId: agent.seller_id ?? null,
    zkCommitment,
    assetCode: resolvedAsset.code,
  });
  req.receipt = {
    tx_hash: txHash,
    amount_usdc: String(nonce.stroops ?? '0'),
    payment_mode: mode,
    asset_code: resolvedAsset.code,
  };
  next();
}
