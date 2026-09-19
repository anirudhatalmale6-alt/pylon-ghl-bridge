import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requestJson } from './lib/http.js';
import { logger } from './lib/logger.js';
import { IntegrationError } from './lib/errors.js';

/**
 * Writes invoices straight into Xero, instead of letting GoHighLevel sync them.
 *
 * Two things GoHighLevel cannot do, both of which the accounts team asked for:
 *
 *   1. Land the invoice in "Awaiting Approval". GoHighLevel always pushes
 *      AUTHORISED, which Xero shows as Awaiting Payment, and its settings screen
 *      has no option for it. Xero accepts DRAFT, SUBMITTED or AUTHORISED on
 *      creation; SUBMITTED is Awaiting Approval.
 *
 *   2. Keep GST off the rebate lines. Xero's own documentation: "If TaxType
 *      isn't specified then Xero will use the default tax rate on the Chart of
 *      Accounts account that the line item is coded to." GoHighLevel refuses to
 *      put any tax on a negative line ("taxes allowed only on items with price
 *      greater than 0"), so those lines arrive bare and inherit GST on Income.
 *      Here every line states its own TaxType and nothing is inherited.
 */

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * `offline_access` is what gets us a refresh token at all.
 *
 * `accounting.invoices`, NOT `accounting.transactions`. Xero moved new apps onto
 * granular scopes in April 2026 and the broad one is refused outright — the
 * whole authorize request comes back `invalid_scope`, with nothing to say which
 * scope was at fault. Verified against the real app: the string below is
 * accepted and the one with `accounting.transactions` is not.
 *
 * `offline_access` on its own is ALSO refused — it modifies a request rather
 * than naming data, so it is only valid alongside a resource scope. That makes
 * a per-scope probe read as "offline_access is not allowed", which it is not.
 */
export const SCOPES = 'offline_access accounting.invoices accounting.contacts accounting.settings.read';

/** Australian tax types. OUTPUT is GST on Income; BASEXCLUDED carries no GST. */
export const TAX_GST = 'OUTPUT';
export const TAX_NO_GST = 'BASEXCLUDED';

/**
 * Xero sells two kinds of app and they authenticate completely differently.
 *
 *   web_app           - free. Authorization-code flow: a human clicks through a
 *                       consent screen once, and we then hold a refresh token
 *                       that Xero rotates on every use.
 *   custom_connection - $10/month AUD. Client-credentials flow: no consent
 *                       screen, no refresh token, no expiry. One organisation.
 *
 * Both are supported because the business may move between them, and the choice
 * is a billing decision rather than a technical one.
 */
export const WEB_APP = 'web_app';
export const CUSTOM_CONNECTION = 'custom_connection';

export class XeroClient {
  constructor({ clientId, clientSecret, redirectUri, dataDir, authMode = WEB_APP, apiBase = API_BASE, timeoutMs = 20000 } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    // Overridable so the tests can drive the real client against a fake Xero
    // rather than a hand-written stub of it.
    this.apiBase = apiBase;
    this.authMode = authMode === CUSTOM_CONNECTION ? CUSTOM_CONNECTION : WEB_APP;
    this.timeoutMs = timeoutMs;
    this.file = path.join(dataDir, 'xero-tokens.json');
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  }

  get usesClientCredentials() {
    return this.authMode === CUSTOM_CONNECTION;
  }

  get configured() {
    // A custom connection never redirects anywhere, so it needs no redirect URI.
    if (this.usesClientCredentials) return Boolean(this.clientId && this.clientSecret);
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /**
   * Whether we can actually reach an organisation.
   *
   * For a custom connection, holding valid credentials is NOT the same as being
   * connected: Xero issues a perfectly good token for a connection nobody has
   * authorised yet, and every API call then returns 403. The tenant id is the
   * honest signal, so that is what this reports.
   */
  get connected() {
    if (this.usesClientCredentials) return Boolean(this.read()?.tenantId);
    return Boolean(this.read()?.refreshToken);
  }

  read() {
    if (!fs.existsSync(this.file)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      logger.warn('xero token file unreadable', { error: error.message });
      return null;
    }
  }

  /**
   * Written with 0600 and replaced atomically.
   *
   * Xero ROTATES the refresh token on every refresh — the old one stops working
   * the moment a new one is issued. Losing the write means the connection is
   * dead and somebody has to click through the consent screen again, so this is
   * saved before the new access token is used for anything.
   */
  write(tokens) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return tokens;
  }

  authorizeUrl(state = crypto.randomBytes(16).toString('hex')) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
    });
    return { url: `${AUTH_URL}?${params}`, state };
  }

  basicAuth() {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
  }

  async exchangeCode(code) {
    const { data } = await requestJson({
      system: 'Xero',
      method: 'POST',
      url: TOKEN_URL,
      headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri }).toString(),
      timeoutMs: this.timeoutMs,
    });
    return this.store(data);
  }

  /**
   * A custom connection's token, from the client credentials alone.
   *
   * There is no refresh token and nothing to rotate — when the current one
   * expires we simply ask for another.
   */
  async clientCredentialsToken() {
    const { data } = await requestJson({
      system: 'Xero',
      method: 'POST',
      url: TOKEN_URL,
      headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      // Deliberately no `scope`: Xero grants the scopes chosen on the connection
      // itself, and naming one it was not given fails the whole request with
      // "Client credentials scope validation failed".
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      timeoutMs: this.timeoutMs,
    });
    if (!data?.access_token) {
      throw new IntegrationError('Xero returned no access token for those client credentials.', {
        kind: 'auth',
        system: 'Xero',
      });
    }
    return this.write({
      ...(this.read() ?? {}),
      accessToken: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in ?? 1800) * 1000,
      // The organisation is a claim inside the token, not a separate lookup.
      tenantId: tenantFromToken(data.access_token) ?? this.read()?.tenantId ?? null,
      updatedAt: new Date().toISOString(),
    });
  }

  async refresh() {
    const current = this.read();
    if (!current?.refreshToken) {
      throw new IntegrationError('Xero is not connected yet. Open /xero/connect to authorise it.', {
        kind: 'auth',
        system: 'Xero',
      });
    }
    const { data } = await requestJson({
      system: 'Xero',
      method: 'POST',
      url: TOKEN_URL,
      headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }).toString(),
      timeoutMs: this.timeoutMs,
    });
    return this.store(data, current);
  }

  store(data, previous = {}) {
    if (!data?.access_token) {
      throw new IntegrationError('Xero returned no access token.', { kind: 'auth', system: 'Xero' });
    }
    return this.write({
      ...previous,
      accessToken: data.access_token,
      // Keep the old refresh token if Xero did not send a new one.
      refreshToken: data.refresh_token ?? previous.refreshToken,
      // Access tokens last 30 minutes; refresh a minute early.
      expiresAt: Date.now() + Number(data.expires_in ?? 1800) * 1000,
      updatedAt: new Date().toISOString(),
    });
  }

  async accessToken() {
    const current = this.read();
    if (current?.accessToken && Date.now() < current.expiresAt - 60_000) return current.accessToken;
    const fresh = this.usesClientCredentials ? await this.clientCredentialsToken() : await this.refresh();
    return fresh.accessToken;
  }

  /** Which Xero organisation this connection is for. Cached after the first call. */
  async tenantId() {
    const current = this.read();
    if (current?.tenantId) return current.tenantId;

    /**
     * A custom connection cannot use /connections at all — it answers
     * "Xero-User-Id and/or Xero-Tenant-Id header must be supplied", which is the
     * header we are trying to discover. The organisation arrives as the
     * `xero_tenant_id` claim inside the token instead.
     *
     * The claim is ABSENT until somebody completes the authorisation email Xero
     * sends the nominated user. Before that the token is valid and every API
     * call returns a bare 403, so this says what is actually wrong.
     */
    if (this.usesClientCredentials) {
      const { tenantId } = await this.clientCredentialsToken();
      if (!tenantId) {
        throw new IntegrationError(
          'This Xero custom connection has not been authorised yet. The nominated user needs to open the connection email from Xero and pick the organisation.',
          { kind: 'auth', system: 'Xero' },
        );
      }
      return tenantId;
    }

    const token = await this.accessToken();
    const { data } = await requestJson({
      system: 'Xero',
      method: 'GET',
      url: CONNECTIONS_URL,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    const tenant = Array.isArray(data) ? data[0] : null;
    if (!tenant?.tenantId) {
      throw new IntegrationError('Xero reports no connected organisation for this app.', { kind: 'auth', system: 'Xero' });
    }
    this.write({ ...this.read(), tenantId: tenant.tenantId, tenantName: tenant.tenantName });
    return tenant.tenantId;
  }

  /**
   * The organisation this connection actually reaches, asked of Xero rather
   * than taken from what was stored at connect time.
   *
   * Worth one call before anything is billed: it is the difference between "the
   * credentials work" and "the credentials point at Inspire Energy", and a
   * demo company answers just as happily as the real one.
   */
  async organisation() {
    const data = await this.call({ method: 'GET', path: '/Organisation' });
    const org = data?.Organisations?.[0];
    if (!org) return null;
    const name = org.Name ?? null;
    this.write({ ...(this.read() ?? {}), tenantName: name, isDemoCompany: Boolean(org.IsDemoCompany) });
    return { name, legalName: org.LegalName ?? null, countryCode: org.CountryCode ?? null, isDemoCompany: Boolean(org.IsDemoCompany) };
  }

  async call({ method, path: urlPath, body }) {
    const token = await this.accessToken();
    const tenantId = await this.tenantId();
    const { data } = await requestJson({
      system: 'Xero',
      method,
      url: `${this.apiBase}${urlPath}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: this.timeoutMs,
    });
    return data;
  }
}

/**
 * The organisation id out of a Xero access token.
 *
 * Only the claim is read — the signature is Xero's to verify, not ours. Nothing
 * here is a security decision: a forged token would simply be rejected by the
 * API on the next call.
 */
export function tenantFromToken(accessToken) {
  const part = String(accessToken ?? '').split('.')[1];
  if (!part) return null;
  try {
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    return claims.xero_tenant_id ?? null;
  } catch {
    return null;
  }
}

/**
 * The Xero invoice for a contract.
 *
 * Every line names its own TaxType so nothing falls back to the account default
 * — that fallback is the whole reason GST was landing on the STC lines.
 * LineAmountTypes is Exclusive because the system line amount is the ex-GST
 * figure, the same one already sent to GoHighLevel.
 */
export function buildInvoice({ contactId, contactName, contactEmail, invoiceNumber, reference, issueDate, dueDate, currency = 'AUD', systemLine, rebateLines = [], status = 'SUBMITTED' }) {
  const lineItems = [
    {
      Description: systemLine.description,
      Quantity: 1,
      UnitAmount: systemLine.amount,
      TaxType: TAX_GST,
    },
    ...rebateLines.map((rebate) => ({
      Description: rebate.description,
      Quantity: 1,
      UnitAmount: -Math.abs(rebate.amount),
      // The certificates are GST free on the contract. Stated, not inherited.
      TaxType: TAX_NO_GST,
    })),
  ];

  return {
    Invoices: [
      {
        Type: 'ACCREC',
        // A matched ContactID wins: Xero matches on NAME otherwise, so a name
        // that differs by a character quietly creates a second contact for the
        // same customer.
        Contact: contactId
          ? { ContactID: contactId }
          : { Name: contactName, ...(contactEmail ? { EmailAddress: contactEmail } : {}) },
        Date: issueDate,
        DueDate: dueDate,
        InvoiceNumber: invoiceNumber,
        Reference: reference,
        CurrencyCode: currency,
        LineAmountTypes: 'Exclusive',
        // SUBMITTED is Xero's "Awaiting Approval" — what the accounts team asked
        // for, and what GoHighLevel's integration cannot produce.
        Status: status,
        LineItems: lineItems,
      },
    ],
  };
}
