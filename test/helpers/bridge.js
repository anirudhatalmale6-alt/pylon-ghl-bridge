import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { signWebhookBody } from '../../src/pylon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

export const WEBHOOK_SECRET = 'whsec_integration_test';

export function makeConfig({ pylonBase, ghlBase, overrides = {} }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pylon-ghl-test-'));
  return {
    port: 0,
    nodeEnv: 'test',
    dataDir,
    mappingFile: path.join(projectRoot, 'config', 'mapping.json'),
    adminToken: 'admin-test-token',
    dryRun: false,
    pylon: {
      apiBase: pylonBase,
      apiToken: 'pylon-test-token',
      webhookSecret: WEBHOOK_SECRET,
      toleranceSeconds: 300,
      timeoutMs: 5000,
      ...(overrides.pylon ?? {}),
    },
    ghl: {
      apiBase: ghlBase,
      apiToken: 'ghl-test-token',
      apiVersion: '2021-07-28',
      locationId: 'loc-test',
      timeoutMs: 5000,
      pipelineId: '',
      pipelineName: 'Solar Sales',
      signedStageId: '',
      signedStageName: 'Contract Signed',
      paidStageId: '',
      paidStageName: 'Deposit Paid',
      statusOnSigned: 'open',
      mediaFolderId: '',
      contractFileFieldKey: 'contact.signed_contract_file',
      uploadContractFile: true,
      addNote: true,
      // Mirror the production defaults in src/config.js, or the harness silently
      // tests a different configuration from the one that ships.
      createInvoice: false,
      invoiceSendAction: 'none',
      invoiceUserId: '',
      invoiceDueDays: 7,
      invoiceLiveMode: true,
      invoiceBankDebitOnly: undefined,
      ...(overrides.ghl ?? {}),
    },
    callback: { url: '', secret: '', timeoutMs: 2000 },
    queue: { maxAttempts: 1, backoffSeconds: [1], concurrency: 1 },
    retentionDays: 90,
    // pylon and ghl are merged above, so drop them here rather than letting the
    // top-level spread replace the whole block.
    ...(({ pylon, ghl, ...rest }) => rest)(overrides),
  };
}

export async function startBridge(config) {
  const bridge = createApp({ config, skipValidation: true });
  const server = await new Promise((resolve) => {
    const s = bridge.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...bridge,
    base,
    close: async () => {
      bridge.queue.stop();
      await new Promise((r) => server.close(r));
      fs.rmSync(config.dataDir, { recursive: true, force: true });
    },
  };
}

export async function postWebhook(base, fixtureBody, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = typeof fixtureBody === 'string' ? fixtureBody : JSON.stringify(fixtureBody);
  const signed = signWebhookBody({ rawBody: body, secret, timestamp });
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
  return { status: response.status, json: await response.json().catch(() => null) };
}
