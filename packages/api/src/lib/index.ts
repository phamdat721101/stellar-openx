/**
 * Public barrel for `lib/`. Server-side concerns only (logger + observability
 * + lifecycle). Runtime-neutral primitives stay in `@fhe-ai-context/runtime-utils`.
 */

export { logger, correlationId, getRequestId, setRequestContext } from './logger';
export {
  metricsMiddleware,
  metricsHandler,
  healthHandler,
  registerHealthProbe,
  stellarPaidCallsTotal,
  stellarTxLatencyMs,
  type HealthProbe,
  type DepStatus,
} from './observability';
export { installLifecycle } from './lifecycle';
