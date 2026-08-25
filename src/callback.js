import crypto from 'node:crypto';
import { logger } from './lib/logger.js';

/**
 * Optional outbound "did it land?" notification. Every processed event POSTs a
 * short JSON summary to BRIDGE_CALLBACK_URL, signed the same way Pylon signs its own
 * webhooks so the receiver can verify it:
 *
 *   X-Bridge-Timestamp: <unix seconds>
 *   X-Bridge-Signature: hs256=<hex hmac of `${timestamp}.${body}`>
 *
 * Point it at a GoHighLevel inbound webhook, a Slack relay, or nothing at all.
 */
export function createNotifier({ url, secret, timeoutMs = 10000 }) {
  if (!url) {
    return async () => ({ sent: false, reason: 'no BRIDGE_CALLBACK_URL configured' });
  }

  return async function notify(record) {
    const summary = buildSummary(record);
    const body = JSON.stringify(summary);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(timestamp),
          'X-Bridge-Signature': `hs256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn('callback endpoint returned an error', { status: response.status, url });
        return { sent: false, status: response.status };
      }
      return { sent: true, status: response.status };
    } catch (error) {
      // A failing callback must never fail the event itself — the CRM write has
      // already happened by this point.
      logger.warn('callback delivery failed', { error, url });
      return { sent: false, reason: error?.message };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function buildSummary(record) {
  return {
    eventId: record.id,
    eventName: record.eventName,
    status: record.status,
    attempts: record.attempts,
    receivedAt: record.receivedAt,
    completedAt: record.updatedAt,
    ok: record.status === 'succeeded',
    result: record.result
      ? {
          contactId: record.result.contactId ?? null,
          opportunityId: record.result.opportunityId ?? null,
          opportunityCreated: record.result.opportunityCreated ?? false,
          monetaryValue: record.result.monetaryValue ?? null,
          currency: record.result.currency ?? null,
          fieldsWritten: record.result.fieldsWritten ?? 0,
          contractFileUrl: record.result.contractFileUrl ?? null,
          contractAttachedToContact: record.result.contractAttachedToContact ?? false,
          skipped: record.result.skipped ?? false,
          warnings: record.result.warnings ?? [],
        }
      : null,
    error: record.error ? { message: record.error.summary ?? record.error.message, kind: record.error.kind } : null,
  };
}
