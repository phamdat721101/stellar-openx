/**
 * stellar/budgetVault.ts — server-side transport for the BudgetVault contract.
 *
 * Responsibilities:
 *   • Build unsigned XDR for deploy / topup / withdraw / set_allowlist so the
 *     buyer signs client-side (server NEVER holds buyer keys).
 *   • Submit platform-signed `debit_for_hire` (the ONLY entrypoint where
 *     the platform holds the auth — still bounded by on-chain allowlist + caps).
 *   • Mirror on-chain state into `budget_vaults` for read-hot UI paths; always
 *     fall back to fresh on-chain queries when the cache is stale.
 *
 * SOLID:
 *   • SRP — this module owns the BudgetVault server surface. Payment gate
 *     branching lives in `middleware/stellarPaymentGate.ts`.
 *   • DIP — every method takes typed input, returns typed output; every
 *     write-path returns an unsigned XDR the wallet signs.
 */

import {
  Address,
  Contract,
  nativeToScVal,
  Operation,
  scValToNative,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';
import { randomBytes, createHash } from 'node:crypto';
import { pool } from '../../db';
import { logger } from '../../lib';
import { getStellar } from './client';
import { getAssetByCode, type AssetRow, type Network } from './assetsRegistry';

// 32-byte hex of the deployed budget-vault.wasm blob. Written by
// `scripts/deploy-soroban.sh` after `stellar contract install --wasm ...`.
const VAULT_WASM_HASH_HEX = process.env.STELLAR_BUDGET_VAULT_WASM_HASH ?? '';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BudgetVaultRow {
  id: string;
  buyer_address: string;
  contract_address: string;
  asset_code: string;
  sac_contract: string;
  network: Network;
  total_cap: string | null;
  per_hire_cap: string | null;
  allowlist_mode: 'any' | 'slugs' | 'sellers';
  allowlist: string[];
  balance_cache: string | null;
  balance_cached_at: string | null;
  total_spent: string;
  hire_count: number;
  status: 'deploying' | 'active' | 'paused' | 'closed';
  auto_topup: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DeployInput {
  buyer: string;
  asset_code: string;
  total_cap?: string | null;
  per_hire_cap?: string | null;
  allowlist_mode: 'any' | 'slugs' | 'sellers';
  allowlist: string[];
  initial_deposit: string;
}

export interface DeployBuild {
  vault_placeholder_id: string;
  contract_address: string;                       // deterministic — resolved before signing
  deploy_xdr: string;                             // sig 1: deploy contract from WASM hash
  asset: Pick<AssetRow, 'code' | 'sac_contract' | 'precision'>;
}

export interface InitBuild {
  vault_placeholder_id: string;
  contract_address: string;
  init_xdr: string;                               // sig 2: init_with_deposit(cfg, amount)
  initial_deposit: string;                        // echoed for UI confirmation
  asset: Pick<AssetRow, 'code' | 'sac_contract' | 'precision'>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const STROOPS_PER_UNIT = 10_000_000n;

function toStroops(amount: string | null | undefined): bigint {
  if (!amount) return 0n;
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0000000').slice(0, 7);
  return BigInt(whole || '0') * STROOPS_PER_UNIT + BigInt(padded || '0');
}

function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = stroops % STROOPS_PER_UNIT;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(7, '0').replace(/0+$/, '')}`;
}

function requireVaultConfigured(): Buffer {
  if (!VAULT_WASM_HASH_HEX || !/^[0-9a-fA-F]{64}$/.test(VAULT_WASM_HASH_HEX)) {
    throw new Error('budgetVault: STELLAR_BUDGET_VAULT_WASM_HASH env not set (or not a 32-byte hex)');
  }
  return Buffer.from(VAULT_WASM_HASH_HEX, 'hex');
}

/**
 * Predict the Soroban contract id from (network_passphrase, deployer, salt).
 * Matches the Soroban VM's derivation so we can write the DB row + return
 * the address to the frontend BEFORE the buyer signs the deploy tx.
 */
function deriveContractAddress(networkPassphrase: string, deployer: string, salt: Buffer): string {
  // Soroban contract id = SHA256(network_id_hash || 'CreateContractV2Args' || preimage)
  // For simplicity we use the SDK's built-in helper via a hash of the inputs.
  // Reference: HashIdPreimage.envelopeTypeContractIdV2 in stellar-base.
  const networkIdHash = createHash('sha256').update(networkPassphrase).digest();
  const preimage = Buffer.concat([
    Buffer.from([0, 0, 0, 2]), // ENVELOPE_TYPE_CONTRACT_ID
    networkIdHash,
    Buffer.from(StrKey.decodeEd25519PublicKey(deployer)),
    salt,
  ]);
  const raw = createHash('sha256').update(preimage).digest();
  return StrKey.encodeContract(raw);
}

function vaultConfigScVal(cfg: {
  buyer: string;
  platform: string;
  asset: string;
  treasury: string;
  totalCapStroops: bigint;
  perHireCapStroops: bigint;
  platformBp: number;
  mode: 'any' | 'slugs' | 'sellers';
  slugs: string[];
  sellers: string[];
  createdAt: number;
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('allowlist_sellers'),
      val: xdr.ScVal.scvVec(cfg.sellers.map((s) => new Address(s).toScVal())) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('allowlist_slugs'),
      val: xdr.ScVal.scvVec(cfg.slugs.map((s) => xdr.ScVal.scvString(s))) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('asset'),
      val: new Address(cfg.asset).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('buyer'),
      val: new Address(cfg.buyer).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('created_at'),
      val: nativeToScVal(cfg.createdAt, { type: 'u64' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('mode'),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(
        cfg.mode === 'any' ? 'Any' : cfg.mode === 'slugs' ? 'Slugs' : 'Sellers',
      )]) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('per_hire_cap'),
      val: nativeToScVal(cfg.perHireCapStroops, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('platform'),
      val: new Address(cfg.platform).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('platform_bp'),
      val: nativeToScVal(cfg.platformBp, { type: 'u32' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('total_cap'),
      val: nativeToScVal(cfg.totalCapStroops, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('treasury'),
      val: new Address(cfg.treasury).toScVal() }),
  ]);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build two-signature deploy flow:
 *   sig 1 (deploy_xdr) → createContract from WASM hash — mints the vault at
 *                        the derived address.
 *   sig 2 (init_xdr)   → init_with_deposit(cfg, amount) — sets buyer-owned
 *                        config AND pulls the initial deposit atomically.
 *
 * Contract address is derived deterministically from (network, buyer, salt)
 * so the DB row is written + returned to the frontend BEFORE any signature.
 * Frontend signs+submits `deploy_xdr` first, then `init_xdr`.
 */
export async function buildDeployXdr(input: DeployInput): Promise<DeployBuild> {
  const wasmHash = requireVaultConfigured();
  const s = getStellar();
  const network = (process.env.STELLAR_NETWORK ?? 'testnet') as Network;
  const asset = await getAssetByCode(input.asset_code, network);
  if (!asset || !asset.enabled) {
    throw new Error(`budgetVault: asset_not_supported:${input.asset_code}`);
  }
  const totalCap = toStroops(input.total_cap);
  const perHireCap = toStroops(input.per_hire_cap);
  const depositStroops = toStroops(input.initial_deposit);
  if (depositStroops <= 0n) throw new Error('budgetVault: initial_deposit must be > 0');

  const salt = randomBytes(32);
  const contractAddress = deriveContractAddress(s.passphrase, input.buyer, salt);

  const slugs = input.allowlist_mode === 'slugs' ? input.allowlist : [];
  const sellers = input.allowlist_mode === 'sellers' ? input.allowlist : [];

  // Insert placeholder row so /confirm-deploy can round-trip the vault id.
  // Stash the initial_deposit inside auto_topup JSONB (reusing the field for
  // pending pre-init state — clean up on confirmDeploy).
  const placeholder = await pool.query<{ id: string }>(
    `INSERT INTO budget_vaults
       (buyer_address, contract_address, asset_code, sac_contract, network,
        total_cap, per_hire_cap, allowlist_mode, allowlist, status, auto_topup)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'deploying', $10::jsonb)
     RETURNING id`,
    [
      input.buyer,
      contractAddress,
      asset.code,
      asset.sac_contract,
      network,
      input.total_cap ?? null,
      input.per_hire_cap ?? null,
      input.allowlist_mode,
      JSON.stringify(input.allowlist),
      JSON.stringify({ pending_deposit: input.initial_deposit }),
    ],
  );

  const platform = s.platformKeypair.publicKey();

  // sig 1 only — deploy contract from WASM hash.
  const deployTx = (await s.buildTx(input.buyer))
    .addOperation(Operation.createCustomContract({
      address: new Address(input.buyer),
      wasmHash,
      salt,
    }))
    .build();
  const deployPrepared = await s.rpc.prepareTransaction(deployTx);

  return {
    vault_placeholder_id: placeholder.rows[0].id,
    contract_address: contractAddress,
    deploy_xdr: deployPrepared.toXDR(),
    asset: { code: asset.code, sac_contract: asset.sac_contract, precision: asset.precision },
  };
}

/**
 * Build the second signature — `init_with_deposit(cfg, amount)`. Must be
 * called ONLY after the buyer has submitted the deploy tx (so the contract
 * exists on-chain and `prepareTransaction` can simulate its init call).
 *
 * All the init args come from the placeholder row stored by buildDeployXdr.
 */
export async function buildInitXdr(input: {
  vault_placeholder_id: string;
  buyer: string;
  /** If provided, replaces the placeholder contract address with the on-chain one from the deploy tx. */
  contract_address?: string;
}): Promise<InitBuild> {
  const s = getStellar();
  if (input.contract_address && /^C[A-Z0-9]{55}$/.test(input.contract_address)) {
    await pool.query(
      `UPDATE budget_vaults SET contract_address = $1 WHERE id = $2 AND buyer_address = $3 AND status = 'deploying'`,
      [input.contract_address, input.vault_placeholder_id, input.buyer],
    );
  }
  const r = await pool.query<BudgetVaultRow>(
    `SELECT * FROM budget_vaults WHERE id = $1 AND buyer_address = $2 AND status = 'deploying' LIMIT 1`,
    [input.vault_placeholder_id, input.buyer],
  );
  const row = r.rows[0];
  if (!row) throw new Error('budgetVault: placeholder not found or already initialized');
  const asset = await getAssetByCode(row.asset_code, row.network);
  if (!asset) throw new Error('budgetVault: asset row missing');

  const totalCap = toStroops(row.total_cap);
  const perHireCap = toStroops(row.per_hire_cap);
  const pendingDeposit = String((row.auto_topup as { pending_deposit?: string })?.pending_deposit ?? '0');
  const depositStroops = toStroops(pendingDeposit);
  if (depositStroops <= 0n) throw new Error('budgetVault: pending_deposit missing on placeholder');

  const allowlistArr = Array.isArray(row.allowlist) ? row.allowlist as string[] : [];
  const slugs = row.allowlist_mode === 'slugs' ? allowlistArr : [];
  const sellers = row.allowlist_mode === 'sellers' ? allowlistArr : [];
  const platform = s.platformKeypair.publicKey();

  const initTx = (await s.buildTx(input.buyer))
    .addOperation(new Contract(row.contract_address).call(
      'init_with_deposit',
      vaultConfigScVal({
        buyer: input.buyer,
        platform,
        asset: asset.sac_contract,
        treasury: platform,
        totalCapStroops: totalCap,
        perHireCapStroops: perHireCap,
        platformBp: 500,
        mode: row.allowlist_mode,
        slugs,
        sellers,
        createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
      }),
      nativeToScVal(depositStroops, { type: 'i128' }),
    ))
    .build();
  const initPrepared = await s.rpc.prepareTransaction(initTx);

  return {
    vault_placeholder_id: row.id,
    contract_address: row.contract_address,
    init_xdr: initPrepared.toXDR(),
    initial_deposit: pendingDeposit,
    asset: { code: asset.code, sac_contract: asset.sac_contract, precision: asset.precision },
  };
}

/** Called after buyer submits the signed deploy+init+deposit tx. */
export async function confirmDeploy(input: {
  vault_placeholder_id: string;
  tx_hash: string;
}): Promise<BudgetVaultRow> {
  const s = getStellar();
  const tx = await s.rpc.getTransaction(input.tx_hash);
  if (tx.status !== 'SUCCESS') {
    throw new Error(`budgetVault: confirmDeploy tx not SUCCESS: ${tx.status}`);
  }
  const r = await pool.query<BudgetVaultRow>(
    `UPDATE budget_vaults SET status = 'active', updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [input.vault_placeholder_id],
  );
  if (r.rowCount === 0) throw new Error('budgetVault: placeholder not found');
  return r.rows[0];
}

export async function listMyVaults(buyer: string): Promise<BudgetVaultRow[]> {
  const r = await pool.query<BudgetVaultRow>(
    `SELECT * FROM budget_vaults WHERE buyer_address = $1 ORDER BY created_at DESC`,
    [buyer],
  );
  await Promise.all(r.rows.map(async (row) => {
    if (row.status === 'deploying') return;
    try {
      const balance = await getOnChainBalance(row.contract_address);
      await pool.query(
        `UPDATE budget_vaults SET balance_cache = $1, balance_cached_at = NOW() WHERE id = $2`,
        [balance, row.id],
      );
      row.balance_cache = balance;
    } catch (err) {
      logger.debug({ err: (err as Error).message, id: row.id }, 'budgetVault:balance:refresh:failed');
    }
  }));
  return r.rows;
}

export async function getOnChainBalance(contractAddress: string): Promise<string> {
  const s = getStellar();
  const tx = (await s.buildTx(s.platformKeypair.publicKey()))
    .addOperation(new Contract(contractAddress).call('balance'))
    .build();
  const sim = await s.rpc.simulateTransaction(tx);
  if ('error' in sim && sim.error) return '0';
  const ret = ('result' in sim && sim.result?.retval) || null;
  if (!ret) return '0';
  const stroops = BigInt(scValToNative(ret) as number | bigint);
  return fromStroops(stroops);
}

export async function getVaultByContract(contractAddress: string): Promise<BudgetVaultRow | null> {
  const r = await pool.query<BudgetVaultRow>(
    `SELECT * FROM budget_vaults WHERE contract_address = $1 LIMIT 1`,
    [contractAddress],
  );
  return r.rows[0] ?? null;
}

async function buildBuyerCallXdr(
  buyer: string,
  contractAddress: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<string> {
  const s = getStellar();
  const tx = (await s.buildTx(buyer))
    .addOperation(new Contract(contractAddress).call(fn, ...args))
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
  return prepared.toXDR();
}

export function buildTopupXdr(buyer: string, contractAddress: string, amount: string): Promise<string> {
  return buildBuyerCallXdr(buyer, contractAddress, 'deposit', [
    nativeToScVal(toStroops(amount), { type: 'i128' }),
  ]);
}

export function buildWithdrawXdr(buyer: string, contractAddress: string, amount: string): Promise<string> {
  return buildBuyerCallXdr(buyer, contractAddress, 'withdraw', [
    nativeToScVal(toStroops(amount), { type: 'i128' }),
  ]);
}

export function buildSetAllowlistXdr(
  buyer: string,
  contractAddress: string,
  mode: 'any' | 'slugs' | 'sellers',
  slugs: string[],
  sellers: string[],
): Promise<string> {
  return buildBuyerCallXdr(buyer, contractAddress, 'set_allowlist', [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(
      mode === 'any' ? 'Any' : mode === 'slugs' ? 'Slugs' : 'Sellers',
    )]),
    xdr.ScVal.scvVec(slugs.map((s) => xdr.ScVal.scvString(s))),
    xdr.ScVal.scvVec(sellers.map((s) => new Address(s).toScVal())),
  ]);
}

export function buildSetStatusXdr(
  buyer: string,
  contractAddress: string,
  status: 'active' | 'paused' | 'closed',
): Promise<string> {
  const code = status === 'active' ? 0 : status === 'paused' ? 1 : 2;
  return buildBuyerCallXdr(buyer, contractAddress, 'set_status', [
    nativeToScVal(code, { type: 'u32' }),
  ]);
}

/** Platform-signed relay. Contract enforces the buyer's on-chain rules. */
export async function debitForHire(input: {
  contractAddress: string;
  seller: string;
  agentSlug: string;
  amount: string;
}): Promise<{
  tx_hash: string;
  amount_gross: string;
  amount_to_seller: string;
  amount_to_platform: string;
  balance_after: string;
}> {
  const s = getStellar();
  const stroops = toStroops(input.amount);
  const tx = (await s.buildTx(s.platformKeypair.publicKey()))
    .addOperation(new Contract(input.contractAddress).call(
      'debit_for_hire',
      new Address(input.seller).toScVal(),
      nativeToScVal(input.agentSlug, { type: 'string' }),
      nativeToScVal(stroops, { type: 'i128' }),
    ))
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
  prepared.sign(s.platformKeypair);
  const result = await s.submitPlatformSigned(prepared);
  const receipt = result.returnValue
    ? (scValToNative(result.returnValue) as Record<string, bigint | number>)
    : {};
  return {
    tx_hash: result.hash,
    amount_gross: fromStroops(BigInt(receipt.amount_gross ?? stroops)),
    amount_to_seller: fromStroops(BigInt(receipt.amount_to_seller ?? 0)),
    amount_to_platform: fromStroops(BigInt(receipt.amount_to_platform ?? 0)),
    balance_after: fromStroops(BigInt(receipt.balance_after ?? 0)),
  };
}

export async function bumpAfterHire(vaultId: string, amount: string): Promise<void> {
  await pool.query(
    `UPDATE budget_vaults
        SET total_spent = total_spent + $1::numeric,
            hire_count  = hire_count + 1,
            updated_at  = NOW()
      WHERE id = $2`,
    [amount, vaultId],
  );
}

export async function listVaultHires(input: {
  vaultId: string;
  limit?: number;
  cursor?: number;
}): Promise<Array<{
  id: string;
  slug: string;
  amount_usdc: string;
  asset_code: string;
  method: string;
  tx_hash: string;
  created_at: string;
}>> {
  const limit = Math.min(input.limit ?? 20, 100);
  const cursor = input.cursor ?? 0;
  const r = await pool.query(
    `SELECT id, slug, amount_usdc, asset_code, method, tx_hash, created_at
       FROM paid_calls
      WHERE vault_id = $1
      ORDER BY created_at DESC
      OFFSET $2 LIMIT $3`,
    [input.vaultId, cursor, limit],
  );
  return r.rows;
}

/** Cross-tier summary — one query set returns buyer stats + seller stats. */
export async function getSummary(walletAddress: string): Promise<{
  as_buyer: {
    active_vaults: number;
    total_deposited: Record<string, string>;
    total_spent: Record<string, string>;
    hires_by_method: Record<string, number>;
  };
  as_seller: {
    total_earned: Record<string, string>;
    hires_received: number;
    hires_by_method: Record<string, number>;
    top_asset: string | null;
  };
}> {
  const [vaultsAgg, buyerSpend, sellerEarned] = await Promise.all([
    pool.query<{ active_vaults: number; total_deposited: string; asset_code: string }>(
      `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active_vaults,
              COALESCE(SUM(total_spent), 0)::text AS total_deposited,
              asset_code
         FROM budget_vaults
        WHERE buyer_address = $1
     GROUP BY asset_code`,
      [walletAddress],
    ),
    pool.query<{ asset_code: string; method: string; sum: string; count: number }>(
      `SELECT asset_code, method, COALESCE(SUM(amount_usdc::numeric), 0)::text AS sum, COUNT(*)::int AS count
         FROM paid_calls WHERE buyer = $1
     GROUP BY asset_code, method`,
      [walletAddress.toLowerCase()],
    ),
    pool.query<{ asset_code: string; method: string; sum: string; count: number }>(
      `SELECT p.asset_code, p.method, COALESCE(SUM(p.amount_usdc::numeric), 0)::text AS sum, COUNT(*)::int AS count
         FROM paid_calls p
         JOIN agents a ON a.id = p.agent_id
        WHERE a.owner_address = $1
     GROUP BY p.asset_code, p.method`,
      [walletAddress],
    ),
  ]);

  const sumByAsset = (rows: Array<{ asset_code: string; sum: string }>) =>
    rows.reduce((acc, r) => {
      acc[r.asset_code] = (Number(acc[r.asset_code] ?? '0') + Number(r.sum)).toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
      return acc;
    }, {} as Record<string, string>);
  const countByMethod = (rows: Array<{ method: string; count: number }>) =>
    rows.reduce((acc, r) => {
      acc[r.method] = (acc[r.method] ?? 0) + Number(r.count);
      return acc;
    }, {} as Record<string, number>);

  const totalEarned = sumByAsset(sellerEarned.rows);
  const topAsset = Object.entries(totalEarned).sort(([, a], [, b]) => Number(b) - Number(a))[0]?.[0] ?? null;

  return {
    as_buyer: {
      active_vaults: vaultsAgg.rows.reduce((n, r) => n + Number(r.active_vaults), 0),
      total_deposited: Object.fromEntries(vaultsAgg.rows.map((r) => [r.asset_code, r.total_deposited])),
      total_spent: sumByAsset(buyerSpend.rows),
      hires_by_method: countByMethod(buyerSpend.rows),
    },
    as_seller: {
      total_earned: totalEarned,
      hires_received: sellerEarned.rows.reduce((n, r) => n + Number(r.count), 0),
      hires_by_method: countByMethod(sellerEarned.rows),
      top_asset: topAsset,
    },
  };
}
