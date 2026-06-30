/**
 * notifyService — seller-side event fan-out.
 *
 * v3.0.0 fires a single HTTP POST best-effort to the agent's
 * `notification_webhook_url` (if set). No DLQ, no retries; webhooks are
 * advisory. Sellers who need at-least-once delivery should also poll
 * /v3/agents/:id/recent-calls.
 *
 * SOLID:
 *  - SRP: one method, one job. No coupling to a task queue.
 *  - LSP: still exposes the same shape `INotifyService.notify(...)` as the
 *    legacy impl — the paid-call ledger uses it identically.
 */

import { pool } from '../db';
import { logger } from '../lib';

export type AgentEvent =
  | 'paid_call.completed'
  | 'message.created'
  | 'task.completed'
  | 'task.failed';

export interface INotifyService {
  notify(
    agent_id: string,
    event: AgentEvent,
    data: Record<string, unknown>,
    event_key: string,
  ): Promise<void>;
}

class NotifyService implements INotifyService {
  async notify(
    agent_id: string,
    event: AgentEvent,
    data: Record<string, unknown>,
    event_key: string,
  ): Promise<void> {
    try {
      const r = await pool.query<{ notification_webhook_url: string | null; slug: string | null }>(
        `SELECT notification_webhook_url, slug FROM agents WHERE id = $1 LIMIT 1`,
        [agent_id],
      );
      const url = r.rows[0]?.notification_webhook_url;
      if (!url) return;
      const payload = {
        event,
        agent_id,
        slug: r.rows[0]?.slug ?? null,
        event_key,
        timestamp: new Date().toISOString(),
        data,
      };
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((err) => {
        logger.warn({ agent_id, event, err: (err as Error).message }, 'notify:webhook-error');
      });
    } catch (err) {
      logger.warn({ agent_id, event, err: (err as Error).message }, 'notify:failed');
    }
  }
}

export const notifyService: INotifyService = new NotifyService();
