#!/usr/bin/env node
/**
 * Runs the whole flow against stand-in Pylon and GoHighLevel servers and prints
 * every request that crosses the wire. This is what generates docs/WALKTHROUGH.md.
 *
 *   node scripts/demo.js
 *
 * Nothing here touches a live account, so it is safe to run at any time — it is
 * the quickest way to see exactly what the bridge does with a signed contract.
 */
import { startFakeGhl, startFakePylon, readFixture } from '../test/helpers/upstreams.js';
import { makeConfig, postWebhook, startBridge } from '../test/helpers/bridge.js';

const isPayment = process.argv.includes('--payment');

const pylon = await startFakePylon();
// A payment arrives after the contract, so the opportunity already exists.
const ghl = await startFakeGhl(
  isPayment
    ? {
        existingOpportunities: [
          {
            id: 'opp-7788',
            name: '6.6 kW Solar + 10 kWh Battery - 19 Parmesan Avenue',
            status: 'open',
            updatedAt: '2026-08-25T02:11:05Z',
            customFields: [{ id: 'cf_ref', fieldValue: 'PYL-0003-7789' }],
          },
        ],
      }
    : {},
);
const config = makeConfig({ pylonBase: pylon.base, ghlBase: ghl.base });
const bridge = await startBridge(config);

const fixture = readFixture(isPayment ? 'event-payment.json' : 'event-signed.json');

line('='.repeat(78));
line(`STEP 1  Pylon delivers ${fixture.data.attributes.name}`);
line('='.repeat(78));
line(`POST ${bridge.base}/webhooks/pylon`);
line('Pylon-Webhook-Signature: hs256=<hmac-sha256 of "<timestamp>.<body>">');
line('Pylon-Webhook-Timestamp: <unix seconds>');
line('');
line(JSON.stringify(fixture, null, 2).split('\n').slice(0, 14).join('\n'));
line('  ...');
line('');

const started = Date.now();
const response = await postWebhook(bridge.base, fixture);
line(`<- HTTP ${response.status} in ${Date.now() - started}ms  ${JSON.stringify(response.json)}`);
line('   (acknowledged immediately — Pylon gives us 10 seconds; the work continues in the background)');
line('');

await bridge.queue.onIdle();

line('='.repeat(78));
line('STEP 2  The bridge reads the detail from Pylon');
line('='.repeat(78));
for (const call of pylon.calls) {
  line(`${call.method.padEnd(5)} ${call.path}`);
}
line('');

line('='.repeat(78));
line('STEP 3  The bridge writes to GoHighLevel');
line('='.repeat(78));
for (const call of ghl.calls) {
  const query = Object.keys(call.query).length ? `?${new URLSearchParams(call.query)}` : '';
  line(`${call.method.padEnd(5)} ${call.path}${query}`);
  if (call.body && call.body.multipart) {
    const name = /filename="([^"]+)"/.exec(call.body.raw)?.[1];
    const field = /name="([^"]+)"/.exec(call.body.raw)?.[1];
    line(`      multipart, ${call.body.bytes} bytes, form field "${field}", file "${name}"`);
  } else if (call.body) {
    line(
      JSON.stringify(call.body, null, 2)
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
  line('');
}

const record = bridge.store.get(fixture.data.id);
line('='.repeat(78));
line('STEP 4  The result, as recorded by the bridge');
line('='.repeat(78));
line(`GET ${bridge.base}/events/${record.id}   (Authorization: Bearer <ADMIN_TOKEN>)`);
line('');
line(
  JSON.stringify(
    { id: record.id, eventName: record.eventName, status: record.status, attempts: record.attempts, result: record.result },
    null,
    2,
  ),
);
line('');

await bridge.close();
await ghl.close();
await pylon.close();

function line(text) {
  process.stdout.write(`${text}\n`);
}
