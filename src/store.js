import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './lib/logger.js';

/**
 * A small append-only store on disk. No database on purpose: the volume here is
 * a handful of events a day, and a JSONL file is something the client can read,
 * grep and hand to support without any tooling.
 *
 *   data/events.jsonl   one line per delivery, appended on every state change
 *   data/state.json     current state of every event (survives a restart)
 */
export class EventStore {
  constructor({ dataDir, retentionDays = 90 }) {
    this.dataDir = dataDir;
    this.retentionDays = retentionDays;
    this.logFile = path.join(dataDir, 'events.jsonl');
    this.stateFile = path.join(dataDir, 'state.json');
    this.state = new Map();
    // Pylon solar_project id -> { contactId, opportunityId, ... }, written when
    // a contract is signed. A later gateway_payments.created event carries the
    // same project id but no customer details, so without an API token this is
    // the only way to work out whose payment it is.
    this.links = new Map();
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const record of parsed.records ?? []) this.state.set(record.id, record);
      for (const [key, value] of Object.entries(parsed.links ?? {})) this.links.set(key, value);
      logger.info('event state restored', { records: this.state.size, links: this.links.size });
    } catch (error) {
      logger.error('could not read state file, starting empty', { error, file: this.stateFile });
    }
  }

  /** Remembers which GoHighLevel records a Pylon project ended up in. */
  linkProject(pylonProjectId, details) {
    if (!pylonProjectId) return;
    const existing = this.links.get(pylonProjectId) ?? {};
    this.links.set(pylonProjectId, { ...existing, ...details, updatedAt: new Date().toISOString() });
    this._persist();
  }

  lookupProject(pylonProjectId) {
    if (!pylonProjectId) return null;
    return this.links.get(pylonProjectId) ?? null;
  }

  _persist() {
    const records = [...this.state.values()];
    const cutoff = Date.now() - this.retentionDays * 86400000;
    const kept = records.filter((r) => new Date(r.receivedAt).getTime() >= cutoff || r.status !== 'succeeded');
    if (kept.length !== records.length) {
      this.state = new Map(kept.map((r) => [r.id, r]));
    }
    const tmp = `${this.stateFile}.tmp`;
    // The links map is deliberately NOT aged out with the events: a deposit can
    // land months after the contract is signed and still needs to find its way
    // to the right opportunity.
    fs.writeFileSync(tmp, JSON.stringify({ records: kept, links: Object.fromEntries(this.links) }, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  _append(entry) {
    fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
  }

  /**
   * Records an inbound webhook. Returns { record, duplicate } — Pylon retries up
   * to five times over 31 hours, so the same event id will legitimately arrive
   * more than once and must not be processed twice.
   */
  record({ eventId, eventName, rawBody, headers }) {
    const id = eventId || `anon-${crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 16)}`;
    const existing = this.state.get(id);
    if (existing && ['succeeded', 'processing'].includes(existing.status)) {
      return { record: existing, duplicate: true };
    }

    const record = existing ?? {
      id,
      eventName,
      status: 'received',
      attempts: 0,
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: safeParse(rawBody),
      deliveries: [],
      result: null,
      error: null,
      nextAttemptAt: null,
      pylonDeliveryHeaders: {
        timestamp: headers?.['pylon-webhook-timestamp'] ?? null,
        version: headers?.['pylon-webhook-version'] ?? null,
      },
    };
    record.eventName = eventName || record.eventName;
    record.status = 'received';
    record.updatedAt = new Date().toISOString();
    this.state.set(id, record);
    this._append({ at: record.updatedAt, id, event: 'received', eventName });
    this._persist();
    return { record, duplicate: false };
  }

  update(id, changes) {
    const record = this.state.get(id);
    if (!record) return null;
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    this.state.set(id, record);
    this._append({
      at: record.updatedAt,
      id,
      event: changes.status ?? 'updated',
      attempts: record.attempts,
      error: record.error?.message ?? null,
      result: summariseResult(record.result),
    });
    this._persist();
    return record;
  }

  get(id) {
    return this.state.get(id) ?? null;
  }

  list({ limit = 50, status } = {}) {
    let records = [...this.state.values()];
    if (status) records = records.filter((r) => r.status === status);
    records.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    return records.slice(0, limit);
  }

  /** Jobs that were mid-flight when the process stopped, so they can resume. */
  pending() {
    return [...this.state.values()].filter((r) => ['received', 'processing', 'retrying'].includes(r.status));
  }

  stats() {
    const counts = {};
    for (const record of this.state.values()) {
      counts[record.status] = (counts[record.status] ?? 0) + 1;
    }
    return { total: this.state.size, byStatus: counts };
  }
}

function safeParse(rawBody) {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { unparsed: rawBody.toString('utf8').slice(0, 2000) };
  }
}

function summariseResult(result) {
  if (!result) return null;
  return {
    contactId: result.contactId,
    opportunityId: result.opportunityId,
    fieldsWritten: result.fieldsWritten,
    contractUploaded: Boolean(result.contractFileUrl),
  };
}
