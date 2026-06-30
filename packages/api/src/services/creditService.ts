/**
 * creditService — single insertion point for credit_accounts + credit_ledger
 * + seller_balances writes. Per PRD-G.
 *
 * SOLID:
 *   * SRP — this module owns balance, ledger, and seller accrual writes.
 *     Nothing else (paymentGate, v1Public, credits routes) ever runs raw
 *     SQL against these tables.
 *   * DIP — the two paywalls call `tryDebit()`; they don't know about the
 *     ledger row format, the locking strategy, or the seller-accrual split.
 *
 * Concurrency: every read-modify-write goes through `SELECT … FOR UPDATE`
 * inside a single transaction. No double-spend window.
 *
 * Idempotency: `credit_ledger (kind, tx_hash)` is UNIQUE for tx_hash IS NOT
 * NULL — replaying a top-up settle or a payout retry is a no-op.
 */

import { pool } from '../db';
import { logger } from '../lib';

// ─── Configuration (env-driven, validated at first use) ────────────────────

const WELCOME_USDC = Number(process.env.WELCOME_CREDIT_USDC ?? '25');
const SELLER_BPS = Number(process.env.REVENUE_SPLIT_SELLER_BPS ?? '7000');
const COMPUTE_BPS = Number(process.env.REVENUE_SPLIT_COMPUTE_BPS ?? '2500');
const PLATFORM_BPS = Number(process.env.REVENUE_SPLIT_PLATFORM_BPS ?? '500');
const NETWORK = `stellar:${process.env.STELLAR_NETWORK ?? 'testnet'}`;

if (SELLER_BPS + COMPUTE_BPS + PLATFORM_BPS !== 10000) {
  logger.warn(
    { SELLER_BPS, COMPUTE_BPS, PLATFORM_BPS },
    'creditService: revenue split does not sum to 10000 bps — using defaults at runtime',
  );
}

export const REVENUE_SPLIT = {
  seller_bps: SELLER_BPS,
  compute_bps: COMPUTE_BPS,
  platform_bps: PLATFORM_BPS,
};

export function isEnabled(): boolean {
  return process.env.FEATURE_CREDIT_SYSTEM === 'true';
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CreditAccount {
  id: number;
  privy_user_id: string | null;
  wallet_address: string;
  balance_usdc: string;       // decimal string for safety
  welcome_granted: boolean;
}

export interface LedgerRow {
  id: number;
  kind: 'welcome' | 'purchase' | 'spend' | 'refund' | 'payout';
  amount_usdc: string;
  agent_id: string | null;
  tx_hash: string | null;
  network: string | null;
  created_at: Date;
  meta: Record<string, unknown>;
}

export type DebitResult =
  | { ok: true; ledger_id: number; new_balance: string }
  | { ok: false; reason: 'insufficient' | 'disabled' | 'no_account' };

// ─── Account lifecycle ─────────────────────────────────────────────────────

/**
 * Find-or-create the (wallet × optional privy_user_id) row. Lazy-grants the
 * welcome bonus exactly once when we first see a Privy user id and the
 * account hasn't been granted yet.
 *
 * When `privy_user_id` is provided AND a row already exists for the wallet
 * without a Privy id, we link the two (single UPDATE) — no orphan rows.
 *
 * Returns the canonical row after any grant/link operations.
 */
export async function ensureAccount(opts: {
  wallet_address: string;
  privy_user_id?: string | null;
}): Promise<CreditAccount> {
  if (!isEnabled()) {
    // Returning a zero-balance non-persisted shape keeps callers simple:
    // they always get an `account` object. Writes still no-op.
    return {
      id: 0,
      privy_user_id: opts.privy_user_id ?? null,
      wallet_address: opts.wallet_address.toLowerCase(),
      balance_usdc: '0',
      welcome_granted: false,
    };
  }
  const wallet = opts.wallet_address.toLowerCase();
  const privy = opts.privy_user_id ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find by Privy id first (canonical), then by wallet.
    let row: any = null;
    if (privy) {
      const r = await client.query(
        `SELECT id, privy_user_id, wallet_address, balance_usdc::text, welcome_granted
           FROM credit_accounts WHERE privy_user_id = $1 FOR UPDATE`,
        [privy],
      );
      row = r.rows[0] ?? null;
    }
    if (!row) {
      const r = await client.query(
        `SELECT id, privy_user_id, wallet_address, balance_usdc::text, welcome_granted
           FROM credit_accounts WHERE wallet_address = $1 FOR UPDATE`,
        [wallet],
      );
      row = r.rows[0] ?? null;
    }

    if (!row) {
      // First sighting — create the account row.
      const r = await client.query(
        `INSERT INTO credit_accounts (privy_user_id, wallet_address)
              VALUES ($1, $2)
         ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
         RETURNING id, privy_user_id, wallet_address, balance_usdc::text, welcome_granted`,
        [privy, wallet],
      );
      row = r.rows[0];
    } else if (privy && !row.privy_user_id) {
      // Link: existing wallet row, now we know the Privy user.
      const r = await client.query(
        `UPDATE credit_accounts SET privy_user_id = $1, updated_at = now()
          WHERE id = $2
          RETURNING id, privy_user_id, wallet_address, balance_usdc::text, welcome_granted`,
        [privy, row.id],
      );
      row = r.rows[0];
    }

    // Welcome bonus — fires once per Privy user (preferred), else once per
    // wallet. We require either a Privy id OR explicit env opt-in so a
    // wallet-only sighting in a server-side script can't farm the bonus.
    const wantsGrant =
      !row.welcome_granted &&
      WELCOME_USDC > 0 &&
      (privy !== null || process.env.WELCOME_GRANT_WALLET_ONLY === 'true');

    if (wantsGrant) {
      await client.query(
        `UPDATE credit_accounts
            SET balance_usdc = balance_usdc + $1,
                welcome_granted = TRUE,
                updated_at = now()
          WHERE id = $2`,
        [WELCOME_USDC, row.id],
      );
      await client.query(
        `INSERT INTO credit_ledger (account_id, kind, amount_usdc, meta)
              VALUES ($1, 'welcome', $2, $3::jsonb)`,
        [row.id, WELCOME_USDC, JSON.stringify({ privy_bound: !!privy })],
      );
      row.balance_usdc = (Number(row.balance_usdc) + WELCOME_USDC).toFixed(6);
      row.welcome_granted = true;
      logger.info({ account_id: row.id, wallet, privy_bound: !!privy }, 'credits:welcome:granted');
    }

    await client.query('COMMIT');
    return {
      id: Number(row.id),
      privy_user_id: row.privy_user_id,
      wallet_address: row.wallet_address,
      balance_usdc: row.balance_usdc,
      welcome_granted: row.welcome_granted,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Balance / history ─────────────────────────────────────────────────────

export async function getBalance(wallet_address: string): Promise<CreditAccount | null> {
  if (!isEnabled()) return null;
  const r = await pool.query(
    `SELECT id, privy_user_id, wallet_address, balance_usdc::text, welcome_granted
       FROM credit_accounts WHERE wallet_address = $1`,
    [wallet_address.toLowerCase()],
  );
  return (r.rows[0] as CreditAccount | undefined) ?? null;
}

export async function listHistory(
  account_id: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<LedgerRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const r = await pool.query(
    `SELECT id, kind, amount_usdc::text, agent_id, tx_hash, network, meta, created_at
       FROM credit_ledger
      WHERE account_id = $1
   ORDER BY id DESC
      LIMIT $2 OFFSET $3`,
    [account_id, limit, offset],
  );
  return r.rows as LedgerRow[];
}

// ─── Debit (spend) — the hot path called by both paywalls ──────────────────

/**
 * Atomically debit `amount_usdc` from the buyer's account, write a `spend`
 * ledger row, AND credit the seller's accrued balance with the configured
 * 70% share. All in one transaction.
 *
 * Returns `{ok:true, ledger_id, new_balance}` on success, or an explicit
 * `reason` enum on failure so the caller can decide whether to fall through
 * to x402 (insufficient → emit 402; disabled → skip credit path entirely).
 */
export async function tryDebit(opts: {
  wallet_address: string;
  amount_usdc: number | string;
  agent_id: string;
  seller_id: number | null;
}): Promise<DebitResult> {
  if (!isEnabled()) return { ok: false, reason: 'disabled' };
  const amount = Number(opts.amount_usdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'insufficient' };
  }
  const wallet = opts.wallet_address.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const acc = await client.query(
      `SELECT id, balance_usdc::text FROM credit_accounts
        WHERE wallet_address = $1 FOR UPDATE`,
      [wallet],
    );
    if (acc.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no_account' };
    }
    const account_id = Number(acc.rows[0].id);
    const balance = Number(acc.rows[0].balance_usdc);
    if (balance < amount) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient' };
    }

    const upd = await client.query(
      `UPDATE credit_accounts
          SET balance_usdc = balance_usdc - $1, updated_at = now()
        WHERE id = $2
        RETURNING balance_usdc::text AS new_balance`,
      [amount, account_id],
    );

    const led = await client.query(
      `INSERT INTO credit_ledger (account_id, kind, amount_usdc, agent_id, network)
            VALUES ($1, 'spend', $2, $3, $4)
         RETURNING id`,
      [account_id, -amount, opts.agent_id, NETWORK],
    );
    const ledger_id = Number(led.rows[0].id);

    // Seller accrual — same TX, same lock scope. Skip when seller_id is null
    // (legacy agents without seller row, or platform-owned demos).
    if (opts.seller_id !== null && opts.seller_id !== undefined) {
      const sellerAmount = (amount * SELLER_BPS) / 10000;
      await client.query(
        `INSERT INTO seller_balances (seller_id, accrued_usdc)
              VALUES ($1, $2)
         ON CONFLICT (seller_id) DO UPDATE
            SET accrued_usdc = seller_balances.accrued_usdc + EXCLUDED.accrued_usdc,
                updated_at  = now()`,
        [opts.seller_id, sellerAmount],
      );
    }

    await client.query('COMMIT');
    logger.info(
      { account_id, agent_id: opts.agent_id, amount, seller_id: opts.seller_id ?? null },
      'credits:debit:ok',
    );
    return { ok: true, ledger_id, new_balance: upd.rows[0].new_balance };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Grant (purchase / refund) ─────────────────────────────────────────────

/**
 * Credit `amount_usdc` to an account from a top-up settlement or refund.
 * Idempotent on (kind, tx_hash). Auto-creates the account row when missing
 * so a buyer can top up before their first authenticated GET.
 */
export async function grant(opts: {
  wallet_address: string;
  amount_usdc: number;
  kind: 'purchase' | 'refund';
  tx_hash: string;
  meta?: Record<string, unknown>;
}): Promise<{ already_applied: boolean; new_balance: string }> {
  if (!isEnabled()) return { already_applied: false, new_balance: '0' };
  const wallet = opts.wallet_address.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check first — the UNIQUE index would also catch this but
    // an explicit lookup gives us a graceful 200 response instead of an
    // unhandled UNIQUE violation.
    const dup = await client.query(
      `SELECT 1 FROM credit_ledger WHERE kind = $1 AND tx_hash = $2`,
      [opts.kind, opts.tx_hash],
    );
    if ((dup.rowCount ?? 0) > 0) {
      const acc = await client.query(
        `SELECT balance_usdc::text AS b FROM credit_accounts WHERE wallet_address = $1`,
        [wallet],
      );
      await client.query('COMMIT');
      return { already_applied: true, new_balance: acc.rows[0]?.b ?? '0' };
    }

    // Find-or-create account.
    let r = await client.query(
      `SELECT id FROM credit_accounts WHERE wallet_address = $1 FOR UPDATE`,
      [wallet],
    );
    if (r.rowCount === 0) {
      r = await client.query(
        `INSERT INTO credit_accounts (wallet_address)
              VALUES ($1)
         ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
         RETURNING id`,
        [wallet],
      );
    }
    const account_id = Number(r.rows[0].id);

    await client.query(
      `UPDATE credit_accounts
          SET balance_usdc = balance_usdc + $1, updated_at = now()
        WHERE id = $2`,
      [opts.amount_usdc, account_id],
    );
    await client.query(
      `INSERT INTO credit_ledger (account_id, kind, amount_usdc, tx_hash, network, meta)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        account_id,
        opts.kind,
        opts.amount_usdc,
        opts.tx_hash,
        NETWORK,
        JSON.stringify(opts.meta ?? {}),
      ],
    );
    const bal = await client.query(
      `SELECT balance_usdc::text AS b FROM credit_accounts WHERE id = $1`,
      [account_id],
    );
    await client.query('COMMIT');
    logger.info(
      { account_id, wallet, amount: opts.amount_usdc, kind: opts.kind, tx_hash: opts.tx_hash },
      'credits:grant:ok',
    );
    return { already_applied: false, new_balance: bal.rows[0].b };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Seller payout bookkeeping ─────────────────────────────────────────────

export interface SellerBalance {
  seller_id: number;
  accrued_usdc: string;
  withdrawn_usdc: string;
  withdrawable_usdc: string;
  last_withdraw_at: Date | null;
}

export async function getSellerBalance(seller_id: number): Promise<SellerBalance> {
  const r = await pool.query(
    `SELECT seller_id,
            accrued_usdc::text   AS accrued_usdc,
            withdrawn_usdc::text AS withdrawn_usdc,
            (accrued_usdc - withdrawn_usdc)::text AS withdrawable_usdc,
            last_withdraw_at
       FROM seller_balances WHERE seller_id = $1`,
    [seller_id],
  );
  if (r.rowCount === 0) {
    return {
      seller_id,
      accrued_usdc: '0',
      withdrawn_usdc: '0',
      withdrawable_usdc: '0',
      last_withdraw_at: null,
    };
  }
  return r.rows[0] as SellerBalance;
}

/**
 * Atomically mark a seller's withdrawal: bump withdrawn_usdc, set
 * last_withdraw_at, and append a `payout` row to credit_ledger keyed by
 * the seller's wallet (so the ledger surface is uniform).
 *
 * The on-chain USDC.transfer happens BEFORE this call in
 * /v3/marketplace/seller/withdraw — this function only books the result.
 * Caller passes the seller's wallet_address so the ledger lookup is keyed
 * the same way as buyer rows.
 */
export async function markPayout(opts: {
  seller_id: number;
  seller_wallet_address: string;
  amount_usdc: number;
  tx_hash: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock + bump the seller row.
    const row = await client.query(
      `UPDATE seller_balances
          SET withdrawn_usdc   = withdrawn_usdc + $1,
              last_withdraw_at = now(),
              updated_at       = now()
        WHERE seller_id = $2
        RETURNING accrued_usdc::text AS accrued, withdrawn_usdc::text AS withdrawn`,
      [opts.amount_usdc, opts.seller_id],
    );
    if (row.rowCount === 0) {
      throw new Error('seller_balance_missing');
    }

    // Mirror the payout into credit_ledger keyed by the seller's wallet
    // account. We auto-create the account row if missing (sellers may not
    // have made a buyer hire yet).
    let acc = await client.query(
      `SELECT id FROM credit_accounts WHERE wallet_address = $1 FOR UPDATE`,
      [opts.seller_wallet_address.toLowerCase()],
    );
    if (acc.rowCount === 0) {
      acc = await client.query(
        `INSERT INTO credit_accounts (wallet_address)
              VALUES ($1)
         ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
         RETURNING id`,
        [opts.seller_wallet_address.toLowerCase()],
      );
    }
    const account_id = Number(acc.rows[0].id);

    await client.query(
      `INSERT INTO credit_ledger (account_id, kind, amount_usdc, tx_hash, network, meta)
            VALUES ($1, 'payout', $2, $3, $4, $5::jsonb)`,
      [
        account_id,
        -opts.amount_usdc,
        opts.tx_hash,
        NETWORK,
        JSON.stringify({ seller_id: opts.seller_id }),
      ],
    );
    await client.query('COMMIT');
    logger.info(
      { seller_id: opts.seller_id, amount: opts.amount_usdc, tx_hash: opts.tx_hash },
      'credits:payout:ok',
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
