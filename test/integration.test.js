import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGhl, startFakePylon, readFixture, SAMPLE_PDF } from './helpers/upstreams.js';
import { makeConfig, postWebhook, startBridge, WEBHOOK_SECRET } from './helpers/bridge.js';

/**
 * End-to-end: a signed Pylon webhook goes in one end, and the exact HTTP calls
 * GoHighLevel would receive come out the other. Both upstreams are real HTTP
 * servers, so the multipart uploads, headers and query strings are all genuine.
 */

async function harness(options = {}) {
  const pylon = await startFakePylon(options.pylon ?? {});
  const ghl = await startFakeGhl(options.ghl ?? {});
  const config = makeConfig({ pylonBase: pylon.base, ghlBase: ghl.base, overrides: options.config ?? {} });
  const bridge = await startBridge(config);
  return {
    pylon,
    ghl,
    bridge,
    config,
    close: async () => {
      await bridge.close();
      await ghl.close();
      await pylon.close();
    },
  };
}

test('a signed contract lands in GoHighLevel end to end', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  assert.equal(response.status, 202, 'the webhook is acknowledged immediately, inside Pylon\'s 10s budget');
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.deepEqual(record.result.warnings, []);

  // --- the contract PDF was fetched from Pylon and re-hosted in GHL ---------
  const upload = h.ghl.find('POST', '/medias/upload-file');
  assert.ok(upload, 'the contract PDF is uploaded to the media library');
  assert.equal(upload.query.altId, 'loc-test');
  assert.equal(upload.query.altType, 'location');
  assert.ok(upload.body.raw.includes('%PDF-1.4'), 'the real PDF bytes are sent, not a placeholder');
  assert.ok(upload.body.raw.includes('Signed Contract - PYL-0003-7789 - Andre Rieu.pdf'));
  assert.equal(record.result.contractFileUrl, 'https://storage.googleapis.com/ghl/media-1.pdf');
  assert.equal(record.result.contractFileBytes, SAMPLE_PDF.length);

  // --- the file itself is attached to the contact record -------------------
  const attach = h.ghl.find('POST', '/forms/upload-custom-files');
  assert.ok(attach, 'the PDF is attached to the contact custom field');
  assert.equal(attach.query.contactId, 'contact-1');
  assert.equal(attach.query.locationId, 'loc-test');
  assert.match(attach.body.raw, /name="cf_c_file_[0-9a-f-]{36}"/, 'the form field carries <fieldId>_<uuid>');
  assert.equal(record.result.contractAttachedToContact, true);

  // --- the contact -------------------------------------------------------
  const upsert = h.ghl.find('POST', '/contacts/upsert');
  assert.equal(upsert.headers.version, '2021-07-28');
  assert.equal(upsert.body.locationId, 'loc-test');
  assert.equal(upsert.body.firstName, 'Andre');
  assert.equal(upsert.body.lastName, 'Rieu');
  assert.equal(upsert.body.email, 'andre@example.com');
  assert.equal(upsert.body.phone, '0400 000 000');
  assert.equal(upsert.body.address1, '19 Parmesan Avenue');
  assert.equal(upsert.body.postalCode, '3147');
  assert.equal(upsert.body.country, 'AU');
  assert.deepEqual(upsert.body.tags, ['contract-signed']);
  const contactFields = Object.fromEntries(upsert.body.customFields.map((f) => [f.id, f.value]));
  assert.equal(contactFields.cf_c_ref, 'PYL-0003-7789');
  assert.equal(contactFields.cf_c_pdf, 'https://storage.googleapis.com/ghl/media-1.pdf');

  // --- the opportunity ---------------------------------------------------
  const created = h.ghl.find('POST', '/opportunities/');
  assert.ok(created, 'no opportunity existed, so one was created');
  assert.equal(created.body.pipelineId, 'pipe-1');
  assert.equal(created.body.pipelineStageId, 'stage-signed');
  assert.equal(created.body.contactId, 'contact-1');
  assert.equal(created.body.status, 'open');
  assert.equal(created.body.monetaryValue, 15600, 'the opportunity value is the contract total in dollars');
  assert.equal(created.body.name, '6.6 kW Solar + 10 kWh Battery - 19 Parmesan Avenue');

  const oppFields = Object.fromEntries(created.body.customFields.map((f) => [f.id, f.fieldValue]));
  assert.equal(oppFields.cf_ref, 'PYL-0003-7789');
  assert.equal(oppFields.cf_val, 15600);
  assert.equal(oppFields.cf_cur, 'AUD');
  assert.equal(oppFields.cf_date, '2026-08-25');
  assert.equal(oppFields.cf_by, 'Andre Rieu');
  assert.equal(oppFields.cf_byemail, 'andre@example.com');
  assert.equal(oppFields.cf_pdf, 'https://storage.googleapis.com/ghl/media-1.pdf');
  assert.equal(oppFields.cf_kw, 6.6);
  assert.equal(oppFields.cf_kwh, 10);
  assert.equal(oppFields.cf_dep, '$1,560.00');
  assert.equal(oppFields.cf_pay, '$14,040.00');
  assert.equal(oppFields.cf_addr, '19 Parmesan Avenue, Glen Iris, Victoria, 3147');

  // All three data sets present: contract, client, payment terms.
  assert.equal(record.result.fieldsWritten, 17);

  // --- the human-readable note -------------------------------------------
  const note = h.ghl.find('POST', '/contacts/contact-1/notes');
  assert.ok(note.body.body.includes('Contract value: $15,600.00'));
  assert.ok(note.body.body.includes('PYL-0003-7789'));
});

test('control: an unsigned request writes nothing at all', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.bridge.base}/webhooks/pylon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readFixture('event-signed.json')),
  });
  assert.equal(response.status, 401);
  await h.bridge.queue.onIdle();
  assert.equal(h.ghl.calls.length, 0, 'GoHighLevel is never touched');
  assert.equal(h.pylon.calls.length, 0, 'Pylon is never touched');
});

test('control: a request signed with the wrong secret writes nothing', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await postWebhook(h.bridge.base, readFixture('event-signed.json'), { secret: 'not-the-secret' });
  assert.equal(response.status, 401);
  assert.match(response.json.error, /does not match/i);
  assert.equal(h.ghl.calls.length, 0);
});

test('Pylon retrying the same event does not create a second opportunity', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const first = await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const second = await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(h.ghl.findAll('POST', '/opportunities/').length, 1);
});

test('an existing opportunity is updated rather than duplicated', async (t) => {
  const h = await harness({
    ghl: {
      existingOpportunities: [
        { id: 'opp-existing', name: 'Andre Rieu', status: 'open', updatedAt: '2026-08-01T00:00:00Z', customFields: [] },
      ],
    },
  });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  assert.equal(h.ghl.findAll('POST', '/opportunities/').length, 0, 'nothing new is created');
  const updated = h.ghl.find('PUT', '/opportunities/opp-existing');
  assert.ok(updated);
  assert.equal(updated.body.monetaryValue, 15600);
  assert.equal(updated.body.pipelineStageId, 'stage-signed');
  assert.equal(updated.body.pipelineId, 'pipe-1', 'GHL needs the pipeline id alongside a stage move');

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.result.opportunityCreated, false);
  assert.equal(record.result.opportunityId, 'opp-existing');
});

test('the opportunity already carrying this Pylon reference wins over a newer one', async (t) => {
  const h = await harness({
    ghl: {
      existingOpportunities: [
        { id: 'opp-newer', name: 'Unrelated deal', status: 'open', updatedAt: '2026-08-24T00:00:00Z', customFields: [] },
        {
          id: 'opp-matching',
          name: 'Original quote',
          status: 'open',
          updatedAt: '2026-01-01T00:00:00Z',
          customFields: [{ id: 'cf_ref', fieldValue: 'PYL-0003-7789' }],
        },
      ],
    },
  });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  assert.ok(h.ghl.find('PUT', '/opportunities/opp-matching'));
  assert.equal(h.ghl.find('PUT', '/opportunities/opp-newer'), undefined);
});

test('an expired contract PDF link degrades to a warning, the value still updates', async (t) => {
  const h = await harness({ pylon: { failPdf: true } });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.result.contractFileUrl, null);
  assert.equal(record.result.warnings.length, 1);
  assert.match(record.result.warnings[0], /Could not download the contract PDF/);

  const created = h.ghl.find('POST', '/opportunities/');
  assert.equal(created.body.monetaryValue, 15600, 'the money still lands even when the document does not');
  assert.equal(h.ghl.find('POST', '/forms/upload-custom-files'), undefined);
});

test('GoHighLevel being unreachable produces a plain-English failure', async (t) => {
  // Point the client at a port with nothing behind it.
  const pylon = await startFakePylon();
  const config = makeConfig({ pylonBase: pylon.base, ghlBase: 'http://127.0.0.1:59999' });
  const bridge = await startBridge(config);
  t.after(async () => {
    await bridge.close();
    await pylon.close();
  });

  await postWebhook(bridge.base, readFixture('event-signed.json'));
  await bridge.queue.onIdle();

  const record = bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'failed');
  assert.match(record.error.summary, /GoHighLevel is unreachable/);
  assert.equal(record.error.kind, 'unreachable');
  assert.equal(record.error.retryable, true);
});

test('a bad GoHighLevel token names the problem', async (t) => {
  const pylon = await startFakePylon();
  const ghl = await startFakeGhl();
  const config = makeConfig({ pylonBase: pylon.base, ghlBase: ghl.base });
  config.ghl.apiToken = 'ghl-wrong-token';
  const bridge = await startBridge(config);
  t.after(async () => {
    await bridge.close();
    await ghl.close();
    await pylon.close();
  });

  await postWebhook(bridge.base, readFixture('event-signed.json'));
  await bridge.queue.onIdle();

  const record = bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'failed');
  assert.match(record.error.summary, /rejected the credentials/);
  assert.equal(record.error.kind, 'auth');
  assert.equal(record.error.retryable, false, 'a bad token is not worth retrying for 31 hours');
});

test('a customer with no email and no phone fails with an actionable message', async (t) => {
  const h = await harness({
    pylon: { projectOverrides: { customer_details: { name: 'No Contact Details', phone: '', email: '' } } },
  });
  t.after(() => h.close());

  const event = readFixture('event-signed.json');
  delete event.data.attributes.customer_email;
  await postWebhook(h.bridge.base, event);
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'failed');
  assert.match(record.error.summary, /Neither an email address nor a phone number/);
  assert.equal(h.ghl.find('POST', '/contacts/upsert'), undefined);
});

test('a payment event updates the payment fields and moves the stage', async (t) => {
  const h = await harness({
    ghl: {
      existingOpportunities: [
        { id: 'opp-existing', name: 'Andre Rieu', status: 'open', updatedAt: '2026-08-25T00:00:00Z', customFields: [] },
      ],
    },
  });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-payment.json'));
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('D1yqsg0HLER0sMiS');
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.equal(record.result.amount, 1560);

  const updated = h.ghl.find('PUT', '/opportunities/opp-existing');
  const fields = Object.fromEntries(updated.body.customFields.map((f) => [f.id, f.fieldValue]));
  assert.equal(fields.cf_prec, 1560);
  assert.equal(fields.cf_ptype, 'Deposit');
  assert.equal(fields.cf_pdate, '2026-08-25');
  assert.match(fields.cf_precpt, /^https:\/\/receipts/);
  assert.equal(updated.body.pipelineStageId, 'stage-paid');
  assert.equal(updated.body.monetaryValue, undefined, 'a deposit must not overwrite the contract value');
});

test('an event type with no mapping is acknowledged and ignored', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const event = readFixture('event-signed.json');
  event.data.id = 'evt-unmapped';
  event.data.attributes.name = 'solar_projects.updated';

  await postWebhook(h.bridge.base, event);
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('evt-unmapped');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.result.skipped, true);
  assert.equal(h.ghl.calls.length, 0);
});

test('the inspection endpoints need the admin token', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const anonymous = await fetch(`${h.bridge.base}/events`);
  assert.equal(anonymous.status, 401);

  const authorised = await fetch(`${h.bridge.base}/events`, {
    headers: { Authorization: 'Bearer admin-test-token' },
  });
  assert.equal(authorised.status, 200);
  const body = await authorised.json();
  assert.equal(body.ok, true);
});

test('/mapping shows which mapping lines resolve to a real field', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.bridge.base}/mapping`, { headers: { Authorization: 'Bearer admin-test-token' } });
  const body = await response.json();
  const opportunity = body.resolved['web_proposals.signed'].opportunity;
  assert.ok(opportunity.every((line) => line.resolved), 'every shipped mapping line matches a field');
  assert.equal(opportunity.find((l) => l.mappingKey === 'opportunity.contract_value').fieldId, 'cf_val');
});

test('a replay re-runs a failed event once the cause is fixed', async (t) => {
  const pylon = await startFakePylon();
  const ghl = await startFakeGhl();
  const config = makeConfig({ pylonBase: pylon.base, ghlBase: ghl.base });
  config.ghl.apiToken = 'ghl-wrong-token';
  const bridge = await startBridge(config);
  t.after(async () => {
    await bridge.close();
    await ghl.close();
    await pylon.close();
  });

  await postWebhook(bridge.base, readFixture('event-signed.json'));
  await bridge.queue.onIdle();
  assert.equal(bridge.store.get('oKcdQEqKvq962di').status, 'failed');

  // Operator fixes the token and replays, without Pylon having to re-send.
  bridge.ghl.apiToken = 'ghl-test-token';
  const replay = await fetch(`${bridge.base}/events/oKcdQEqKvq962di/replay`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-test-token' },
  });
  assert.equal(replay.status, 202);
  await bridge.queue.onIdle();

  assert.equal(bridge.store.get('oKcdQEqKvq962di').status, 'succeeded');
  assert.equal(ghl.findAll('POST', '/opportunities/').length, 1);
});

test('DRY_RUN reads from Pylon but writes nothing to GoHighLevel', async (t) => {
  const h = await harness({ config: { dryRun: true } });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  assert.equal(h.bridge.store.get('oKcdQEqKvq962di').status, 'succeeded');
  assert.ok(h.pylon.calls.some((c) => c.path.startsWith('/v1/solar_projects/')), 'Pylon is still read');
  const writes = h.ghl.calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes, [], 'no write ever reaches GoHighLevel');
});

test('the webhook secret guard also rejects a stale replay', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const stale = Math.floor(Date.now() / 1000) - 3600;
  const response = await postWebhook(h.bridge.base, readFixture('event-signed.json'), {
    secret: WEBHOOK_SECRET,
    timestamp: stale,
  });
  assert.equal(response.status, 401);
  assert.match(response.json.error, /timestamp/i);
});
