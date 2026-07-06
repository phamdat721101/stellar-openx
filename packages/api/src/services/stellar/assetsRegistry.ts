/**
 * stellar/assetsRegistry.ts — table-driven SEP-41 asset lookup.
 *
 * Replaces hardcoded USDC constants that used to be sprinkled across the
 * payment gate + escrow service. Single source of truth is the
 * `supported_assets` table (migration 041); this service caches queries in
 * memory (60s TTL) since the table is near-static.
 *
 * SOLID:
 *   • SRP — this module owns "resolve asset code / SAC / issuer for the
 *     current network". No settlement logic, no HTTP.
 *   • DIP — callers depend on the pure typed API (`getAssetByCode`,
 *     `getAssetBySacContract`) — swapping the store is a one-line change.
 */

import { pool } from '../../db';

export type Network = 'testnet' | 'mainnet';

export interface AssetRow {
  id: string;
  code: string;
  network: Network;
  sac_contract: string;
  issuer_gaddress: string | null;
  precision: number;
  min_amount: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

const TTL_MS = 60_000;
interface Cache<T> { value: T; expiresAt: number }
const listCache = new Map<Network | 'all', Cache<AssetRow[]>>();
const codeCache = new Map<string, Cache<AssetRow | null>>();
const sacCache = new Map<string, Cache<AssetRow | null>>();

function currentNetwork(): Network {
  return (process.env.STELLAR_NETWORK ?? 'testnet') as Network;
}

function fresh<T>(entry: Cache<T> | undefined): entry is Cache<T> {
  return !!entry && entry.expiresAt > Date.now();
}

function cacheKey(code: string, network: Network): string {
  return `${code.toUpperCase()}::${network}`;
}

export async function listSupportedAssets(network?: Network): Promise<AssetRow[]> {
  const key: Network | 'all' = network ?? 'all';
  const hit = listCache.get(key);
  if (fresh(hit)) return hit.value;
  const rows = network
    ? await pool.query<AssetRow>(
        `SELECT * FROM supported_assets WHERE enabled = TRUE AND network = $1 ORDER BY code`,
        [network],
      )
    : await pool.query<AssetRow>(
        `SELECT * FROM supported_assets WHERE enabled = TRUE ORDER BY network, code`,
      );
  const value = rows.rows;
  listCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function getAssetByCode(code: string, network?: Network): Promise<AssetRow | null> {
  const net = network ?? currentNetwork();
  const key = cacheKey(code, net);
  const hit = codeCache.get(key);
  if (fresh(hit)) return hit.value;
  const r = await pool.query<AssetRow>(
    `SELECT * FROM supported_assets WHERE code = $1 AND network = $2 LIMIT 1`,
    [code.toUpperCase(), net],
  );
  const value = r.rows[0] ?? null;
  codeCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function getAssetBySacContract(sac: string): Promise<AssetRow | null> {
  const hit = sacCache.get(sac);
  if (fresh(hit)) return hit.value;
  const r = await pool.query<AssetRow>(
    `SELECT * FROM supported_assets WHERE sac_contract = $1 LIMIT 1`,
    [sac],
  );
  const value = r.rows[0] ?? null;
  sacCache.set(sac, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/**
 * Resolve an asset from a request. Precedence:
 *   1. explicit `X-PREFERRED-ASSET` header (must be enabled)
 *   2. agent's default (`pricing.asset_code`)
 *   3. 'USDC' — backward-compat fallback for every pre-v0.30 agent
 *
 * Returns the DB row so downstream code has SAC + precision inline.
 */
export async function resolveAssetForRequest(input: {
  preferredCode?: string | null;
  agentDefaultCode?: string | null;
  network?: Network;
}): Promise<AssetRow> {
  const net = input.network ?? currentNetwork();
  const candidates = [input.preferredCode, input.agentDefaultCode, 'USDC']
    .filter((c): c is string => !!c && c.trim().length > 0);
  for (const code of candidates) {
    const row = await getAssetByCode(code, net);
    if (row && row.enabled) return row;
  }
  throw new Error(`assetsRegistry: no supported asset for network=${net} (tried ${candidates.join(', ')})`);
}

/** Test-only: reset in-memory caches. Safe no-op in production. */
export function _resetCacheForTest(): void {
  if (process.env.NODE_ENV === 'production') return;
  listCache.clear();
  codeCache.clear();
  sacCache.clear();
}
