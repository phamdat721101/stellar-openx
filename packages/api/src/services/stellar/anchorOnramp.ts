/**
 * stellar/anchorOnramp.ts — Coinflow Stellar SEP-24 fiat onramp adapter.
 *
 * Replaces the EVM Coinflow-on-Arbitrum integration 1-for-1. Same hosted-iframe
 * pattern, same webhook idempotency contract, same `buyer_credits` accounting
 * after settlement.
 *
 * SOLID:
 *  - SRP: this module owns the Coinflow SEP-24 HTTP contract (session creation,
 *    status poll, webhook verification). Anything *downstream* (credits ledger,
 *    notifications) is invoked via injected callbacks — not imported here.
 */

import crypto from 'node:crypto';

export interface DepositSession {
  hostedUrl: string;
  sessionId: string;
  expiresAt: number;
}

export interface DepositStatus {
  sessionId: string;
  status: 'pending' | 'submitted' | 'completed' | 'failed';
  tx_hash?: string;
  amount_usdc?: string;
  stellar_account?: string;
}

export interface CoinflowEnv {
  apiKey: string;
  webhookSecret: string;
  baseUrl: string;
  network: 'testnet' | 'mainnet';
}

const DEFAULT_ENV: CoinflowEnv = {
  apiKey: process.env.COINFLOW_STELLAR_API_KEY ?? '',
  webhookSecret: process.env.COINFLOW_WEBHOOK_SECRET ?? '',
  baseUrl: process.env.COINFLOW_STELLAR_BASE_URL ?? 'https://api-sandbox.coinflow.cash/api/stellar',
  network: (process.env.STELLAR_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
};

/** Open a hosted SEP-24 deposit session. The frontend iframes `hostedUrl`. */
export async function createDepositSession(
  buyerStellarAddress: string,
  amountUsd: number,
  env: CoinflowEnv = DEFAULT_ENV,
): Promise<DepositSession> {
  if (!env.apiKey) {
    // Mock path — dev / smoke tests skip Coinflow when no key configured.
    const sessionId = crypto.randomUUID();
    return {
      hostedUrl: `${env.baseUrl}/mock-checkout?session=${sessionId}&amount=${amountUsd}`,
      sessionId,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }
  const resp = await fetch(`${env.baseUrl}/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      buyer_address: buyerStellarAddress,
      amount_usd: amountUsd,
      asset: 'USDC',
      network: env.network,
    }),
  });
  if (!resp.ok) {
    throw new Error(`coinflow:session-failed:${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return {
    hostedUrl: String(data.hosted_url),
    sessionId: String(data.session_id),
    expiresAt: Number(data.expires_at ?? Date.now() + 15 * 60 * 1000),
  };
}

/** Poll session status — used as a fallback when the webhook is late. */
export async function getDepositStatus(
  sessionId: string,
  env: CoinflowEnv = DEFAULT_ENV,
): Promise<DepositStatus> {
  if (!env.apiKey) {
    return { sessionId, status: 'pending' };
  }
  const resp = await fetch(`${env.baseUrl}/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${env.apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`coinflow:status-failed:${resp.status}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return {
    sessionId,
    status: data.status as DepositStatus['status'],
    tx_hash: data.tx_hash as string | undefined,
    amount_usdc: data.amount_usdc as string | undefined,
    stellar_account: data.buyer_address as string | undefined,
  };
}

/**
 * Verify a Coinflow webhook signature (HMAC SHA-256 over raw body).
 * Returns the parsed event when valid; throws otherwise.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  env: CoinflowEnv = DEFAULT_ENV,
): { sessionId: string; status: DepositStatus['status']; tx_hash?: string; amount_usdc?: string; buyer_address?: string } {
  if (!env.webhookSecret) {
    // In mock/dev mode treat all webhooks as authentic for smoke tests.
    return JSON.parse(rawBody);
  }
  const expected = crypto.createHmac('sha256', env.webhookSecret).update(rawBody).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))) {
    throw new Error('coinflow:webhook:bad-signature');
  }
  return JSON.parse(rawBody);
}
