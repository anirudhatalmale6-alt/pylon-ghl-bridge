#!/usr/bin/env node
/**
 * Drives one real contract-signature and one real payment all the way into the
 * LIVE GoHighLevel location in .env, and prints what landed.
 *
 *   node scripts/live-test.js
 *
 * The Pylon side is served locally by the same stand-in the test suite uses.
 * That is deliberate: it lets the whole GoHighLevel half be proven — contract
 * value, client details, payment, PDF — before Pylon support has enabled API
 * access on the team. Everything downstream of the webhook is genuinely real:
 * a real contact, a real opportunity, real custom fields, a real file upload.
 *
 * It writes to a live CRM. The records it creates are named so they are obvious.
 */
import { config } from '../src/config.js';
import { GhlClient } from '../src/ghl.js';
import { startFakePylon } from '../test/helpers/upstreams.js';
import { signWebhookBody } from '../src/pylon.js';
import { createApp } from '../src/app.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'live-test-webhook-secret';

if (!config.ghl.apiToken || !config.ghl.locationId) {
  console.error('Set GHL_API_TOKEN and GHL_LOCATION_ID in .env first.');
  process.exit(1);
}

// Named so the records are unmistakable in the CRM and easy to delete afterwards.
const pylon = await startFakePylon({
  projectOverrides: {
    reference_number: 'PYLON-TEST-0001',
    customer_details: {
      name: 'ZZ Integration Test',
      phone: '+61400000000',
      email: 'pylon.integration.test@inspire-bridge.invalid',
    },
    site_address: {
      line1: '1 Test Street',
      line2: '',
      city: 'Newcastle',
      state: 'NSW',
      zip: '2300',
      country: 'Australia',
    },
  },
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pylon-ghl-live-'));

const liveConfig = {
  ...config,
  dataDir,
  dryRun: false,
  pylon: { ...config.pylon, apiBase: pylon.base, apiToken: 'pylon-test-token', webhookSecret: SECRET },
};

const bridge = createApp({ config: liveConfig, skipValidation: true });
const server = await new Promise((resolve) => {
  const s = bridge.app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function deliver(fixtureName) {
  const body = fs.readFileSync(path.join('test', 'fixtures', fixtureName), 'utf8');
  const signed = signWebhookBody({ rawBody: body, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) });
  const started = Date.now();
  const response = await fetch(`${base}/webhooks/pylon`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Pylon-Webhook-Signature': signed.signature,
      'Pylon-Webhook-Timestamp': signed.timestamp,
      'Pylon-Webhook-Version': '2021-07',
    },
    body,
  });
  console.log(`\nPOST /webhooks/pylon  (${fixtureName})  ->  HTTP ${response.status} in ${Date.now() - started}ms`);
  await bridge.queue.onIdle();
  return JSON.parse(body).data.id;
}

const ghl = new GhlClient({ ...config.ghl, dryRun: false });
const index = new Map(
  (await ghl.listCustomFields('all', { fresh: true })).map((f) => [f.id, f]),
);

function show(title, customFields) {
  console.log(`\n  ${title}`);
  for (const entry of customFields ?? []) {
    const field = index.get(entry.id);
    const value = entry.fieldValue ?? entry.value;
    if (value === undefined || value === null || value === '') continue;
    console.log(`    ${(field?.name ?? entry.id).padEnd(24)} ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------- signed
const signedId = await deliver('event-live-test-signed.json');
const signed = bridge.store.get(signedId);
console.log(`  status: ${signed.status}`);
if (signed.error) console.log(`  error : ${signed.error.message}`);
console.log(`  result: ${JSON.stringify(signed.result, null, 2)}`);

if (signed.result?.opportunityId) {
  const opportunity = await ghl.request('GET', `/opportunities/${signed.result.opportunityId}`);
  const o = opportunity.opportunity ?? opportunity;
  console.log('\n=== LIVE OPPORTUNITY IN GOHIGHLEVEL =========================');
  console.log(`  id            ${o.id}`);
  console.log(`  name          ${o.name}`);
  console.log(`  monetaryValue ${o.monetaryValue}`);
  console.log(`  status        ${o.status}`);
  console.log(`  stage         ${o.pipelineStageId}`);
  show('custom fields:', o.customFields);
}

if (signed.result?.contactId) {
  const contact = await ghl.getContact(signed.result.contactId);
  console.log('\n=== LIVE CONTACT IN GOHIGHLEVEL =============================');
  console.log(`  id     ${contact.id}`);
  console.log(`  name   ${contact.firstName} ${contact.lastName}`);
  console.log(`  email  ${contact.email}`);
  console.log(`  tags   ${JSON.stringify(contact.tags)}`);
  show('custom fields:', contact.customFields);
}

// ------------------------------------------------- the later payment stages
// Only the deposit comes from Pylon. These two are what a GoHighLevel workflow
// would call when the job reaches the right stage.
for (const stageKey of ['pre_install', 'installation']) {
  const response = await fetch(`${base}/invoices/${stageKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminToken}` },
    body: JSON.stringify({ opportunityId: signed.result?.opportunityId }),
  });
  const body = await response.json();
  console.log(`\nPOST /invoices/${stageKey}  ->  HTTP ${response.status}`);
  console.log(`  ${JSON.stringify(body)}`);
}

// --------------------------------------------------------------- payment
const paymentId = await deliver('event-live-test-payment.json');
const payment = bridge.store.get(paymentId);
console.log(`  status: ${payment.status}`);
if (payment.error) console.log(`  error : ${payment.error.message}`);
console.log(`  result: ${JSON.stringify(payment.result, null, 2)}`);

if (payment.result?.opportunityId) {
  const opportunity = await ghl.request('GET', `/opportunities/${payment.result.opportunityId}`);
  const o = opportunity.opportunity ?? opportunity;
  console.log('\n=== OPPORTUNITY AFTER THE PAYMENT ===========================');
  console.log(`  monetaryValue ${o.monetaryValue}   <- must still be the CONTRACT value, not the deposit`);
  show('custom fields:', o.customFields);
}

bridge.queue.stop();
await new Promise((r) => server.close(r));
await pylon.close();
fs.rmSync(dataDir, { recursive: true, force: true });
