import { requestJson } from './lib/http.js';
import { logger } from './lib/logger.js';
import { IntegrationError } from './lib/errors.js';

/**
 * Reads jobs out of Formbay.
 *
 * Two things about this API cost a lot of time to find, so they are written
 * down rather than rediscovered:
 *
 *   1. It is NOT on api.formbay.com.au. That host serves the web app and
 *      answers every call with "no access to this client_id", which reads like
 *      a permissions problem and is not. The API is on
 *      trading.formbay.com.au/client_api/.
 *
 *   2. The key shown in Formbay's Account Settings is not an API key. It is the
 *      HTTP Basic credential for an OAuth2 password grant against
 *      oauth2.formbay.com.au, which returns the Bearer token the API wants.
 *
 * There is no endpoint that lists jobs — `bstc_form` and `pv_form` each require
 * a formid — so the set of jobs has to come from somewhere else.
 */

const TOKEN_URL = 'https://oauth2.formbay.com.au/token';
const API_BASE = 'https://trading.formbay.com.au/client_api';

export class FormbayClient {
  constructor({ clientCredential, username, password, timeoutMs = 20000 } = {}) {
    this.clientCredential = clientCredential;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this._token = null;
    this._expiresAt = 0;
  }

  get configured() {
    return Boolean(this.clientCredential && this.username && this.password);
  }

  /** Mints a Bearer token, reusing the current one until it is nearly expired. */
  async token() {
    if (!this.configured) {
      throw new IntegrationError(
        'Formbay is not configured. Set FORMBAY_CLIENT_CREDENTIAL, FORMBAY_USERNAME and FORMBAY_PASSWORD.',
        { kind: 'config', system: 'Formbay' },
      );
    }
    // A minute of headroom: a token that expires mid-refresh would fail halfway
    // through a few hundred jobs.
    if (this._token && Date.now() < this._expiresAt - 60_000) return this._token;

    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.username,
      password: this.password,
      scope: 'admin',
    });

    const { data } = await requestJson({
      system: 'Formbay',
      method: 'POST',
      url: TOKEN_URL,
      headers: {
        Authorization: `Basic ${this.clientCredential}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      timeoutMs: this.timeoutMs,
    });

    if (!data?.access_token) {
      throw new IntegrationError('Formbay returned no access token for those credentials.', {
        kind: 'auth',
        system: 'Formbay',
      });
    }
    this._token = data.access_token;
    // Their token lasts 24 hours despite the sample in their docs saying 3600.
    this._expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    return this._token;
  }

  /**
   * One job. `reference` is how the business writes it — BSTC238207, PV1272458 —
   * and the prefix chooses the endpoint.
   */
  async job(reference) {
    const parsed = parseReference(reference);
    if (!parsed) return { reference, ok: false, error: `"${reference}" is not a PV or BSTC number.` };

    const token = await this.token();
    try {
      const { data } = await requestJson({
        system: 'Formbay',
        method: 'GET',
        // Accept: application/json is refused with a 406; */* is what works.
        url: `${API_BASE}/${parsed.kind}_form?formid=${encodeURIComponent(parsed.id)}`,
        headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
        timeoutMs: this.timeoutMs,
      });
      return { reference, ok: true, ...summarise(data, parsed) };
    } catch (error) {
      logger.warn('formbay job lookup failed', { reference, status: error.status, message: error.message });
      return { reference, ok: false, error: error.status === 403 ? 'Formbay says no access to this job.' : error.message };
    }
  }
}

/** "BSTC238207" -> { kind: 'bstc', id: '238207' }. */
export function parseReference(reference) {
  const text = String(reference ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const match = text.match(/^(BSTC|PV)0*(\d+)$/);
  if (!match) return null;
  return { kind: match[1].toLowerCase(), id: match[2] };
}

/**
 * The fields the tracker needs, from the 81 Formbay returns.
 *
 * `value` is NOT one of them: Formbay gives the certificate count and the unit
 * price and expects you to multiply. `calbstc` comes back as a string.
 */
export function summarise(data = {}, parsed = {}) {
  const certificates = toNumber(data.calbstc ?? data.calstc ?? data.certificates);
  const price = toNumber(data.price);
  const value = certificates !== null && price !== null ? Math.round(certificates * price * 100) / 100 : null;
  return {
    kind: parsed.kind ?? null,
    formId: parsed.id ?? null,
    jobNumber: data.urref || null, // the "Ref Id" printed on a Formbay payment advice
    status: data.status || null,
    soldDate: data.sold_date || null,
    installedDate: data.idate || null,
    certificates,
    price,
    value,
    address: addressOf(data),
  };
}

function addressOf(d = {}) {
  const parts = [
    [d.punitnum, d.pstreetnum].filter(Boolean).join('/'),
    titleCase(d.pstreetname),
    titleCase(d.pstreettype),
  ]
    .filter(Boolean)
    .join(' ');
  const suburb = [titleCase(d.pcity), (d.pstate || '').toUpperCase(), d.ppostcode].filter(Boolean).join(' ');
  return [parts, suburb].filter(Boolean).join(', ');
}

function titleCase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
