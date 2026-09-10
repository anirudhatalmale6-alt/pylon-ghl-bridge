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
 * The real shape, taken from Formbay's own test ping on 11 September 2026:
 *
 *   { "version": 1,
 *     "event_id": "8e6af8df-1088-4e70-b337-72451c2fd7c3",
 *     "event": "webhook.test",
 *     "formid": 0,
 *     "ftype": "pv",
 *     "timestamp": "2026-09-10T23:04:41+00:00",
 *     "test": true }
 *
 * `ftype` + `formid` is the number the business actually uses: ftype "pv" with
 * formid 1272458 is the PV1272458 written in their tracker, and "bstc" with
 * 238207 is BSTC238207 — the same key the Formbay payment advice prints. That
 * is what joins a delivery to a row, so it is built here rather than guessed at
 * later. `event_id` is kept because Formbay may redeliver.
 *
 * The older `job.*` guesses are retained as fallbacks: the test ping is the only
 * real payload seen so far, and a job.updated may well carry more.
 */
export function describe(body) {
  const event = body?.event ?? body?.type ?? body?.name ?? null;
  const job = body?.job ?? body?.data?.job ?? body?.data ?? null;
  return {
    event,
    isTest: event === TEST_EVENT || body?.test === true,
    eventId: body?.event_id ?? null,
    version: body?.version ?? null,
    occurredAt: body?.timestamp ?? null,
    formId: body?.formid ?? job?.id ?? job?.job_id ?? body?.job_id ?? null,
    formType: body?.ftype ?? null,
    formbayNumber: formbayNumber(body) ?? job?.number ?? job?.formbay_number ?? job?.reference ?? null,
    status: job?.status ?? body?.status ?? null,
  };
}

/**
 * "pv" + 1272458 -> "PV1272458". A formid of 0 is the test ping, which refers to
 * no job at all, so it deliberately yields null rather than a plausible-looking
 * "PV0" that would match nothing and look like real data in the log.
 */
export function formbayNumber(body) {
  const type = body?.ftype;
  const id = body?.formid;
  if (!type || id === null || id === undefined) return null;
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${String(type).toUpperCase()}${numeric}`;
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
