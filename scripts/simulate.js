#!/usr/bin/env node
/**
 * Fires a correctly-signed webhook at a running bridge, exactly as Pylon would.
 *
 *   npm run simulate                                  # signed-contract event
 *   npm run simulate -- --event payment               # gateway payment event
 *   npm run simulate -- --url https://bridge.example.com/webhooks/pylon
 *   npm run simulate -- --file ./some-real-event.json # replay a captured body
 *   npm run simulate -- --bad-signature               # prove the guard works
 *
 * Useful for proving the endpoint is reachable and the secret matches before a
 * real contract is put through.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, projectRoot } from '../src/config.js';
import { signWebhookBody } from '../src/pylon.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = arg('url', `http://127.0.0.1:${config.port}/webhooks/pylon`);
const eventKind = arg('event', 'signed');
const file = arg('file');
const badSignature = process.argv.includes('--bad-signature');
const staleTimestamp = process.argv.includes('--stale');

const fixture =
  file ??
  path.join(projectRoot, 'test', 'fixtures', eventKind === 'payment' ? 'event-payment.json' : 'event-signed.json');

if (!fs.existsSync(fixture)) {
  console.error(`No such file: ${fixture}`);
  process.exit(1);
}

if (!config.pylon.webhookSecret) {
  console.error('PYLON_WEBHOOK_SECRET is not set — the bridge would reject this request anyway.');
  process.exit(1);
}

const body = fs.readFileSync(fixture, 'utf8');
const timestamp = staleTimestamp
  ? Math.floor(Date.now() / 1000) - (config.pylon.toleranceSeconds + 120)
  : Math.floor(Date.now() / 1000);

const { signature } = signWebhookBody({
  rawBody: body,
  secret: badSignature ? `${config.pylon.webhookSecret}-wrong` : config.pylon.webhookSecret,
  timestamp,
});

console.log(`POST ${url}`);
console.log(`  fixture:   ${path.relative(projectRoot, fixture)}`);
console.log(`  event:     ${JSON.parse(body)?.data?.attributes?.name}`);
console.log(`  signature: ${badSignature ? 'DELIBERATELY WRONG' : 'valid'}`);
console.log(`  timestamp: ${staleTimestamp ? 'DELIBERATELY STALE' : 'now'}`);
console.log('');

try {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Pylon Webhooks (simulated)',
      'Pylon-Webhook-Signature': signature,
      'Pylon-Webhook-Timestamp': String(timestamp),
      'Pylon-Webhook-Version': '2021-07',
    },
    body,
  });
  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(text);
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.error(`Could not reach the bridge at ${url}: ${error.message}`);
  process.exit(1);
}
