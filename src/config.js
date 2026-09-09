import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

/**
 * Minimal .env loader — deliberately dependency-free so the service can run on a
 * bare Node install. Real environment variables always win over the file, which
 * is what you want on Render/Heroku/systemd where secrets are injected.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(process.env.ENV_FILE || path.join(projectRoot, '.env'));

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: path.resolve(projectRoot, process.env.DATA_DIR || 'data'),
  mappingFile: path.resolve(projectRoot, process.env.MAPPING_FILE || 'config/mapping.json'),

  // Guards the read-only inspection endpoints (/events, /mapping, /health?deep=1)
  // and the replay/simulate endpoints. Without it those routes return 503.
  adminToken: process.env.ADMIN_TOKEN || '',

  // When true the bridge does everything except the writes to GoHighLevel.
  // Useful for a first run against production data.
  dryRun: bool(process.env.DRY_RUN, false),

  pylon: {
    apiBase: (process.env.PYLON_API_BASE || 'https://api.getpylon.com').replace(/\/$/, ''),
    // Optional. Pylon only hands out API tokens once their support team enables
    // API access on the team (see their developer FAQ), so the bridge has to be
    // able to run before that happens. Without a token it works in
    // "webhook-only" mode: everything the webhook body carries still lands in
    // GoHighLevel, and the fields that need a lookup are reported as warnings
    // rather than silently dropped.
    apiToken: process.env.PYLON_API_TOKEN || '',
    webhookSecret: process.env.PYLON_WEBHOOK_SECRET || '',
    // Pylon signs concat(timestamp, '.', body); reject anything older than this.
    toleranceSeconds: int(process.env.PYLON_WEBHOOK_TOLERANCE_SECONDS, 300),
    timeoutMs: int(process.env.PYLON_TIMEOUT_MS, 20000),
  },

  ghl: {
    apiBase: (process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, ''),
    apiToken: process.env.GHL_API_TOKEN || '',
    apiVersion: process.env.GHL_API_VERSION || '2021-07-28',
    locationId: process.env.GHL_LOCATION_ID || '',
    timeoutMs: int(process.env.GHL_TIMEOUT_MS, 30000),

    // Either the id or the name may be supplied. Names are resolved to ids on
    // boot (and cached) so the client can configure this without digging in the
    // GHL URL bar.
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    pipelineName: process.env.GHL_PIPELINE_NAME || '',
    signedStageId: process.env.GHL_SIGNED_STAGE_ID || '',
    signedStageName: process.env.GHL_SIGNED_STAGE_NAME || '',
    paidStageId: process.env.GHL_PAID_STAGE_ID || '',
    paidStageName: process.env.GHL_PAID_STAGE_NAME || '',

    // 'open' | 'won' — what the opportunity status becomes once signed.
    statusOnSigned: process.env.GHL_STATUS_ON_SIGNED || 'open',

    // Where the signed PDF is filed.
    mediaFolderId: process.env.GHL_MEDIA_FOLDER_ID || '',
    // Contact custom field (FILE_UPLOAD type) that receives the actual PDF.
    contractFileFieldKey: process.env.GHL_CONTRACT_FILE_FIELD_KEY || 'contact.signed_contract_file',
    uploadContractFile: bool(process.env.GHL_UPLOAD_CONTRACT_FILE, true),
    addNote: bool(process.env.GHL_ADD_NOTE, true),

    // Raise a GoHighLevel invoice when a contract is signed. Off by default:
    // it needs the `invoices.write` scope, and creating one is a billing action
    // that should be switched on deliberately.
    createInvoice: bool(process.env.GHL_CREATE_INVOICE, false),
    // sms_and_email | email | sms | send_manually | none
    // "none" leaves the invoice as a draft and never contacts the customer.
    // "send_manually" marks it sent without emailing them.
    invoiceSendAction: process.env.GHL_INVOICE_SEND_ACTION || 'none',
    // Whose name the send is recorded under. Needs `users.readonly` to look up;
    // supply it directly to avoid that scope.
    invoiceUserId: process.env.GHL_INVOICE_USER_ID || '',
    invoiceDueDays: int(process.env.GHL_INVOICE_DUE_DAYS, 7),
    // Test-mode invoices in GHL when false.
    invoiceLiveMode: bool(process.env.GHL_INVOICE_LIVE_MODE, true),
    // Offer ONLY bank debit (BECS in Australia) on invoices rather than card.
    // Stripe AU charges 1.7% + $0.30 on a card but caps bank debit at $3.50, so
    // on a five-figure contract this is the difference between ~$160 and $3.50.
    // Per-stage `bankDebitOnly` in the mapping overrides this.
    invoiceBankDebitOnly: bool(process.env.GHL_INVOICE_BANK_DEBIT_ONLY, false),
  },

  // Optional outbound "did it land?" callback. Every processed event POSTs a
  // small JSON summary here, HMAC-signed with BRIDGE_CALLBACK_SECRET.
  callback: {
    url: process.env.BRIDGE_CALLBACK_URL || '',
    secret: process.env.BRIDGE_CALLBACK_SECRET || '',
    timeoutMs: int(process.env.BRIDGE_CALLBACK_TIMEOUT_MS, 10000),
  },

  queue: {
    maxAttempts: int(process.env.QUEUE_MAX_ATTEMPTS, 5),
    // Backoff schedule in seconds; index clamps to the last entry.
    backoffSeconds: (process.env.QUEUE_BACKOFF_SECONDS || '10,60,300,1800,3600')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter(Number.isFinite),
    concurrency: int(process.env.QUEUE_CONCURRENCY, 2),
  },

  retentionDays: int(process.env.EVENT_RETENTION_DAYS, 90),
};

/**
 * Returns a list of human-readable problems. The server refuses to start when
 * this is non-empty, rather than failing on the first real webhook at 2am.
 */
export function validateConfig(cfg = config) {
  const problems = [];
  if (!cfg.pylon.webhookSecret) problems.push('PYLON_WEBHOOK_SECRET is not set — incoming webhooks cannot be verified and will all be rejected.');
  if (!cfg.ghl.apiToken) problems.push('GHL_API_TOKEN is not set — the bridge cannot write to GoHighLevel.');
  if (!cfg.ghl.locationId) problems.push('GHL_LOCATION_ID is not set — GoHighLevel needs to know which sub-account to write to.');
  if (!cfg.ghl.pipelineId && !cfg.ghl.pipelineName) {
    problems.push('Set GHL_PIPELINE_ID or GHL_PIPELINE_NAME — the bridge needs to know which pipeline the opportunity belongs to.');
  }
  if (!cfg.ghl.signedStageId && !cfg.ghl.signedStageName) {
    problems.push('Set GHL_SIGNED_STAGE_ID or GHL_SIGNED_STAGE_NAME — the bridge needs to know which stage means "contract signed".');
  }
  const sendActions = ['none', 'send_manually', 'email', 'sms', 'sms_and_email'];
  if (!sendActions.includes(cfg.ghl.invoiceSendAction)) {
    problems.push(`GHL_INVOICE_SEND_ACTION must be one of ${sendActions.join(', ')}, got "${cfg.ghl.invoiceSendAction}".`);
  }
  if (!['open', 'won'].includes(cfg.ghl.statusOnSigned)) {
    problems.push(`GHL_STATUS_ON_SIGNED must be "open" or "won", got "${cfg.ghl.statusOnSigned}".`);
  }
  if (cfg.callback.url && !cfg.callback.secret) {
    problems.push('BRIDGE_CALLBACK_URL is set but BRIDGE_CALLBACK_SECRET is not — the callback would be unsigned and unverifiable.');
  }
  return problems;
}

/** True when a Pylon API token is present, i.e. lookups are possible. */
export function enrichmentEnabled(cfg = config) {
  return Boolean(cfg.pylon.apiToken);
}

/**
 * Things that do not stop the service but that somebody should know about.
 * Printed at startup and returned by GET /health.
 */
export function configWarnings(cfg = config) {
  const warnings = [];
  if (!enrichmentEnabled(cfg)) {
    warnings.push(
      'PYLON_API_TOKEN is not set, so the bridge is running in webhook-only mode. ' +
        'The signer name, email, Pylon deep link, stage move and payment amounts all still land in GoHighLevel. ' +
        'The contract value, site address, system size and the signed PDF are only available through the Pylon API — ' +
        'those will be reported as warnings on every event until a token is configured.',
    );
  }
  if (!cfg.adminToken) {
    warnings.push('ADMIN_TOKEN is not set — /events, /mapping and the deep health check will return 503.');
  }
  if (cfg.dryRun) {
    warnings.push('DRY_RUN is on — nothing will actually be written to GoHighLevel.');
  }
  return warnings;
}
