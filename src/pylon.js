import crypto from 'node:crypto';
import { buildUrl, requestJson } from './lib/http.js';
import { IntegrationError, networkError } from './lib/errors.js';

const SIGNATURE_HEADER = 'pylon-webhook-signature';
const TIMESTAMP_HEADER = 'pylon-webhook-timestamp';

/**
 * Verifies the `Pylon-Webhook-Signature` header.
 *
 * Pylon computes HMAC-SHA256 over concat(timestamp, '.', rawBody) using the
 * webhook destination secret, and sends it as `hs256=<hex>`. See
 * https://getpylon.com/developers/guides/using-webhooks/
 *
 * `rawBody` MUST be the exact bytes received — re-serialising the parsed JSON
 * will change whitespace and break the signature.
 */
export function verifyWebhookSignature({ rawBody, headers, secret, toleranceSeconds = 300, now = Date.now() }) {
  if (!secret) {
    return { ok: false, reason: 'No PYLON_WEBHOOK_SECRET is configured on this server.' };
  }

  const signatureHeader = headerValue(headers, SIGNATURE_HEADER);
  const timestampHeader = headerValue(headers, TIMESTAMP_HEADER);

  if (!signatureHeader) return { ok: false, reason: `Missing ${SIGNATURE_HEADER} header.` };
  if (!timestampHeader) return { ok: false, reason: `Missing ${TIMESTAMP_HEADER} header.` };

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: `${TIMESTAMP_HEADER} is not a unix timestamp: "${timestampHeader}".` };
  }

  const ageSeconds = Math.abs(Math.floor(now / 1000) - timestamp);
  if (toleranceSeconds > 0 && ageSeconds > toleranceSeconds) {
    return {
      ok: false,
      reason: `Webhook timestamp is ${ageSeconds}s away from this server's clock (tolerance ${toleranceSeconds}s). Either the request is a replay or this server's clock is wrong.`,
    };
  }

  const provided = signatureHeader.replace(/^hs256=/i, '').trim();
  const payload = Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf8'), Buffer.from(rawBody)]);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'Signature does not match. The webhook secret on this server does not match the one Pylon is signing with.' };
  }

  return { ok: true, timestamp };
}

/** Mirror of the signing algorithm — used by the simulate script and the tests. */
export function signWebhookBody({ rawBody, secret, timestamp }) {
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), Buffer.from(rawBody)]);
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { signature: `hs256=${digest}`, timestamp: String(timestamp) };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? (Array.isArray(found[1]) ? found[1][0] : found[1]) : undefined;
}

export class PylonClient {
  constructor({ apiBase, apiToken, timeoutMs = 20000 }) {
    this.apiBase = apiBase;
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
  }

  /**
   * False when no API token is configured. Pylon only issues tokens once their
   * support team enables API access on the team, so the bridge has to keep
   * working in the meantime — callers check this and fall back to whatever the
   * webhook body itself carries.
   */
  get enabled() {
    return Boolean(this.apiToken);
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: 'application/vnd.api+json',
    };
  }

  async get(pathname, query = {}) {
    if (!this.apiToken) {
      throw new IntegrationError('PYLON_API_TOKEN is not configured, so Pylon cannot be queried.', {
        kind: 'config',
        system: 'Pylon',
      });
    }
    const { data } = await requestJson({
      system: 'Pylon',
      method: 'GET',
      url: buildUrl(this.apiBase, pathname, query),
      headers: this.headers,
      timeoutMs: this.timeoutMs,
    });
    return data;
  }

  /** GET /v1/solar_projects/{id} — customer details, site address, acceptance. */
  async getSolarProject(id) {
    const body = await this.get(`/v1/solar_projects/${encodeURIComponent(id)}`);
    return body?.data ?? null;
  }

  /** GET /v1/solar_designs/{id} — pricing, line items, proposal URLs. */
  async getSolarDesign(id) {
    const body = await this.get(`/v1/solar_designs/${encodeURIComponent(id)}`);
    return body?.data ?? null;
  }

  async getEvent(id) {
    const body = await this.get(`/v1/events/${encodeURIComponent(id)}`);
    return body?.data ?? null;
  }

  /**
   * Downloads a Pylon-hosted PDF. These URLs are pre-signed and expire (the
   * signed-contract one is documented as valid for 1 hour), which is exactly why
   * the bridge re-hosts the file in GoHighLevel instead of storing the link.
   */
  async downloadPdf(url) {
    if (!url) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        throw new IntegrationError(
          `Could not download the signed contract PDF from Pylon (HTTP ${response.status}). These links expire one hour after they are issued — if this event is being replayed late, re-fetch the project first.`,
          { kind: 'pdf_download', system: 'Pylon', status: response.status, retryable: response.status >= 500 },
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        contentType: response.headers.get('content-type') || 'application/pdf',
        bytes: buffer.length,
      };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw networkError('Pylon', url, error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lightweight credential check used by GET /health?deep=1. */
  async ping() {
    await this.get('/v1/users', { 'page[number]': 1 });
    return true;
  }
}
