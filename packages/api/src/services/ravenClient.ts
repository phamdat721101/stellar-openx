/**
 * ravenClient — the single boundary to Stellar Raven (SDF-endorsed MCP catalog
 * at https://raven.stellar.buzz/mcp).
 *
 * Raven is the grounding-data source for the S2 (Learn Stellar) and S3 (skill
 * auto-gen) stages of the training pipeline. It is an external, solo-maintained
 * dependency, so it is fully isolated behind `IRavenClient` (DIP): the training
 * services depend on the interface, never on fetch URLs or MCP framing.
 *
 * Resilience contract:
 *   • `RAVEN_MCP_URL` unset OR any network/timeout error → return the embedded
 *     FIXTURE. This keeps smokes fully offline and the pipeline running when
 *     Raven is down (research risk T5/E3).
 *   • Per-query in-memory cache (TTL) — Raven refreshes daily, so a short cache
 *     is safe and keeps training runs fast + within cost.
 *
 * Auth: WorkOS AuthKit OAuth, 1 browser sign-in per seller, 0 API keys stored
 * in code. The per-seller bearer token lives in `seller_raven_auth` (mig 044).
 * A static `RAVEN_MCP_TOKEN` env is an optional fallback for server-side jobs
 * (DGM cron). Unauthenticated when neither is present.
 *
 * SOLID: SRP — talks to Raven and nothing else; no DB writes beyond its own
 * auth-token table; no training/business logic.
 */

import { pool } from '../db';
import { logger } from '../lib';

// ─── public types ──────────────────────────────────────────────────────────

export interface RavenEntry {
  title: string;
  summary: string;
  kind: 'entry' | 'playbook';
  /** Fuller text — populated for playbooks; used as the skill auto-gen source. */
  body?: string;
}

export interface IRavenClient {
  /** Ranked catalog entries + playbooks for a capability/query. */
  search(query: string, ownerAddress?: string): Promise<RavenEntry[]>;
  /** Run sandboxed agent JS via Raven's `execute` tool. Best-effort. */
  execute(code: string, ownerAddress?: string): Promise<unknown>;
}

// ─── config ─────────────────────────────────────────────────────────────────

const RAVEN_URL = process.env.RAVEN_MCP_URL?.trim() || '';
const STATIC_TOKEN = process.env.RAVEN_MCP_TOKEN?.trim() || '';
const TIMEOUT_MS = Math.max(1000, Number(process.env.RAVEN_TIMEOUT_MS ?? 3000));
const CACHE_TTL_MS = Math.max(0, Number(process.env.RAVEN_CACHE_TTL_MS ?? 5 * 60 * 1000));

// ─── offline fixture (also the CI smoke source) ─────────────────────────────

const FIXTURE: RavenEntry[] = [
  {
    title: 'Transfer USDC on Stellar',
    summary:
      'USDC is a SEP-41 asset. Transfer via the SAC `transfer(from,to,amount)` in stroops (1 USDC = 10,000,000 stroops), or a classic payment op keyed by asset code + issuer.',
    kind: 'entry',
  },
  {
    title: 'Soroban contract address format',
    summary:
      'Soroban contract ids are StrKey "C…" addresses (56 chars, base32). On-chain the id is a 32-byte value; the C-address is its StrKey encoding.',
    kind: 'entry',
  },
  {
    title: 'SEP-41 token interface',
    summary:
      'SEP-41 is the standard Soroban token interface (balance, transfer, approve, decimals, name, symbol) — the Soroban analogue of ERC-20; the Stellar Asset Contract implements it.',
    kind: 'entry',
  },
  {
    title: 'x402 payment on Stellar',
    summary:
      'x402 returns HTTP 402 with a payment challenge; the client settles in USDC/MGUSD on Stellar and retries with a payment receipt header.',
    kind: 'entry',
  },
  {
    title: 'Playbook: compose an MGUSD payment',
    summary: 'Step-by-step: pick the MGUSD SAC, build a transfer, settle, and record the paid call.',
    kind: 'playbook',
    body:
      'MGUSD is a SEP-41 asset redeemable at MoneyGram retail. To compose a payment: (1) resolve the MGUSD SAC id, (2) build `transfer(buyer, payee, amount_stroops)`, (3) submit and confirm, (4) record the settlement. Handle asset-not-trusted by prompting a trustline first.',
  },
  {
    title: 'Playbook: query Horizon for account balances',
    summary: 'Fetch balances/history from Horizon and interpret asset lines.',
    kind: 'playbook',
    body:
      'Call GET /accounts/{id} on Horizon, read the `balances` array, match by asset_code + asset_issuer, and convert string balances to numbers. For paged history use the `/payments?cursor=` links.',
  },
];

// ─── in-memory cache ─────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; entries: RavenEntry[] }>();

// ─── auth-token persistence (WorkOS AuthKit) ────────────────────────────────

export async function getRavenToken(ownerAddress: string): Promise<string | null> {
  try {
    const r = await pool.query<{ workos_token: string; expires_at: string | null }>(
      `SELECT workos_token, expires_at FROM seller_raven_auth WHERE owner_address = $1 LIMIT 1`,
      [ownerAddress],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return row.workos_token;
  } catch {
    return null;
  }
}

export async function saveRavenToken(
  ownerAddress: string,
  token: string,
  expiresAt: Date | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO seller_raven_auth (owner_address, workos_token, expires_at, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (owner_address)
     DO UPDATE SET workos_token = EXCLUDED.workos_token,
                   expires_at   = EXCLUDED.expires_at,
                   updated_at   = NOW()`,
    [ownerAddress, token, expiresAt?.toISOString() ?? null],
  );
}

/** Build the WorkOS AuthKit authorize URL a seller opens once to connect Raven. */
export function ravenAuthorizeUrl(ownerAddress: string): string | null {
  const authUrl = process.env.RAVEN_WORKOS_AUTHORIZE_URL?.trim();
  const clientId = process.env.RAVEN_WORKOS_CLIENT_ID?.trim();
  const redirect = process.env.RAVEN_WORKOS_REDIRECT_URI?.trim();
  if (!authUrl || !clientId || !redirect) return null;
  const u = new URL(authUrl);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', ownerAddress);
  return u.toString();
}

/** Exchange an OAuth `code` for a token and persist it for the seller. */
export async function ravenExchangeCode(code: string, ownerAddress: string): Promise<boolean> {
  const tokenUrl = process.env.RAVEN_WORKOS_TOKEN_URL?.trim();
  const clientId = process.env.RAVEN_WORKOS_CLIENT_ID?.trim();
  const clientSecret = process.env.RAVEN_WORKOS_CLIENT_SECRET?.trim();
  const redirect = process.env.RAVEN_WORKOS_REDIRECT_URI?.trim();
  if (!tokenUrl || !clientId || !clientSecret || !redirect) return false;
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
    }),
  });
  if (!resp.ok) throw new Error(`raven:oauth:${resp.status}`);
  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return false;
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  await saveRavenToken(ownerAddress, data.access_token, expiresAt);
  return true;
}

// ─── implementation ──────────────────────────────────────────────────────────

class RavenClient implements IRavenClient {
  async search(query: string, ownerAddress?: string): Promise<RavenEntry[]> {
    if (!RAVEN_URL) return FIXTURE;
    const key = query.toLowerCase().trim();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    try {
      const raw = await this.callTool('search', { query }, ownerAddress);
      const entries = normalizeEntries(raw);
      const result = entries.length ? entries : FIXTURE;
      if (CACHE_TTL_MS > 0) cache.set(key, { at: Date.now(), entries: result });
      return result;
    } catch (err) {
      logger.warn({ err: (err as Error).message, query: key }, 'raven:search:fallback_fixture');
      return FIXTURE;
    }
  }

  async execute(code: string, ownerAddress?: string): Promise<unknown> {
    if (!RAVEN_URL) return { ok: false, reason: 'raven_disabled' };
    try {
      return await this.callTool('execute', { code }, ownerAddress);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'raven:execute:failed');
      return { ok: false, reason: 'raven_error' };
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    ownerAddress?: string,
  ): Promise<unknown> {
    const token = (ownerAddress ? await getRavenToken(ownerAddress) : null) ?? STATIC_TOKEN;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(RAVEN_URL, {
        method: 'POST',
        headers,
        signal: ac.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      if (!resp.ok) throw new Error(`raven:${resp.status}`);
      const data = (await resp.json()) as { result?: unknown; error?: { message?: string } };
      if (data.error) throw new Error(data.error.message ?? 'raven_rpc_error');
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── response normalization (defensive — MCP payload shapes vary) ───────────

function normalizeEntries(raw: unknown): RavenEntry[] {
  // MCP tools/call returns `{ content: [{ type:'text', text:'...json...' }] }`.
  const container = raw as { content?: Array<{ text?: string }>; entries?: unknown };
  let items: unknown = container?.entries;
  if (!items && Array.isArray(container?.content)) {
    const text = container.content.map((c) => c.text ?? '').join('\n').trim();
    try {
      const parsed = JSON.parse(text);
      items = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown }).entries;
    } catch {
      items = text ? [{ title: 'Raven result', summary: text.slice(0, 2000), kind: 'entry' }] : [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items
    .map((it): RavenEntry | null => {
      const o = it as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title : typeof o.name === 'string' ? o.name : '';
      const summary =
        typeof o.summary === 'string' ? o.summary : typeof o.description === 'string' ? o.description : '';
      if (!title && !summary) return null;
      const isPlaybook = o.kind === 'playbook' || typeof o.playbook === 'string' || typeof o.body === 'string';
      return {
        title: title || 'Untitled',
        summary: summary.slice(0, 2000),
        kind: isPlaybook ? 'playbook' : 'entry',
        body: typeof o.body === 'string' ? o.body : typeof o.playbook === 'string' ? o.playbook : undefined,
      };
    })
    .filter((e): e is RavenEntry => e !== null);
}

// ─── singleton export ────────────────────────────────────────────────────────

export const ravenClient: IRavenClient = new RavenClient();
