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

/** offline_access is what gets us a refresh token at all. */
export const SCOPES = 'offline_access accounting.transactions accounting.contacts accounting.settings.read';

/** Australian tax types. OUTPUT is GST on Income; BASEXCLUDED carries no GST. */
export const TAX_GST = 'OUTPUT';
export const TAX_NO_GST = 'BASEXCLUDED';

export class XeroClient {
  constructor({ clientId, clientSecret, redirectUri, dataDir, timeoutMs = 20000 } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.timeoutMs = timeoutMs;
    this.file = path.join(dataDir, 'xero-tokens.json');
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  get connected() {
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
    const refreshed = await this.refresh();
    return refreshed.accessToken;
  }

  /** Which Xero organisation this connection is for. Cached after the first call. */
  async tenantId() {
    const current = this.read();
    if (current?.tenantId) return current.tenantId;
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

  async call({ method, path: urlPath, body }) {
    const token = await this.accessToken();
    const tenantId = await this.tenantId();
    const { data } = await requestJson({
      system: 'Xero',
      method,
      url: `${API_BASE}${urlPath}`,
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
 * The Xero invoice for a contract.
 *
 * Every line names its own TaxType so nothing falls back to the account default
 * — that fallback is the whole reason GST was landing on the STC lines.
 * LineAmountTypes is Exclusive because the system line amount is the ex-GST
 * figure, the same one already sent to GoHighLevel.
 */
export function buildInvoice({ contactName, contactEmail, invoiceNumber, reference, issueDate, dueDate, currency = 'AUD', systemLine, rebateLines = [], status = 'SUBMITTED' }) {
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
        Contact: { Name: contactName, ...(contactEmail ? { EmailAddress: contactEmail } : {}) },
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
