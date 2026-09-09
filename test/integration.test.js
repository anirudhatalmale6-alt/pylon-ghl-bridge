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
  // 14 opportunity fields + the contract PDF as a file on the opportunity, plus
  // 3 on the contact.
  assert.equal(record.result.fieldsWritten, 18);
  assert.equal(
    oppFields.cf_o_file,
    'https://storage.googleapis.com/ghl/media-1.pdf',
    'the signed contract also lands as a file on the opportunity itself',
  );

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

// ---------------------------------------------------------------------------
// Webhook-only mode: Pylon only issues API tokens once their support team
// enables API access, so the bridge has to be useful before that happens.
// ---------------------------------------------------------------------------

const NO_PYLON_TOKEN = { pylon: { apiToken: '' } };

test('without a Pylon API token the contact, stage and Pylon link still land', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  const response = await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  assert.equal(response.status, 202);
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.equal(record.result.mode, 'webhook-only');

  assert.equal(
    h.pylon.calls.length,
    0,
    'with no token the bridge must not call Pylon at all, rather than calling it and failing',
  );

  const upsert = h.ghl.calls.find((c) => c.path === '/contacts/upsert');
  assert.ok(upsert, 'the contact is still written');
  assert.equal(upsert.body.email, 'andre@example.com');
  assert.equal(upsert.body.firstName, 'Andre');
  assert.equal(upsert.body.lastName, 'Rieu');

  const created = h.ghl.calls.find((c) => c.method === 'POST' && c.path === '/opportunities/');
  assert.ok(created, 'the opportunity is still created');
  assert.equal(created.body.pipelineStageId, 'stage-signed', 'and still moved to the signed stage');
});

test('webhook-only mode names the fields it could not fill instead of failing silently', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const { warnings } = h.bridge.store.get('oKcdQEqKvq962di').result;
  const joined = warnings.join(' ');
  assert.match(joined, /No Pylon API token is configured/);
  assert.match(joined, /contract value/);
  assert.match(joined, /signed contract PDF/);
  assert.match(joined, /Team Settings/, 'and says where to go to fix it');

  assert.equal(
    warnings.filter((w) => /no signed-contract PDF link/.test(w)).length,
    0,
    'the generic "no PDF" warning is suppressed — it would just repeat the cause',
  );
});

test('webhook-only mode does not invent a contract value', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const created = h.ghl.calls.find((c) => c.method === 'POST' && c.path === '/opportunities/');
  assert.equal(
    created.body.monetaryValue,
    undefined,
    'the contract value is not available without the API, so the field is left alone rather than zeroed',
  );
  assert.equal(h.bridge.store.get('oKcdQEqKvq962di').result.monetaryValue, null);

  const uploads = h.ghl.calls.filter((c) => c.path === '/medias/upload-file');
  assert.equal(uploads.length, 0, 'and no empty PDF is uploaded');
});

test('a payment with no customer details is matched to the contract that was signed earlier', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const contactId = h.bridge.store.get('oKcdQEqKvq962di').result.contactId;
  const opportunityId = h.bridge.store.get('oKcdQEqKvq962di').result.opportunityId;
  const callsBefore = h.ghl.calls.length;

  await postWebhook(h.bridge.base, readFixture('event-payment.json'));
  await h.bridge.queue.onIdle();

  const payment = h.bridge.store.get('D1yqsg0HLER0sMiS');
  assert.equal(payment.status, 'succeeded', JSON.stringify(payment.error));
  assert.equal(payment.result.matchedVia, 'pylon-project-link');
  assert.equal(payment.result.contactId, contactId, 'the same contact, found via the stored project link');
  assert.equal(payment.result.opportunityId, opportunityId);
  assert.equal(payment.result.amount, 1560, 'the amount comes straight out of the webhook body');

  const after = h.ghl.calls.slice(callsBefore);
  assert.equal(
    after.filter((c) => c.path === '/contacts/upsert').length,
    0,
    'no upsert — there is no email in a payment event, so upserting would create a blank duplicate',
  );
  const tagCall = after.find((c) => c.method === 'POST' && c.path === `/contacts/${contactId}/tags`);
  assert.ok(tagCall, 'the contact is tagged through the additive endpoint');
  assert.deepEqual(tagCall.body.tags, ['payment-received']);

  const oppUpdate = after.find((c) => c.method === 'PUT' && c.path === `/opportunities/${opportunityId}`);
  assert.ok(oppUpdate, 'the payment is written onto the opportunity');
  assert.equal(oppUpdate.body.monetaryValue, undefined, 'a deposit must never overwrite the contract value');
});

test('a payment for a project that was never signed here is skipped, not guessed at', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  // No signed event first, so there is no link to resolve.
  await postWebhook(h.bridge.base, readFixture('event-payment.json'));
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('D1yqsg0HLER0sMiS');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.result.skipped, true);
  assert.match(record.result.reason, /has not been through a contract-signed event/);
  assert.equal(
    h.ghl.calls.filter((c) => c.method !== 'GET').length,
    0,
    'nothing at all is written when the payer cannot be identified',
  );
});

test('the project link survives a restart', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const expected = h.bridge.store.lookupProject('rukSigcyTR');
  assert.ok(expected?.contactId, 'the link is recorded');

  // Same data directory, fresh store — this is what a service restart does.
  const { EventStore } = await import('../src/store.js');
  const reopened = new EventStore({ dataDir: h.config.dataDir, retentionDays: 90 });
  assert.deepEqual(reopened.lookupProject('rukSigcyTR'), expected);
});

test('health reports webhook-only mode as healthy, not broken', async (t) => {
  const h = await harness({ config: NO_PYLON_TOKEN });
  t.after(() => h.close());

  const response = await fetch(`${h.bridge.base}/health?deep=1`, {
    headers: { Authorization: `Bearer ${h.config.adminToken}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'webhook-only');
  assert.equal(body.checks.pylon.skipped, true);
  assert.equal(body.checks.goHighLevel.ok, true, 'GoHighLevel is still genuinely probed');
  assert.match(body.warnings.join(' '), /webhook-only mode/);
});

test('a Pylon token restores the full picture — same event, contract value and PDF land', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const result = h.bridge.store.get('oKcdQEqKvq962di').result;
  assert.equal(result.mode, 'full');
  assert.equal(result.monetaryValue, 15600);
  assert.ok(result.contractFileUrl, 'and the PDF is re-hosted');
});

// ---------------------------------------------------------------------------
// Staged invoicing. The business bills 10% on signing, 60% before install and
// 10% on the day, so a contract produces three invoices, not one.
// ---------------------------------------------------------------------------

const INVOICING_ON = { ghl: { createInvoice: true } };

test('no invoice is raised unless invoicing is switched on', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  assert.equal(h.ghl.calls.filter((c) => c.path === '/invoices/').length, 0);
  assert.deepEqual(h.bridge.store.get('oKcdQEqKvq962di').result.invoices, []);
});

test('signing raises only the deposit, at 10% of the contract', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
  assert.deepEqual(record.result.warnings, []);

  const posts = h.ghl.findAll('POST', '/invoices/');
  assert.equal(posts.length, 1, 'the 60% and 10% stages are not billed on the day of signing');

  assert.equal(record.result.invoices.length, 1);
  assert.equal(record.result.invoices[0].key, 'deposit');
  assert.equal(record.result.invoices[0].amount, 1560, '10% of $15,600');

  const call = posts[0];
  assert.equal(call.headers.version, '2021-04-15', 'the Invoices API is versioned separately from the rest of v2');
  assert.equal(call.body.items.length, 1);
  assert.equal(call.body.items[0].amount, 1560);
  assert.equal(call.body.currency, 'AUD');
  assert.equal(call.body.contactDetails.id, 'contact-1');
  assert.equal(call.body.businessDetails.name, 'Test Solar Co');
});

test('the later stages are raised on demand, each for its own share', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const opportunityId = h.bridge.store.get('oKcdQEqKvq962di').result.opportunityId;

  const call = async (stage) => {
    const response = await fetch(`${h.bridge.base}/invoices/${stage}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.adminToken}` },
      body: JSON.stringify({ opportunityId }),
    });
    return { status: response.status, json: await response.json() };
  };

  const pre = await call('pre_install');
  assert.equal(pre.status, 200, JSON.stringify(pre.json));
  assert.equal(pre.json.ok, true);
  assert.equal(pre.json.invoices[0].amount, 9360, '60% of $15,600');

  const install = await call('installation');
  assert.equal(install.json.invoices[0].amount, 1560, '10% of $15,600');

  assert.equal(h.ghl.findAll('POST', '/invoices/').length, 3, 'three invoices for one contract');

  // The three stages bill 80% of the contract — the mapping says so out loud.
  const bodies = h.ghl.findAll('POST', '/invoices/').map((c) => c.body.items[0].amount);
  assert.equal(bodies.reduce((a, b) => a + b, 0), 12480);
});

test('the contract total is remembered, so a later stage needs no Pylon call', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const pylonCallsAfterSigning = h.pylon.calls.length;

  await fetch(`${h.bridge.base}/invoices/pre_install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.adminToken}` },
    body: JSON.stringify({ contactId: 'contact-1' }),
  });

  assert.equal(h.pylon.calls.length, pylonCallsAfterSigning, 'Pylon is not touched to raise a later invoice');
});

test('a payment stage is never billed twice', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const opportunityId = h.bridge.store.get('oKcdQEqKvq962di').result.opportunityId;

  const body = JSON.stringify({ opportunityId });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.adminToken}` };
  const first = await (await fetch(`${h.bridge.base}/invoices/pre_install`, { method: 'POST', headers, body })).json();
  const second = await (await fetch(`${h.bridge.base}/invoices/pre_install`, { method: 'POST', headers, body })).json();

  assert.equal(
    h.ghl.findAll('POST', '/invoices/').length,
    2,
    'the deposit plus ONE pre-install invoice — a workflow firing twice must not bill twice',
  );
  assert.equal(second.invoices[0].alreadyExisted, true);
  assert.equal(second.invoices[0].id, first.invoices[0].id);
});

test('a redelivered signature does not raise a second deposit', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  h.bridge.store.update('oKcdQEqKvq962di', { status: 'received', attempts: 0 });
  h.bridge.queue.enqueue('oKcdQEqKvq962di');
  await h.bridge.queue.onIdle();

  assert.equal(h.ghl.findAll('POST', '/invoices/').length, 1);
});

test('invoicing a customer with no signed contract on record is refused', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  const response = await fetch(`${h.bridge.base}/invoices/pre_install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.adminToken}` },
    body: JSON.stringify({ opportunityId: 'never-seen-this' }),
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /No signed contract is on record/);
  assert.equal(h.ghl.findAll('POST', '/invoices/').length, 0);
});

test('an unknown payment stage lists the ones that exist', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const response = await fetch(`${h.bridge.base}/invoices/final_payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.adminToken}` },
    body: JSON.stringify({ contactId: 'contact-1' }),
  });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /deposit, pre_install, installation/);
});

test('the invoice endpoint requires the admin token', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  const response = await fetch(`${h.bridge.base}/invoices/pre_install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactId: 'contact-1' }),
  });
  assert.equal(response.status, 401, 'anyone who can reach this URL could otherwise bill a customer');
  assert.equal(h.ghl.findAll('POST', '/invoices/').length, 0);
});

test('an invoice is not emailed to the customer unless that is asked for', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  assert.equal(
    h.ghl.calls.filter((c) => /\/send$/.test(c.path)).length,
    0,
    'default is a draft — auto-emailing a customer the moment they sign is the business\'s call, not mine',
  );
  assert.equal(h.bridge.store.get('oKcdQEqKvq962di').result.invoices[0].sent, false);
});

test('the invoice is sent when an action is configured', async (t) => {
  const h = await harness({ config: { ghl: { createInvoice: true, invoiceSendAction: 'email' } } });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const send = h.ghl.find('POST', '/invoices/inv-1/send');
  assert.ok(send, 'the send endpoint was called');
  assert.equal(send.body.action, 'email');
  assert.equal(send.headers.version, '2021-04-15');
  assert.equal(h.bridge.store.get('oKcdQEqKvq962di').result.invoices[0].sent, true);
});

test('a missing invoices.write scope names the scope and does not fail the event', async (t) => {
  const h = await harness({ ghl: { invoiceScope: false }, config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(record.status, 'succeeded', 'the signature still lands — an invoice failure must not lose the contract');
  assert.deepEqual(record.result.invoices, []);
  assert.equal(record.result.monetaryValue, 15600, 'and the opportunity value is still set');
  assert.match(record.result.warnings.join(' '), /invoices\.write/);
});

test('webhook-only mode does not invoice a contract whose value is unknown', async (t) => {
  const h = await harness({ config: { ...NO_PYLON_TOKEN, ghl: { createInvoice: true } } });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const record = h.bridge.store.get('oKcdQEqKvq962di');
  assert.equal(h.ghl.calls.filter((c) => c.path === '/invoices/').length, 0);
  assert.match(record.result.warnings.join(' '), /contract value is only readable through the Pylon API/);
});

test('payment stages that do not add up to 100% are reported', async (t) => {
  const { checkInvoiceStages } = await import('../src/mapping.js');

  const shipped = checkInvoiceStages({
    events: { signed: { invoices: { stages: [{ key: 'a', percent: 10 }, { key: 'b', percent: 60 }, { key: 'c', percent: 10 }] } } },
  });
  assert.equal(shipped.length, 1);
  assert.match(shipped[0], /add up to 80% of the contract, not 100%/);
  assert.match(shipped[0], /\$8,000/, 'and says what that means in money');

  const balanced = checkInvoiceStages({
    events: { signed: { invoices: { stages: [{ key: 'a', percent: 10 }, { key: 'b', percent: 60 }, { key: 'c', percent: 30 }] } } },
  });
  assert.deepEqual(balanced, [], 'control: 10 + 60 + 30 is silent');

  const duped = checkInvoiceStages({
    events: { signed: { invoices: { stages: [{ key: 'a', percent: 50 }, { key: 'a', percent: 50 }] } } },
  });
  assert.match(duped[0], /reuse the key/, 'duplicate keys break the bill-once guard');
});

test('no Stripe payment-method block is sent when none is configured', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const deposit = h.ghl.find('POST', '/invoices/');
  assert.equal(
    deposit.body.paymentMethods,
    undefined,
    'a business taking bank transfers has no Stripe account, so posting a Stripe preference would be noise',
  );
});

test('an invoice carries the bank details so the customer knows where to pay', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const deposit = h.ghl.find('POST', '/invoices/');
  assert.match(deposit.body.termsNotes, /bank transfer/i);
  assert.match(
    deposit.body.termsNotes,
    /PYL-0003-7789/,
    'the Pylon reference is templated in, so an incoming transfer can be matched to the job',
  );
});

test('each payment stage can still choose card or bank debit when Stripe is used', async (t) => {
  const h = await harness({ config: INVOICING_ON });
  t.after(() => h.close());

  const stages = h.bridge.processor.mapping.events['web_proposals.signed'].invoices.stages;
  stages.find((s) => s.key === 'deposit').bankDebitOnly = false;
  stages.find((s) => s.key === 'pre_install').bankDebitOnly = true;

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();
  const opportunityId = h.bridge.store.get('oKcdQEqKvq962di').result.opportunityId;

  await fetch(`${h.bridge.base}/invoices/pre_install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.config.adminToken}` },
    body: JSON.stringify({ opportunityId }),
  });

  const [deposit, preInstall] = h.ghl.findAll('POST', '/invoices/');
  assert.equal(deposit.body.paymentMethods.stripe.enableBankDebitOnly, false);
  assert.equal(
    preInstall.body.paymentMethods.stripe.enableBankDebitOnly,
    true,
    'Stripe AU caps bank debit at $3.50 but charges 1.7% on a card — ~$159 on $9,360',
  );
});

test('the global bank-debit default applies to a stage that does not state one', async (t) => {
  const h = await harness({ config: { ghl: { createInvoice: true, invoiceBankDebitOnly: true } } });
  t.after(() => h.close());

  // Drop the per-stage setting so the global default is what is under test.
  const mapping = h.bridge.processor.mapping;
  const stages = mapping.events['web_proposals.signed'].invoices.stages;
  for (const stage of stages) delete stage.bankDebitOnly;

  await postWebhook(h.bridge.base, readFixture('event-signed.json'));
  await h.bridge.queue.onIdle();

  const deposit = h.ghl.find('POST', '/invoices/');
  assert.equal(deposit.body.paymentMethods.stripe.enableBankDebitOnly, true);
});
