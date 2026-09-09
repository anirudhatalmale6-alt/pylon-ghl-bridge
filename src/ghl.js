import crypto from 'node:crypto';
import { buildUrl, requestJson } from './lib/http.js';
import { IntegrationError } from './lib/errors.js';
import { logger } from './lib/logger.js';

/**
 * GoHighLevel (LeadConnector) API v2 client.
 *
 * Base URL:  https://services.leadconnectorhq.com
 * Auth:      Authorization: Bearer <Private Integration Token>
 * Version:   Version: 2021-07-28   (required on every call)
 *
 * Only the endpoints this bridge needs are wrapped. Each method notes the
 * documented route so the mapping guide can point at it.
 */

/**
 * The Invoices API is versioned separately from the rest of v2. Every other
 * endpoint takes 2021-07-28; invoices take this.
 */
const INVOICE_API_VERSION = '2021-04-15';

export class GhlClient {
  constructor({ apiBase, apiToken, apiVersion, locationId, timeoutMs = 30000, dryRun = false }) {
    this.apiBase = apiBase;
    this.apiToken = apiToken;
    this.apiVersion = apiVersion;
    this.locationId = locationId;
    this.timeoutMs = timeoutMs;
    this.dryRun = dryRun;
    this._cache = new Map();
  }

  headers(extra = {}) {
    if (!this.apiToken) {
      throw new IntegrationError('GHL_API_TOKEN is not configured, so GoHighLevel cannot be reached.', {
        kind: 'config',
        system: 'GoHighLevel',
      });
    }
    return {
      Authorization: `Bearer ${this.apiToken}`,
      Version: this.apiVersion,
      Accept: 'application/json',
      ...extra,
    };
  }

  async request(method, pathname, { query, body, headers, timeoutMs } = {}) {
    const url = buildUrl(this.apiBase, pathname, query);
    const isWrite = method !== 'GET';
    if (this.dryRun && isWrite) {
      logger.info('DRY_RUN: skipping GoHighLevel write', { method, pathname, body });
      return { dryRun: true, method, pathname, body };
    }
    const { data } = await requestJson({
      system: 'GoHighLevel',
      method,
      url,
      headers: this.headers(headers),
      body,
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    return data;
  }

  async requestJsonBody(method, pathname, bodyObject, options = {}) {
    return this.request(method, pathname, {
      ...options,
      body: JSON.stringify(bodyObject),
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  }

  // ---------------------------------------------------------------- invoices

  /**
   * POST /invoices/
   *
   * NOTE: the Invoices API is versioned separately from the rest of v2 — it
   * wants `Version: 2021-04-15`, not `2021-07-28`. Sending the wrong one is a
   * confusing failure, so it is pinned here rather than left to config.
   *
   * Requires the `invoices.write` scope on the Private Integration Token. That
   * scope is NOT included by default; without it every call returns
   * 401 "The token is not authorized for this scope."
   */
  async createInvoice(payload) {
    const data = await this.requestJsonBody(
      'POST',
      '/invoices/',
      { altId: this.locationId, altType: 'location', ...payload },
      { headers: { Version: INVOICE_API_VERSION } },
    );
    if (data?.dryRun) return { _id: 'dry-run-invoice', dryRun: true };
    const invoice = data?.invoice ?? data;
    if (!invoice?._id && !invoice?.id) {
      throw new IntegrationError('GoHighLevel accepted the invoice but returned no invoice id.', {
        kind: 'unexpected_response',
        system: 'GoHighLevel',
        detail: { data },
      });
    }
    return invoice;
  }

  /**
   * POST /invoices/{id}/send
   * `action` is one of sms_and_email | email | sms | send_manually.
   * `send_manually` marks it sent without contacting the customer — that is the
   * default here, because auto-emailing a customer the moment they sign is a
   * decision for the business to make deliberately.
   */
  async sendInvoice(invoiceId, { action = 'send_manually', userId, liveMode = true } = {}) {
    return this.requestJsonBody(
      'POST',
      `/invoices/${encodeURIComponent(invoiceId)}/send`,
      { altId: this.locationId, altType: 'location', action, liveMode, ...(userId ? { userId } : {}) },
      { headers: { Version: INVOICE_API_VERSION } },
    );
  }

  // ---------------------------------------------------------------- metadata

  /** GET /locations/{id} — used to fill an invoice's businessDetails. */
  async getLocation({ fresh = false } = {}) {
    const key = 'location';
    if (!fresh && this._cache.has(key)) return this._cache.get(key);
    const data = await this.request('GET', `/locations/${encodeURIComponent(this.locationId)}`);
    const location = data?.location ?? data;
    this._cache.set(key, location);
    return location;
  }

  /** GET /locations/{locationId}/customFields?model=contact|opportunity|all */
  async listCustomFields(model = 'all', { fresh = false } = {}) {
    const key = `customFields:${model}`;
    if (!fresh && this._cache.has(key)) return this._cache.get(key);
    const data = await this.request('GET', `/locations/${this.locationId}/customFields`, {
      query: { model },
    });
    const fields = data?.customFields ?? [];
    this._cache.set(key, fields);
    return fields;
  }

  /** POST /locations/{locationId}/customFields */
  async createCustomField({ name, dataType, model, placeholder, position, acceptedFormat, isMultipleFile, maxNumberOfFiles }) {
    const body = { name, dataType, model };
    if (placeholder !== undefined) body.placeholder = placeholder;
    if (position !== undefined) body.position = position;
    if (acceptedFormat !== undefined) body.acceptedFormat = acceptedFormat;
    if (isMultipleFile !== undefined) body.isMultipleFile = isMultipleFile;
    if (maxNumberOfFiles !== undefined) body.maxNumberOfFiles = maxNumberOfFiles;
    this._cache.clear();
    return this.requestJsonBody('POST', `/locations/${this.locationId}/customFields`, body);
  }

  /** GET /opportunities/pipelines?locationId= */
  async listPipelines({ fresh = false } = {}) {
    if (!fresh && this._cache.has('pipelines')) return this._cache.get('pipelines');
    const data = await this.request('GET', '/opportunities/pipelines', {
      query: { locationId: this.locationId },
    });
    const pipelines = data?.pipelines ?? [];
    this._cache.set('pipelines', pipelines);
    return pipelines;
  }

  clearCache() {
    this._cache.clear();
  }

  // ---------------------------------------------------------------- contacts

  /**
   * POST /contacts/upsert — matches on email/phone within the location, so
   * repeated signatures for the same customer update one record instead of
   * creating duplicates.
   */
  async upsertContact(payload) {
    const body = { locationId: this.locationId, ...payload };
    const data = await this.requestJsonBody('POST', '/contacts/upsert', body);
    if (data?.dryRun) return { id: 'dry-run-contact', dryRun: true };
    const contact = data?.contact ?? data;
    if (!contact?.id) {
      throw new IntegrationError('GoHighLevel accepted the contact upsert but returned no contact id.', {
        kind: 'unexpected_response',
        system: 'GoHighLevel',
        detail: { data },
      });
    }
    return contact;
  }

  /**
   * PUT /contacts/{id} — used when the contact id is already known (a payment
   * matched to an earlier signature) and there is no email to upsert on.
   * locationId is deliberately not sent: this endpoint rejects it.
   */
  async updateContact(id, payload) {
    const data = await this.requestJsonBody('PUT', `/contacts/${encodeURIComponent(id)}`, payload);
    if (data?.dryRun) return { id, dryRun: true };
    return data?.contact ?? data;
  }

  /**
   * POST /contacts/{id}/tags — adds tags without touching the ones already
   * there. PUT /contacts/{id} with a `tags` array REPLACES the whole list, which
   * would quietly wipe whatever else the CRM had on the record.
   */
  async addContactTags(id, tags) {
    if (!tags?.length) return null;
    return this.requestJsonBody('POST', `/contacts/${encodeURIComponent(id)}/tags`, { tags });
  }

  /** GET /contacts/{id} */
  async getContact(id) {
    const data = await this.request('GET', `/contacts/${encodeURIComponent(id)}`);
    return data?.contact ?? data;
  }

  /** POST /contacts/{contactId}/notes */
  async createContactNote(contactId, body) {
    return this.requestJsonBody('POST', `/contacts/${encodeURIComponent(contactId)}/notes`, { body });
  }

  // ----------------------------------------------------------- opportunities

  /**
   * GET /opportunities/search
   * NOTE: this endpoint uses snake_case query params (location_id, contact_id,
   * pipeline_id) while the rest of the v2 API uses camelCase.
   */
  async searchOpportunities({ contactId, pipelineId, pipelineStageId, status = 'all', q, limit = 20 } = {}) {
    const data = await this.request('GET', '/opportunities/search', {
      query: {
        location_id: this.locationId,
        contact_id: contactId,
        pipeline_id: pipelineId,
        pipeline_stage_id: pipelineStageId,
        status,
        q,
        limit,
      },
    });
    return data?.opportunities ?? [];
  }

  /** POST /opportunities/ */
  async createOpportunity(payload) {
    const data = await this.requestJsonBody('POST', '/opportunities/', {
      locationId: this.locationId,
      ...payload,
    });
    if (data?.dryRun) return { id: 'dry-run-opportunity', dryRun: true };
    const opportunity = data?.opportunity ?? data;
    if (!opportunity?.id) {
      throw new IntegrationError('GoHighLevel accepted the opportunity create but returned no opportunity id.', {
        kind: 'unexpected_response',
        system: 'GoHighLevel',
        detail: { data },
      });
    }
    return opportunity;
  }

  /** PUT /opportunities/{id} */
  async updateOpportunity(id, payload) {
    const data = await this.requestJsonBody('PUT', `/opportunities/${encodeURIComponent(id)}`, payload);
    if (data?.dryRun) return { id, dryRun: true };
    return data?.opportunity ?? data;
  }

  // -------------------------------------------------------------------- files

  /**
   * POST /medias/upload-file (multipart)
   * Puts the signed contract in the location's media library and returns a URL
   * that does not expire — unlike the one-hour Pylon link.
   */
  async uploadMedia({ buffer, filename, contentType = 'application/pdf', parentId }) {
    if (this.dryRun) {
      logger.info('DRY_RUN: skipping media upload', { filename, bytes: buffer?.length });
      return { fileId: 'dry-run-file', url: `https://example.invalid/dry-run/${filename}`, dryRun: true };
    }
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), filename);
    form.append('name', filename);
    form.append('hosted', 'false');
    if (parentId) form.append('parentId', parentId);

    const { data } = await requestJson({
      system: 'GoHighLevel',
      method: 'POST',
      url: buildUrl(this.apiBase, '/medias/upload-file', { altId: this.locationId, altType: 'location' }),
      headers: this.headers(),
      body: form,
      timeoutMs: this.timeoutMs,
    });
    return data;
  }

  /**
   * POST /forms/upload-custom-files?contactId=&locationId=  (multipart)
   * The form field NAME carries the routing information: `<customFieldId>_<uuid>`.
   * This is how a real file (not just a link) gets attached to a contact record.
   */
  async uploadContactCustomFile({ contactId, customFieldId, buffer, filename, contentType = 'application/pdf' }) {
    if (this.dryRun) {
      logger.info('DRY_RUN: skipping contact file upload', { contactId, customFieldId, filename });
      return { dryRun: true };
    }
    const form = new FormData();
    const fieldName = `${customFieldId}_${crypto.randomUUID()}`;
    form.append(fieldName, new Blob([buffer], { type: contentType }), filename);

    const { data } = await requestJson({
      system: 'GoHighLevel',
      method: 'POST',
      url: buildUrl(this.apiBase, '/forms/upload-custom-files', {
        contactId,
        locationId: this.locationId,
      }),
      headers: this.headers(),
      body: form,
      timeoutMs: this.timeoutMs,
    });
    return data;
  }

  /** Lightweight credential check used by GET /health?deep=1. */
  async ping() {
    await this.listCustomFields('all', { fresh: true });
    return true;
  }
}
