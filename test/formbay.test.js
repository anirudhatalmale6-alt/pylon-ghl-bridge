import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig, startBridge } from './helpers/bridge.js';
import { tokenMatches, describe as describeEvent } from '../src/formbay.js';

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
  const summary = describeEvent({ type: 'doc.updated', data: { job_id: 'x9' } });
  assert.equal(summary.event, 'doc.updated');
  assert.equal(summary.isTest, false);
  assert.equal(summary.jobId, 'x9');
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
