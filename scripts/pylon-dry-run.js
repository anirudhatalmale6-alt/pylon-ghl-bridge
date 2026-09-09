#!/usr/bin/env node
/**
 * Reads a REAL signed project out of the live Pylon account and shows exactly
 * what would be written to GoHighLevel — writing nothing.
 *
 *   node scripts/pylon-dry-run.js <solarProjectId>
 *
 * DRY_RUN is forced on. This matters: these are real customers, and raising a
 * real invoice against one of them because a developer wanted to see the output
 * would be unforgivable. Pylon is read for real; GoHighLevel is not touched.
 */
import { config } from '../src/config.js';
import { PylonClient } from '../src/pylon.js';
import { createApp } from '../src/app.js';
import { signWebhookBody } from '../src/pylon.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node scripts/pylon-dry-run.js <solarProjectId>');
  process.exit(1);
}
if (!config.pylon.apiToken) {
  console.error('PYLON_API_TOKEN is not set.');
  process.exit(1);
}

const pylon = new PylonClient(config.pylon);
const project = await pylon.getSolarProject(projectId);
if (!project) {
  console.error(`Pylon returned no project for ${projectId}.`);
  process.exit(1);
}

const designId =
  project.relationships?.latest_signed_design?.data?.id ??
  project.relationships?.primary_design?.data?.id ??
  null;

const attrs = project.attributes ?? {};
console.log('=== REAL PYLON PROJECT ======================================');
console.log(`  id                ${project.id}`);
console.log(`  reference_number  ${JSON.stringify(attrs.reference_number)}`);
console.log(`  customer          ${attrs.customer_details?.name ?? ''} <${attrs.customer_details?.email ?? ''}>`);
console.log(`  site              ${[attrs.site_address?.line1, attrs.site_address?.city, attrs.site_address?.state].filter(Boolean).join(', ')}`);
console.log(`  accepted          ${attrs.acceptance?.is_accepted}   e-signature: ${Boolean(attrs.acceptance?.latest_esignature)}`);
console.log(`  signed design     ${designId}`);

// Exactly the body Pylon posts for a signature.
const event = {
  data: {
    type: 'events',
    id: `dryrun-${project.id}`,
    attributes: {
      name: 'web_proposals.signed',
      created_at: new Date(attrs.updated_at ?? attrs.created_at ?? Date.now()).toISOString(),
      description: `Dry run for ${attrs.customer_details?.name ?? project.id}`,
      customer_name: attrs.customer_details?.name ?? '',
      customer_email: attrs.customer_details?.email ?? '',
      project_in_app_url: `https://app.getpylon.com/library/${project.id}`,
    },
    relationships: {
      solar_project: { data: { type: 'solar_projects', id: project.id } },
      ...(designId ? { solar_design: { data: { type: 'solar_designs', id: designId } } } : {}),
    },
  },
};

const SECRET = 'dry-run-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pylon-dryrun-'));
const bridge = createApp({
  config: {
    ...config,
    dataDir,
    dryRun: true, // the whole point
    pylon: { ...config.pylon, webhookSecret: SECRET },
  },
  skipValidation: true,
});

const server = await new Promise((r) => {
  const s = bridge.app.listen(0, '127.0.0.1', () => r(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const body = JSON.stringify(event);
const signed = signWebhookBody({ rawBody: body, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) });
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
console.log(`\nPOST /webhooks/pylon -> HTTP ${response.status}`);
await bridge.queue.onIdle();

const record = bridge.store.get(event.data.id);
console.log(`  status: ${record.status}`);
if (record.error) console.log(`  error : ${record.error.message}`);
console.log('\n=== WHAT WOULD BE WRITTEN (nothing was) =====================');
console.log(JSON.stringify(record.result, null, 2));

bridge.queue.stop();
await new Promise((r) => server.close(r));
fs.rmSync(dataDir, { recursive: true, force: true });
