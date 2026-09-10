import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig, startBridge } from './helpers/bridge.js';
import { tokenMatches, describe as describeEvent, formbayNumber } from '../src/formbay.js';

const TOKEN = 'fbwh_test_token_value';

async function bridgeWith(formbay) {
  const config = makeConfig({ pylonBase: 'http://127.0.0.1:1', ghlBase: 'http://127.0.0.1:1', overrides: { formbay } });
  return startBridge(config);
}

function post(base, { body = {}, headers = {}, query = '' } = {}) {
  return fetch(`${base}/webhooks/formbay${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('the test ping Formbay sends before saving is answered with a 2xx', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    const res = await post(bridge.base, {
      body: { event: 'webhook.test' },
      headers: { 'x-formbay-token': TOKEN },
    });
    // Formbay only CREATES the webhook when this comes back 2xx, so a
    // non-2xx here means the client cannot save the configuration at all.
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.test, true);
  } finally {
    await bridge.close();
  }
});

test('an unconfigured token rejects everything rather than accepting everything', async () => {
  // The default config ships with no token. An empty-vs-empty comparison that
  // returned true would leave this endpoint open to anyone who found the URL.
  const bridge = await bridgeWith({ webhookToken: '' });
  try {
    const withNothing = await post(bridge.base, { body: { event: 'webhook.test' } });
    assert.equal(withNothing.status, 401);

    // The dangerous case: presenting an empty token against an empty expectation.
    const withEmpty = await post(bridge.base, {
      body: { event: 'webhook.test' },
      headers: { 'x-formbay-token': '' },
    });
    assert.equal(withEmpty.status, 401);

    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches(undefined, undefined), false);
  } finally {
    await bridge.close();
  }
});

test('a wrong token is rejected and nothing is recorded', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    const res = await post(bridge.base, {
      body: { event: 'job.updated', job: { id: 'j1' } },
      headers: { 'x-formbay-token': `${TOKEN}-not-quite` },
    });
    assert.equal(res.status, 401);

    const listed = await fetch(`${bridge.base}/formbay/events`, {
      headers: { authorization: 'Bearer admin-test-token' },
    }).then((r) => r.json());
    assert.equal(listed.total, 0, 'a rejected delivery must not be written to the log');
  } finally {
    await bridge.close();
  }
});

test('the query-parameter option Formbay offers also authenticates', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    const res = await post(bridge.base, { body: { event: 'job.created' }, query: `?token=${TOKEN}` });
    assert.equal(res.status, 200);
  } finally {
    await bridge.close();
  }
});

test('a custom header name is honoured, and the default name then stops working', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN, webhookHeader: 'x-inspire-secret' });
  try {
    const right = await post(bridge.base, {
      body: { event: 'job.updated' },
      headers: { 'x-inspire-secret': TOKEN },
    });
    assert.equal(right.status, 200);

    // Control: the same token under the DEFAULT header must now fail, or the
    // header setting is not actually being read.
    const wrongHeader = await post(bridge.base, {
      body: { event: 'job.updated' },
      headers: { 'x-formbay-token': TOKEN },
    });
    assert.equal(wrongHeader.status, 401);
  } finally {
    await bridge.close();
  }
});

test('every delivery is stored verbatim so the payload shape can be read off a real one', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    const body = {
      event: 'job.updated',
      job: { id: 'JOB-1', number: 'BSTC139157', status: 'sold', unexpected: { nested: [1, 2] } },
    };
    await post(bridge.base, { body, headers: { 'x-formbay-token': TOKEN } });

    const listed = await fetch(`${bridge.base}/formbay/events`, {
      headers: { authorization: 'Bearer admin-test-token' },
    }).then((r) => r.json());

    assert.equal(listed.total, 1);
    const [entry] = listed.events;
    assert.equal(entry.event, 'job.updated');
    assert.equal(entry.formbayNumber, 'BSTC139157');
    assert.equal(entry.status, 'sold');
    // Nothing is dropped — including fields we did not anticipate.
    assert.deepEqual(entry.body, body);
    assert.deepEqual(listed.byEvent, { 'job.updated': 1 });
  } finally {
    await bridge.close();
  }
});

test('the event log is behind the admin token', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    const res = await fetch(`${bridge.base}/formbay/events`);
    assert.equal(res.status, 401);
  } finally {
    await bridge.close();
  }
});

test('an unrecognised payload shape still records rather than throwing away', () => {
  // `formId` rather than `jobId`: Formbay's own payload calls it "formid", and
  // matching their vocabulary avoids a second name for the same thing. The
  // fallbacks for older guessed shapes still feed it.
  const summary = describeEvent({ type: 'doc.updated', data: { job_id: 'x9' } });
  assert.equal(summary.event, 'doc.updated');
  assert.equal(summary.isTest, false);
  assert.equal(summary.formId, 'x9');
  assert.equal(summary.formbayNumber, null, 'nothing is invented when there is no ftype');
});

test('the Formbay receiver cannot touch the invoice flow', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    const before = bridge.store.stats();
    await post(bridge.base, {
      body: { event: 'job.updated', job: { id: 'j1', status: 'sold' } },
      headers: { 'x-formbay-token': TOKEN },
    });
    // The Pylon event store — the thing that drives invoicing — must be untouched.
    assert.deepEqual(bridge.store.stats(), before);
  } finally {
    await bridge.close();
  }
});

test("Formbay's real test ping is understood, and refers to no job", () => {
  // Captured verbatim from the live endpoint when the client saved the webhook.
  const real = {
    version: 1,
    event_id: '8e6af8df-1088-4e70-b337-72451c2fd7c3',
    event: 'webhook.test',
    formid: 0,
    ftype: 'pv',
    timestamp: '2026-09-10T23:04:41+00:00',
    test: true,
  };
  const s = describeEvent(real);
  assert.equal(s.event, 'webhook.test');
  assert.equal(s.isTest, true);
  assert.equal(s.eventId, '8e6af8df-1088-4e70-b337-72451c2fd7c3');
  assert.equal(s.version, 1);
  assert.equal(s.occurredAt, '2026-09-10T23:04:41+00:00');
  // formid 0 is "no job". Producing "PV0" would sit in the log looking like a
  // real reference and match nothing.
  assert.equal(s.formbayNumber, null);
});

test('ftype + formid rebuilds the reference the business actually uses', () => {
  assert.equal(formbayNumber({ ftype: 'pv', formid: 1272458 }), 'PV1272458');
  assert.equal(formbayNumber({ ftype: 'bstc', formid: 238207 }), 'BSTC238207');
  assert.equal(formbayNumber({ ftype: 'BSTC', formid: '238207' }), 'BSTC238207');
  // Absent or meaningless input must not invent a reference.
  assert.equal(formbayNumber({ ftype: 'pv', formid: 0 }), null);
  assert.equal(formbayNumber({ ftype: 'pv' }), null);
  assert.equal(formbayNumber({ formid: 123 }), null);
  assert.equal(formbayNumber({}), null);
});

test('BSTC238207 rebuilt from a webhook matches the number on the payment advice', () => {
  // Payment Advice 61015 printed "BSTC 238207"; the tracker row stores
  // "BSTC238207". The webhook must produce the tracker's form, or the join fails.
  const built = formbayNumber({ ftype: 'bstc', formid: 238207 });
  assert.equal(built, 'BSTC238207');
  assert.equal(built.replace(/\s+/g, ''), 'BSTC 238207'.replace(/\s+/g, ''));
});

test('a live-shaped job.updated carries the reference and the status through', async () => {
  const bridge = await bridgeWith({ webhookToken: TOKEN });
  try {
    await post(bridge.base, {
      body: { version: 1, event_id: 'evt-1', event: 'job.updated', formid: 238207, ftype: 'bstc', timestamp: '2026-09-11T02:00:00+00:00', status: 'paid' },
      headers: { 'x-formbay-token': TOKEN },
    });
    const listed = await fetch(`${bridge.base}/formbay/events`, {
      headers: { authorization: 'Bearer admin-test-token' },
    }).then((r) => r.json());
    const [entry] = listed.events;
    assert.equal(entry.formbayNumber, 'BSTC238207');
    assert.equal(entry.status, 'paid');
    assert.equal(entry.eventId, 'evt-1');
    assert.equal(entry.isTest, false);
  } finally {
    await bridge.close();
  }
});
