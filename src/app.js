import express from 'express';
import { config as defaultConfig, validateConfig } from './config.js';
import { logger } from './lib/logger.js';
import { IntegrationError } from './lib/errors.js';
import { PylonClient, verifyWebhookSignature } from './pylon.js';
import { GhlClient } from './ghl.js';
import { EventStore } from './store.js';
import { RetryQueue } from './queue.js';
import { Processor } from './processor.js';
import { createNotifier, buildSummary } from './callback.js';
import { loadMapping } from './mapping.js';

/**
 * Wires everything together and returns { app, store, queue, processor } so the
 * tests can drive the same object graph the server runs.
 */
export function createApp({ config = defaultConfig, skipValidation = false } = {}) {
  if (!skipValidation) {
    const problems = validateConfig(config);
    if (problems.length) {
      throw new IntegrationError(`Configuration is incomplete:\n - ${problems.join('\n - ')}`, {
        kind: 'config',
        system: 'bridge',
      });
    }
  }

  const mapping = loadMapping(config.mappingFile);
  const pylon = new PylonClient(config.pylon);
  const ghl = new GhlClient({ ...config.ghl, dryRun: config.dryRun });
  const store = new EventStore({ dataDir: config.dataDir, retentionDays: config.retentionDays });
  const processor = new Processor({ config, pylon, ghl, mapping });
  const notify = createNotifier(config.callback);

  const queue = new RetryQueue({
    store,
    maxAttempts: config.queue.maxAttempts,
    backoffSeconds: config.queue.backoffSeconds,
    concurrency: config.queue.concurrency,
    worker: async (record) => {
      const result = await processor.handle(record);
      return result;
    },
  });

  // Fire the success/failure callback whenever an event reaches a final state.
  const originalUpdate = store.update.bind(store);
  store.update = (id, changes) => {
    const record = originalUpdate(id, changes);
    if (record && ['succeeded', 'failed'].includes(record.status)) {
      notify(record).catch(() => {});
    }
    return record;
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // ------------------------------------------------------------- webhook

  // express.raw is required: the HMAC is computed over the exact bytes Pylon
  // sent, so the body must not be re-serialised before verification.
  app.post('/webhooks/pylon', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');

    const verification = verifyWebhookSignature({
      rawBody,
      headers: req.headers,
      secret: config.pylon.webhookSecret,
      toleranceSeconds: config.pylon.toleranceSeconds,
    });

    if (!verification.ok) {
      logger.warn('rejected webhook', { reason: verification.reason, ip: req.ip });
      return res.status(401).json({ ok: false, error: verification.reason });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'Request body is not valid JSON.' });
    }

    const eventId = parsed?.data?.id ?? null;
    const eventName = parsed?.data?.attributes?.name ?? null;

    const { record, duplicate } = store.record({ eventId, eventName, rawBody, headers: req.headers });
    if (duplicate) {
      logger.info('duplicate delivery ignored', { eventId, eventName, status: record.status });
      return res.status(200).json({ ok: true, eventId: record.id, status: record.status, duplicate: true });
    }

    queue.enqueue(record.id);

    // 202 immediately: Pylon gives us 10 seconds, and downloading + re-uploading
    // a contract PDF can take longer than that. Anything that fails after this
    // point is retried by our own queue, not by Pylon.
    return res.status(202).json({ ok: true, eventId: record.id, eventName, status: 'accepted' });
  });

  app.use(express.json({ limit: '1mb' }));

  // -------------------------------------------------------------- health

  app.get('/health', async (req, res) => {
    const body = {
      ok: true,
      service: 'pylon-ghl-bridge',
      uptimeSeconds: Math.round(process.uptime()),
      dryRun: config.dryRun,
      events: store.stats(),
    };

    if (req.query.deep === '1') {
      if (!isAuthorised(req, config)) return res.status(401).json({ ok: false, error: 'Admin token required for a deep health check.' });
      const checks = {};
      checks.pylon = await probe(() => pylon.ping());
      checks.goHighLevel = await probe(() => ghl.ping());
      checks.pipeline = await probe(async () => {
        const targets = await processor.resolveTargets({ fresh: true });
        return { pipeline: targets.pipeline.name, signedStage: targets.signedStage?.name, paidStage: targets.paidStage?.name ?? null };
      });
      body.checks = checks;
      body.ok = Object.values(checks).every((c) => c.ok);
      return res.status(body.ok ? 200 : 503).json(body);
    }

    return res.json(body);
  });

  // -------------------------------------------------------------- events

  app.get('/events', requireAdmin(config), (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 500);
    const records = store.list({ limit, status: req.query.status });
    res.json({
      ok: true,
      stats: store.stats(),
      events: records.map(buildSummary),
    });
  });

  app.get('/events/:id', requireAdmin(config), (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: `No event with id ${req.params.id}.` });
    res.json({ ok: true, event: record });
  });

  app.post('/events/:id/replay', requireAdmin(config), (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: `No event with id ${req.params.id}.` });
    store.update(record.id, { status: 'received', attempts: 0, error: null, nextAttemptAt: null });
    queue.enqueue(record.id);
    res.status(202).json({ ok: true, eventId: record.id, status: 'requeued' });
  });

  // ------------------------------------------------------------- mapping

  /**
   * Returns the mapping as configured AND as resolved against the live GHL
   * account — i.e. exactly which field id each line will write to, and which
   * lines point at a field that does not exist. This is the field-mapping guide
   * in live form.
   */
  app.get('/mapping', requireAdmin(config), async (req, res, next) => {
    try {
      const index = await processor.fieldIndex({ fresh: req.query.fresh === '1' });
      const resolved = {};
      for (const [eventName, section] of Object.entries(processor.mapping.events)) {
        resolved[eventName] = {
          contact: describe(section.contact?.customFields, index, 'contact'),
          opportunity: describe(section.opportunity?.customFields, index, 'opportunity'),
        };
      }
      res.json({
        ok: true,
        mappingFile: config.mappingFile,
        availableFields: index.all.map((f) => ({ id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType, model: f.model })),
        resolved,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/mapping/reload', requireAdmin(config), (req, res, next) => {
    try {
      processor.setMapping(loadMapping(config.mappingFile));
      ghl.clearCache();
      processor._targets = null;
      res.json({ ok: true, reloaded: config.mappingFile });
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'pylon-ghl-bridge',
      webhookPath: '/webhooks/pylon',
      docs: 'See README.md and docs/FIELD-MAPPING.md',
    });
  });

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    logger.error('request failed', { error });
    const payload = error instanceof IntegrationError ? error.toJSON() : { message: String(error?.message ?? error) };
    res.status(500).json({ ok: false, error: payload.message, detail: payload });
  });

  return { app, store, queue, processor, pylon, ghl, config, notify };
}

function describe(mappingFields = {}, index, model) {
  return Object.entries(mappingFields).map(([reference, template]) => {
    const field = index.lookup(reference, model);
    return {
      mappingKey: reference,
      template,
      resolved: Boolean(field),
      fieldId: field?.id ?? null,
      fieldName: field?.name ?? null,
      dataType: field?.dataType ?? null,
    };
  });
}

function isAuthorised(req, config) {
  if (!config.adminToken) return false;
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = bearer || req.get('x-admin-token') || req.query.token || '';
  return provided === config.adminToken;
}

function requireAdmin(config) {
  return (req, res, next) => {
    if (!config.adminToken) {
      return res.status(503).json({
        ok: false,
        error: 'ADMIN_TOKEN is not set on this server, so the inspection endpoints are disabled.',
      });
    }
    if (!isAuthorised(req, config)) {
      return res.status(401).json({ ok: false, error: 'Provide the admin token as "Authorization: Bearer <token>".' });
    }
    return next();
  };
}

async function probe(fn) {
  try {
    const detail = await fn();
    return { ok: true, ...(detail && typeof detail === 'object' ? { detail } : {}) };
  } catch (error) {
    const payload = error instanceof IntegrationError ? error.toJSON() : { message: String(error?.message ?? error) };
    return { ok: false, error: payload.message, kind: payload.kind };
  }
}
