import type { RequestHandler } from 'express';
import client from 'prom-client';
import { logger } from './logger';

/**
 * observability — /metrics (Prometheus) + /health.
 *
 * Stellar-native: one counter per payment mode, one histogram for HTTP
 * duration, one gauge for credit balance, plus the live Stellar RPC probe.
 */

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

export const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration ms',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

export const stellarPaidCallsTotal = new client.Counter({
  name: 'stellar_paid_calls_total',
  help: 'Total paid calls settled through Stellar',
  labelNames: ['mode'] as const, // public | private | credit | free
  registers: [registry],
});

export const stellarTxLatencyMs = new client.Histogram({
  name: 'stellar_tx_latency_ms',
  help: 'Soroban transaction submission latency',
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const labels = {
        method: req.method,
        path: req.route?.path ?? req.path,
        status: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      httpRequestDurationMs.observe(labels, Date.now() - start);
    });
    next();
  };
}

export const metricsHandler: RequestHandler = async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.send(await registry.metrics());
};

// ── Health ────────────────────────────────────────────────────────────────

export type DepStatus = 'ok' | 'degraded' | 'down';
export interface HealthProbe {
  name: string;
  check: () => Promise<DepStatus>;
}
const probes: HealthProbe[] = [];
export function registerHealthProbe(probe: HealthProbe): void {
  probes.push(probe);
}

async function runProbe(probe: HealthProbe): Promise<DepStatus> {
  try {
    return await Promise.race<DepStatus>([
      probe.check(),
      new Promise<DepStatus>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1_000)),
    ]);
  } catch (err) {
    logger.warn({ dep: probe.name, err: (err as Error).message }, 'health:probe_failed');
    return 'down';
  }
}

export const healthHandler: RequestHandler = async (_req, res) => {
  const deps: Record<string, DepStatus> = {};
  await Promise.all(
    probes.map(async (p) => {
      deps[p.name] = await runProbe(p);
    }),
  );
  // Built-in Stellar probe — load lazily to avoid bootstrap cycles
  let stellar: DepStatus = 'down';
  let ledger: number | null = null;
  try {
    const { getStellar } = await import('../services/stellar/client');
    const s = getStellar();
    const latest = await s.rpc.getLatestLedger();
    ledger = latest.sequence;
    stellar = 'ok';
  } catch {
    stellar = 'down';
  }
  deps.stellar = stellar;

  const overall: DepStatus = Object.values(deps).some((d) => d === 'down')
    ? 'down'
    : Object.values(deps).some((d) => d === 'degraded')
      ? 'degraded'
      : 'ok';
  res.status(overall === 'down' ? 503 : 200).json({
    status: overall,
    deps,
    stellar: { network: process.env.STELLAR_NETWORK ?? 'testnet', ledger },
  });
};
