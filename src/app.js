import express from 'express';
import { config as defaultConfig, configWarnings, enrichmentEnabled, validateConfig } from './config.js';
import { logger } from './lib/logger.js';
import { IntegrationError } from './lib/errors.js';
import { PylonClient, verifyWebhookSignature } from './pylon.js';
import { GhlClient } from './ghl.js';
import { EventStore } from './store.js';
import { RetryQueue } from './queue.js';
import { Processor, SIGNED_EVENT, CONTRACT_INVOICE_KEY } from './processor.js';
import { createNotifier, buildSummary } from './callback.js';
import { loadMapping } from './mapping.js';
import { FormbayLog, describe as describeFormbayEvent, presentedToken, tokenMatches } from './formbay.js';
import { FormbayClient } from './formbay-api.js';
import { Tracker, renderPage, referencesFromCsv } from './tracker.js';
import { XeroClient } from './xero.js';

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
  // Before the processor, which takes it as a dependency.
  const xero = new XeroClient({ ...config.xero, dataDir: config.dataDir });
  const processor = new Processor({ config, pylon, ghl, mapping, store, xero });
  const notify = createNotifier(config.callback);
  const formbayLog = new FormbayLog({ dataDir: config.dataDir });
  const tracker = new Tracker({ dataDir: config.dataDir, client: new FormbayClient(config.formbay) });

  for (const warning of configWarnings(config)) logger.warn(warning);
  for (const warning of mapping.warnings ?? []) logger.warn(warning);

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

  // ----------------------------------------------------- formbay webhook

  // Formbay sends a `webhook.test` ping and only creates the webhook if we
  // answer 2xx, so this route has to be live BEFORE the webhook can be
  // configured. It records and acknowledges; it writes nothing to GoHighLevel.
  app.post('/webhooks/formbay', (req, res) => {
    const expected = config.formbay.webhookToken;
    if (!expected) {
      logger.warn('formbay webhook rejected: FORMBAY_WEBHOOK_TOKEN is not set', { ip: req.ip });
      return res.status(401).json({
        ok: false,
        error: 'This endpoint is not configured yet. Set FORMBAY_WEBHOOK_TOKEN on the service first.',
      });
    }
    if (!tokenMatches(presentedToken(req, config.formbay.webhookHeader), expected)) {
      logger.warn('formbay webhook rejected: bad or missing token', { ip: req.ip });
      return res.status(401).json({ ok: false, error: 'Missing or incorrect webhook token.' });
    }

    const summary = describeFormbayEvent(req.body);
    const record = formbayLog.append({ ...summary, body: req.body });
    logger.info('formbay webhook received', {
      id: record.id,
      event: summary.event,
      jobId: summary.jobId,
      formbayNumber: summary.formbayNumber,
    });

    // 200 rather than 202: Formbay's save flow checks for a 2xx on the test ping.
    return res.status(200).json({ ok: true, id: record.id, event: summary.event, test: summary.isTest });
  });

  app.get('/formbay/events', requireAdmin(config), (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 500);
    res.json({ ok: true, ...formbayLog.stats(), events: formbayLog.list({ limit }) });
  });

  // ------------------------------------------------------------- tracker

  /**
   * The STC tracker as a page.
   *
   * Authenticated by the admin token in the query string rather than a header,
   * because the point of it is a link the client can open and bookmark. That is
   * a deliberate trade: the token ends up in browser history, so it is the same
   * token that already guards the read-only endpoints, not a customer's data.
   */
  app.get('/tracker', (req, res) => {
    if (!isAuthorised(req, config)) {
      return res.status(401).type('html').send('<p>Add ?token=… to this address to see the tracker.</p>');
    }
    const { jobs } = tracker.read();
    res.type('html').send(
      renderPage({
        summary: tracker.summary(),
        jobs,
        token: req.query.token ?? '',
        status: req.query.status ? String(req.query.status) : null,
      }),
    );
  });

  app.get('/tracker/summary', requireAdmin(config), (req, res) => res.json({ ok: true, ...tracker.summary() }));

  app.post('/tracker/refresh', requireAdmin(config), async (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || null;
    try {
      const result = await tracker.refresh({ limit });
      // A browser posting the form wants the page back, not JSON.
      if ((req.headers.accept ?? '').includes('text/html')) {
        return res.redirect(`/tracker?token=${encodeURIComponent(req.query.token ?? '')}`);
      }
      return res.json({ ok: true, ...result });
    } catch (error) {
      logger.error('tracker refresh failed', { error });
      return res.status(502).json({ ok: false, error: error.message });
    }
  });

  /** Seeds the job list from the spreadsheet, since Formbay will not list jobs. */
  app.post('/tracker/seed', requireAdmin(config), express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
    const { references, skipped, error } = referencesFromCsv(req.body ?? '');
    if (error) return res.status(400).json({ ok: false, error });
    const added = tracker.add(references);
    return res.json({ ok: true, ...added, skipped });
  });

  // ---------------------------------------------------------------- xero

  /**
   * Starts the Xero consent flow. Opened once, by a human, in a browser.
   *
   * Guarded by the admin token: anyone who reached this could otherwise bind the
   * service to THEIR Xero organisation and start writing invoices into it.
   */
  app.get('/xero/connect', requireAdmin(config), (req, res) => {
    if (!xero.configured) {
      return res.status(503).json({
        ok: false,
        error: 'Xero is not configured. Set XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI first.',
      });
    }
    // A custom connection has no consent screen to send anybody to: it is
    // authorised from the email Xero sends the nominated user. Saying so beats
    // redirecting to a Xero page that will only refuse.
    if (xero.usesClientCredentials) {
      return res.status(400).json({
        ok: false,
        error: 'This is a Xero custom connection, which is authorised from the email Xero sends the nominated user, not from here. Check /xero/status to see whether that has been done.',
      });
    }
    const { url, state } = xero.authorizeUrl();
    // Remembered so the callback can prove the response belongs to this request.
    xero.write({ ...(xero.read() ?? {}), pendingState: state });
    return res.redirect(url);
  });

  app.get('/xero/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).type('html').send(`<p>Xero refused the connection: ${String(error)}</p>`);
    if (!code) return res.status(400).type('html').send('<p>Xero sent no authorisation code.</p>');

    const expected = xero.read()?.pendingState;
    if (!expected || state !== expected) {
      logger.warn('xero callback state mismatch', { ip: req.ip });
      return res.status(400).type('html').send('<p>That link did not come from the connect page. Start again at /xero/connect.</p>');
    }

    try {
      await xero.exchangeCode(String(code));
      const tenantId = await xero.tenantId();
      const { tenantName } = xero.read() ?? {};
      logger.info('xero connected', { tenantId, tenantName });
      return res.type('html').send(`<p>Connected to <strong>${String(tenantName ?? tenantId)}</strong>. You can close this tab.</p>`);
    } catch (err) {
      logger.error('xero connection failed', { error: err });
      return res.status(502).type('html').send(`<p>Could not complete the connection: ${err.message}</p>`);
    }
  });

  app.get('/xero/status', requireAdmin(config), async (req, res) => {
    const stored = xero.read();
    const body = {
      ok: true,
      configured: xero.configured,
      authMode: config.xero.authMode,
      connected: xero.connected,
      writingInvoices: config.xero.enabled,
      invoiceStatus: config.xero.invoiceStatus,
      organisation: stored?.tenantName ?? null,
      // Never the tokens themselves.
      tokenUpdatedAt: stored?.updatedAt ?? null,
    };

    /**
     * `?check=1` asks Xero rather than reporting what we last wrote down.
     *
     * Kept opt-in because it is two HTTP calls, but it is the only answer worth
     * having before switching invoicing on: credentials that mint a token
     * happily still reach nothing until the connection is authorised.
     */
    if (req.query.check && xero.configured) {
      try {
        const org = await xero.organisation();
        body.live = { reachable: true, organisation: org?.name ?? null, isDemoCompany: org?.isDemoCompany ?? null };
        // Read-only, and the answer decides whether the rebate lines can be
        // GST-free at all.
        try {
          body.live.taxTypes = await xero.taxTypes();
        } catch (err) {
          body.live.taxTypes = { error: err.message };
        }
      } catch (err) {
        body.live = { reachable: false, error: err.message };
      }
    }

    return res.json(body);
  });

  // -------------------------------------------------------------- health

  app.get('/health', async (req, res) => {
    const body = {
      ok: true,
      service: 'pylon-ghl-bridge',
      commit: config.commit,
      uptimeSeconds: Math.round(process.uptime()),
      dryRun: config.dryRun,
      mode: enrichmentEnabled(config) ? 'full' : 'webhook-only',
      warnings: [...configWarnings(config), ...(processor.mapping.warnings ?? [])],
      /**
       * How invoicing is configured right now. No secrets — just which way the
       * switches are set, so "did my change take effect?" is a URL anyone can
       * open rather than a question for me. Adding the running commit here paid
       * for itself several times over; this is the same idea.
       */
      invoicing: {
        enabled: config.ghl.createInvoice,
        mode: config.ghl.invoiceSingle ? 'one invoice per contract' : 'one invoice per payment stage',
        raisedAt: config.ghl.invoiceSingle && config.ghl.invoiceOnStage
          ? 'when the opportunity reaches the configured pipeline stage'
          : 'when the contract is signed',
        gst: config.ghl.invoiceTaxId
          ? `${config.ghl.invoiceTaxName} ${config.ghl.invoiceTaxRate}% (${config.ghl.invoiceTaxCalculation})`
          : 'NOT CONFIGURED - no invoice will be raised',
        sendAction: config.ghl.invoiceSendAction,
        logo: config.ghl.invoiceLogoUrl ? 'configured' : 'from the GoHighLevel location only',
      },
      events: store.stats(),
    };

    if (req.query.deep === '1') {
      if (!isAuthorised(req, config)) return res.status(401).json({ ok: false, error: 'Admin token required for a deep health check.' });
      const checks = {};
      // No Pylon token is a supported configuration, not a failure — say so
      // rather than reporting the whole service as unhealthy.
      checks.pylon = enrichmentEnabled(config)
        ? await probe(() => pylon.ping())
        : { ok: true, skipped: true, detail: 'No PYLON_API_TOKEN configured — running in webhook-only mode.' };
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

  // ------------------------------------------------------------ invoices

  /**
   * Raises the invoice for one payment stage on demand.
   *
   *   POST /invoices/pre_install
   *   { "opportunityId": "..." }      or { "contactId": ... } or { "reference": ... }
   *
   * This exists because only the deposit is triggered by Pylon — "before
   * installation" and "on the day" are decisions the business makes in the CRM.
   * Point a GoHighLevel workflow at this when the opportunity reaches the right
   * stage (Settings → Workflows → Webhook, with the admin token as a header).
   *
   * Safe to call twice: a stage already invoiced returns the existing invoice
   * rather than billing the customer again.
   */
  /**
   * The whole-contract invoice, raised when the opportunity reaches the agreed
   * pipeline stage rather than at signature.
   *
   * Driven by a GoHighLevel workflow, which sends only a contact id. Everything
   * else is rebuilt from the figures frozen when the contract was signed — the
   * customer signed for those numbers, and re-reading Pylon days later could
   * invoice a total that has since been edited.
   */
  async function raiseContractInvoice(req, res) {
    const { projectId, opportunityId, contactId, reference } = identifiersFrom(req.body);
    if (!projectId && !opportunityId && !contactId && !reference) {
      return res.status(400).json({
        ok: false,
        error: 'Send one of projectId, opportunityId, contactId or reference so the contract can be identified.',
      });
    }

    const found = store.findLinkBy({ projectId: projectId || reference, opportunityId, contactId });
    if (!found) {
      return res.status(404).json({
        ok: false,
        error:
          'No signed contract is on record for that customer, so there is nothing to invoice. ' +
          'The contract has to have come through this bridge first.',
      });
    }

    const { projectId: linkedProjectId, link } = found;
    const basis = link.invoiceBasis;
    if (!basis) {
      return res.status(409).json({
        ok: false,
        error:
          'That contract was signed before the invoice figures started being recorded, so there is nothing to build ' +
          'an invoice from. Replay the signature event and try again.',
      });
    }

    const warnings = [];
    if (found.ambiguous) {
      warnings.push(
        `This customer has ${found.matchCount} signed jobs on record. The most recent one ` +
          `(${link.reference ?? linkedProjectId}) was invoiced. Send "reference" or "opportunityId" ` +
          'instead of "contactId" to pick a specific job.',
      );
    }

    // Rebuilt in the same shape normalize() produces, so raiseSingleInvoice
    // cannot tell the difference between this and a live signature.
    const payload = {
      project: { id: linkedProjectId, reference_number: link.reference ?? '' },
      client: {
        name: link.contactName ?? '',
        email: link.contactEmail ?? '',
        phone: link.contactPhone ?? '',
        phone_e164: basis.phoneE164 ?? '',
        address: { full: basis.addressFull ?? '' },
      },
      contract: {
        name: basis.name ?? '',
        description: basis.description ?? '',
        currency: link.currency ?? 'AUD',
        total_amount: link.contractTotal ?? null,
        total_amount_formatted: basis.totalAmountFormatted ?? null,
        total_tax_formatted: basis.totalTaxFormatted ?? null,
        line_items_summary: basis.lineItemsSummary ?? '',
        line_items_summary_html: basis.lineItemsSummaryHtml ?? '',
        rebates_summary: basis.rebatesSummary ?? '',
        rebate_lines: basis.rebateLines ?? [],
        rebate_lines_reconciled: basis.rebateLines ?? [],
        rebates_reconciled: basis.rebatesReconciled !== false,
        gross_inc_tax: basis.grossIncTax ?? null,
        tax_on_gross: basis.taxOnGross ?? null,
        net_of_tax: basis.netOfTax ?? null,
      },
    };

    try {
      const raised = await processor.raiseInvoices({
        mapping: processor.mapping.events[SIGNED_EVENT],
        payload,
        contactId: link.contactId,
        warnings,
        trigger: 'manual',
        only: CONTRACT_INVOICE_KEY,
      });
      const ok = raised.length > 0;
      return res.status(200).json({ ok, invoices: raised, warnings });
    } catch (error) {
      logger.error('contract invoice failed', { error, projectId: linkedProjectId });
      return res.status(502).json({ ok: false, error: error.message });
    }
  }

  app.post('/invoices/:stageKey', requireAdmin(config), express.json({ limit: '256kb' }), async (req, res) => {
    const { stageKey } = req.params;
    // "contract" is the whole-job invoice, not one of the payment stages. It is
    // raised when the opportunity reaches the agreed pipeline stage, from the
    // figures frozen at signature.
    if (stageKey === CONTRACT_INVOICE_KEY) return raiseContractInvoice(req, res);
    const { projectId, opportunityId, contactId, reference } = req.body ?? {};

    if (!projectId && !opportunityId && !contactId && !reference) {
      return res.status(400).json({
        ok: false,
        error: 'Send one of projectId, opportunityId, contactId or reference so the contract can be identified.',
      });
    }

    const found = store.findLinkBy({ projectId: projectId || reference, opportunityId, contactId });
    if (!found) {
      return res.status(404).json({
        ok: false,
        error:
          'No signed contract is on record for that customer, so there is nothing to invoice against. ' +
          'The contract has to have come through this bridge first.',
      });
    }

    const mapping = processor.mapping.events[SIGNED_EVENT];
    const stage = mapping?.invoices?.stages?.find((s) => s.key === stageKey);
    if (!stage) {
      const available = (mapping?.invoices?.stages ?? []).map((s) => s.key).join(', ') || '(none configured)';
      return res.status(404).json({ ok: false, error: `No payment stage called "${stageKey}". Configured stages: ${available}.` });
    }

    // Rebuild just enough of the signed payload for the invoice from what was
    // stored when the contract came through — no Pylon call needed.
    const warnings = [];
    const { projectId: linkedProjectId, link } = found;
    if (found.ambiguous) {
      warnings.push(
        `This customer has ${found.matchCount} signed jobs on record. The most recent one ` +
          `(${link.reference ?? linkedProjectId}) was invoiced. Send "reference" or "opportunityId" instead of ` +
          '"contactId" to pick a specific job.',
      );
    }
    const payload = {
      project: { id: linkedProjectId, reference_number: link.reference ?? linkedProjectId },
      client: { name: link.contactName ?? '', email: link.contactEmail ?? '', phone: link.contactPhone ?? '' },
      contract: { total_amount: link.contractTotal ?? null, currency: link.currency ?? '', title: '', description: '' },
    };

    try {
      const raised = await processor.raiseInvoices({
        mapping,
        payload,
        contactId: link.contactId,
        warnings,
        only: stageKey,
      });
      const ok = raised.length > 0 && warnings.length === 0;
      return res.status(ok ? 200 : 200).json({ ok, stage: stageKey, invoices: raised, warnings });
    } catch (error) {
      logger.error('manual invoice failed', { error, stageKey });
      return res.status(502).json({ ok: false, error: error.message });
    }
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

  return { app, store, queue, processor, pylon, ghl, config, notify, tracker, xero };
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

/**
 * Pulls the identifiers out of whatever the caller sent.
 *
 * A GoHighLevel workflow's webhook posts its own "standard data" using snake
 * case — `contact_id`, not `contactId` — and only sends a JSON body of your own
 * shape if someone remembers to add Custom Data items. Accepting both spellings
 * means the workflow works whether or not that step was done, which is worth it:
 * the failure it prevents is an invoice that never gets raised, discovered days
 * later by a customer who was never billed.
 */
export function identifiersFrom(body = {}) {
  const b = body ?? {};
  const custom = b.customData ?? b.custom_data ?? {};
  const pick = (...names) => {
    for (const source of [b, custom]) {
      for (const name of names) {
        const value = source?.[name];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
    }
    return undefined;
  };
  return {
    contactId: pick('contactId', 'contact_id', 'contactid'),
    opportunityId: pick('opportunityId', 'opportunity_id'),
    projectId: pick('projectId', 'project_id', 'pylonProjectId'),
    reference: pick('reference', 'referenceNumber', 'reference_number'),
  };
}
