import { logger } from './lib/logger.js';

/**
 * In-process retry queue.
 *
 * Pylon times its webhook deliveries out after 10 seconds, and downloading a
 * contract PDF then uploading it to GoHighLevel can take longer than that. So
 * the HTTP handler acknowledges the webhook immediately (202) and the actual
 * work happens here, with its own backoff. State lives in the EventStore, so a
 * restart picks up anything that was still in flight.
 */
export class RetryQueue {
  constructor({ store, worker, maxAttempts = 5, backoffSeconds = [10, 60, 300, 1800, 3600], concurrency = 2 }) {
    this.store = store;
    this.worker = worker;
    this.maxAttempts = maxAttempts;
    this.backoffSeconds = backoffSeconds.length ? backoffSeconds : [10, 60, 300, 1800, 3600];
    this.concurrency = Math.max(1, concurrency);
    this.queue = [];
    this.running = 0;
    this.timers = new Map();
    this.stopped = false;
    this.idleWaiters = [];
  }

  /** Re-queues anything that was mid-flight when the process last stopped. */
  resume() {
    const pending = this.store.pending();
    for (const record of pending) {
      const dueIn = record.nextAttemptAt ? new Date(record.nextAttemptAt).getTime() - Date.now() : 0;
      this.schedule(record.id, Math.max(0, dueIn));
    }
    if (pending.length) logger.info('resumed pending events after restart', { count: pending.length });
    return pending.length;
  }

  enqueue(eventId) {
    this.schedule(eventId, 0);
  }

  schedule(eventId, delayMs) {
    if (this.stopped) return;
    const existing = this.timers.get(eventId);
    if (existing) clearTimeout(existing);
    if (delayMs <= 0) {
      this.timers.delete(eventId);
      this.queue.push(eventId);
      this._drain();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(eventId);
      this.queue.push(eventId);
      this._drain();
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(eventId, timer);
  }

  _drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const eventId = this.queue.shift();
      this.running += 1;
      this._run(eventId)
        .catch((error) => logger.error('queue worker crashed', { eventId, error }))
        .finally(() => {
          this.running -= 1;
          this._drain();
          this._checkIdle();
        });
    }
    this._checkIdle();
  }

  async _run(eventId) {
    const record = this.store.get(eventId);
    if (!record) {
      logger.warn('queued event vanished from the store', { eventId });
      return;
    }

    const attempt = record.attempts + 1;
    this.store.update(eventId, { status: 'processing', attempts: attempt, nextAttemptAt: null });

    try {
      const result = await this.worker(record);
      this.store.update(eventId, { status: 'succeeded', result, error: null });
      logger.info('event processed', { eventId, eventName: record.eventName, attempt, result: summarise(result) });
    } catch (error) {
      const payload = error?.toJSON ? error.toJSON() : { message: String(error?.message ?? error), kind: 'unknown' };
      const retryable = error?.retryable === true;
      const exhausted = attempt >= this.maxAttempts;

      if (!retryable || exhausted) {
        this.store.update(eventId, {
          status: 'failed',
          error: {
            ...payload,
            attempts: attempt,
            summary: exhausted && retryable
              ? `${payload.message} Gave up after ${attempt} attempts.`
              : payload.message,
          },
        });
        logger.error('event failed', { eventId, eventName: record.eventName, attempt, error });
        return;
      }

      const delaySeconds = this.backoffSeconds[Math.min(attempt - 1, this.backoffSeconds.length - 1)];
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      this.store.update(eventId, {
        status: 'retrying',
        error: { ...payload, attempts: attempt, summary: `${payload.message} Retrying in ${delaySeconds}s.` },
        nextAttemptAt,
      });
      logger.warn('event will be retried', { eventId, attempt, delaySeconds, error: payload.message });
      this.schedule(eventId, delaySeconds * 1000);
    }
  }

  _checkIdle() {
    if (this.running === 0 && this.queue.length === 0 && this.idleWaiters.length) {
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  /** Test helper: resolves once nothing is running or waiting to run. */
  async onIdle() {
    if (this.running === 0 && this.queue.length === 0) return;
    await new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queue.length = 0;
  }
}

function summarise(result) {
  if (!result) return null;
  const { contactId, opportunityId, fieldsWritten, contractFileUrl } = result;
  return { contactId, opportunityId, fieldsWritten, contractFileUrl: Boolean(contractFileUrl) };
}
