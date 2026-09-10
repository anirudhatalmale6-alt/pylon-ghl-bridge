import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Formbay webhook receiver.
 *
 * Formbay's "Add New webhook" screen offers exactly four events —
 * job.created, job.updated, job.deleted and doc.updated — plus a webhook.test
 * ping. There is NO payment or remittance event, so this cannot be the source
 * of "we have been paid". It IS the source of "the STC value changed" and "the
 * job was sold", which is most of what the tracker needs.
 *
 * Deliberately inert: it authenticates, records, and acknowledges. It does not
 * write to GoHighLevel and cannot affect the invoice flow. Getting the endpoint
 * live is urgent because Formbay refuses to SAVE a webhook until the endpoint
 * answers its test ping with a 2xx — so the receiver has to exist before the
 * configuration can.
 */

export const FORMBAY_EVENTS = ['job.created', 'job.updated', 'job.deleted', 'doc.updated'];
export const TEST_EVENT = 'webhook.test';

/**
 * Constant-time comparison that treats an unset expectation as "deny".
 *
 * timingSafeEqual throws on length mismatch, and a plain === on two empty
 * strings is true — which would let an unconfigured service accept anything
 * that arrived. Both are refused here.
 */
export function tokenMatches(presented, expected) {
  if (!expected || !presented) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Pulls the shared secret out of wherever Formbay was told to put it. */
export function presentedToken(req, headerName) {
  const header = req.headers?.[String(headerName).toLowerCase()];
  if (header) return Array.isArray(header) ? header[0] : header;
  // Formbay's dialog also offers "Authenticate via query parameter".
  const q = req.query?.token;
  if (q) return Array.isArray(q) ? q[0] : q;
  const auth = req.headers?.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return null;
}

/**
 * Formbay has not published its payload shape to us yet, so nothing is assumed
 * beyond the event name. Every delivery is kept verbatim — when the first real
 * one lands, the recorded body is what tells us how to read it.
 */
export function describe(body) {
  const event = body?.event ?? body?.type ?? body?.name ?? null;
  const job = body?.job ?? body?.data?.job ?? body?.data ?? null;
  return {
    event,
    isTest: event === TEST_EVENT,
    jobId: job?.id ?? job?.job_id ?? body?.job_id ?? null,
    formbayNumber: job?.number ?? job?.formbay_number ?? job?.reference ?? null,
    status: job?.status ?? null,
  };
}

export class FormbayLog {
  constructor({ dataDir }) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'formbay-events.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  append(entry) {
    const record = { id: crypto.randomUUID(), receivedAt: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    return record;
  }

  list({ limit = 50 } = {}) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { error: 'unreadable line' };
        }
      });
  }

  stats() {
    const all = this.list({ limit: Number.MAX_SAFE_INTEGER });
    const byEvent = {};
    for (const entry of all) byEvent[entry.event ?? 'unknown'] = (byEvent[entry.event ?? 'unknown'] ?? 0) + 1;
    return { total: all.length, byEvent, lastReceivedAt: all[0]?.receivedAt ?? null };
  }
}
