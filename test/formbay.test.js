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

// --- the fields accounts reconcile against ---------------------------------

test('a PV job gets a certificate count and therefore a value', async () => {
  const { summarise } = await import('../src/formbay-api.js');
  // A real PV job: calrec and NO calbstc. Reading calbstc first left all 154
  // solar jobs blank while the batteries beside them looked fine.
  const job = summarise({ calrec: '109', price: 39.3, status: 'approved', idate: '07/07/2025' }, { kind: 'pv', id: '1108339' });
  assert.equal(job.certificates, 109);
  assert.equal(job.value, 4283.7);
});

test('a battery job still reads the same count it always did', async () => {
  const { summarise } = await import('../src/formbay-api.js');
  // calrec and calbstc agree on every battery job checked against the live API.
  const job = summarise({ calrec: 357, calbstc: '357', price: 39.3 }, { kind: 'bstc', id: '139157' });
  assert.equal(job.certificates, 357);
  assert.equal(job.value, 14030.1);
});

test('a solar job and a battery job at one site are two rows that add up', async () => {
  const { summarise } = await import('../src/formbay-api.js');
  // Formbay holds them as separate jobs, so the tracker cannot merge them
  // without inventing a record. Accounts add the two.
  const solar = summarise({ calrec: '109', price: 39.3 }, { kind: 'pv', id: '1108339' });
  const battery = summarise({ calrec: '238', price: 39.3 }, { kind: 'bstc', id: '118903' });
  // 109 + 238 certificates at $39.30 - the real Menangle site.
  assert.equal(solar.value, 4283.7);
  assert.equal(battery.value, 9353.4);
  assert.equal(Math.round((solar.value + battery.value) * 100) / 100, 13637.1);
});

test('the financial quarter is the Australian one, not the calendar one', async () => {
  const { financialQuarter, crossesPeriod } = await import('../src/tracker.js');
  assert.equal(financialQuarter('07/07/2025'), 'Q1 FY26', 'July starts the financial year');
  assert.equal(financialQuarter('30/06/2025'), 'Q4 FY25', 'June ends the previous one');
  assert.equal(financialQuarter('15/10/2025'), 'Q2 FY26');
  assert.equal(financialQuarter(''), null);
  assert.equal(financialQuarter('1751928929'), null, 'a raw timestamp is not a date');

  // The whole point: installed one quarter, paid the next.
  assert.equal(crossesPeriod('29/09/2025', '15/10/2025'), 'Q1 FY26 → Q2 FY26');
  assert.equal(crossesPeriod('07/07/2025', '20/08/2025'), null, 'same quarter is not a crossing');
  assert.equal(crossesPeriod('07/07/2025', null), null, 'an unpaid job has not crossed anything yet');
});

test('the spreadsheet carries both dates and both quarters per job', async () => {
  const { renderCsv } = await import('../src/tracker.js');
  const csv = renderCsv([
    { reference: 'PV1108339', kind: 'pv', ok: true, address: '5 St James Av, Menangle NSW', jobNumber: '4278',
      certificates: 109, price: 39.3, value: 4283.7, installedDate: '29/09/2025', soldDate: '15/10/2025', status: 'approved' },
  ]);
  const [header, row] = csv.split('\r\n');
  assert.match(header, /Installation date/);
  assert.match(header, /Sold\/paid date/);
  assert.match(header, /Crosses period/);
  assert.match(row, /PV1108339/);
  assert.match(row, /solar/, 'solar and battery must be distinguishable in the sheet');
  assert.match(row, /29\/09\/2025/);
  assert.match(row, /15\/10\/2025/);
  assert.match(row, /Q1 FY26,Q2 FY26,yes,$/, 'the crossing is flagged for filtering, with no data warning');
});

test('an address containing a comma does not shift the spreadsheet columns', async () => {
  const { renderCsv } = await import('../src/tracker.js');
  // Every address has a comma in it, so this is the normal case, not an edge one.
  const csv = renderCsv([{ reference: 'PV1', kind: 'pv', ok: true, address: '5 St James Av, Menangle NSW', certificates: 1, price: 1, value: 1 }]);
  const row = csv.split('\r\n')[1];
  assert.match(row, /"5 St James Av, Menangle NSW"/);
  // Quoted correctly means the count is right.
  const { splitCsvLine } = await import('../src/tracker.js');
  assert.equal(splitCsvLine(row).length, 14);
});

test('a sold date before the installation is flagged, not counted as a sale', async () => {
  const { summarise } = await import('../src/formbay-api.js');
  // BSTC153957, real: Formbay returns sold_date 1369282570 (23/05/2013) on a
  // job installed 03/11/2025 and created in Sep 2025. Certificates are created
  // BY the installation, so a sale cannot come first - and the battery scheme
  // did not exist in 2013.
  const job = summarise({ calrec: '122', price: 39.3, idate: '03/11/2025', sold_date: '1369282570' }, { kind: 'bstc', id: '153957' });
  assert.equal(job.soldDate, '23/05/2013', 'the raw value is still shown, not hidden');
  assert.equal(job.soldDateSuspect, true);

  const real = summarise({ calrec: '109', price: 39.3, idate: '07/07/2025', sold_date: '1751928929' }, { kind: 'pv', id: '1108339' });
  assert.equal(real.soldDate, '07/07/2025');
  assert.equal(real.soldDateSuspect, false, 'a genuine sale must not be flagged');
});

test('an impossible sold date is kept out of the sold total', async (t) => {
  const { Tracker } = await import('../src/tracker.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tracker = new Tracker({ dataDir: dir, client: null });
  tracker.write({ refreshedAt: null, jobs: [
    { reference: 'PV1', ok: true, value: 1000, soldDate: '07/07/2025', installedDate: '07/07/2025', soldDateSuspect: false, status: 'approved' },
    { reference: 'BSTC1', ok: true, value: 5000, soldDate: '23/05/2013', installedDate: '03/11/2025', soldDateSuspect: true, status: 'approved' },
    { reference: 'BSTC2', ok: true, value: 2000, soldDate: null, installedDate: '03/11/2025', status: 'approved' },
  ] });

  const s = tracker.summary();
  // Booking $5,000 into 2013 would misstate a quarter that is already closed.
  assert.deepEqual(s.sold, { count: 1, value: 1000 });
  assert.deepEqual(s.suspectSoldDate, { count: 1, value: 5000 });
  assert.deepEqual(s.noSoldDate, { count: 1, value: 2000 });
  // Still counted somewhere - the money has not vanished from the tracker.
  assert.equal(s.totalValue, 8000);
  assert.ok(s.byStatus.some((g) => g.status === 'sold date is impossible' && g.count === 1));
});

test('the spreadsheet warns on an impossible sold date and leaves its quarter blank', async () => {
  const { renderCsv } = await import('../src/tracker.js');
  const csv = renderCsv([
    { reference: 'BSTC153957', kind: 'bstc', ok: true, address: 'x', certificates: 122, price: 39.3, value: 4794.6,
      installedDate: '03/11/2025', soldDate: '23/05/2013', soldDateSuspect: true, status: 'approved' },
  ]);
  const row = csv.split('\r\n')[1];
  assert.match(row, /query with Formbay/);
  // No paid quarter, so it cannot be summed into FY13 by a pivot table.
  assert.doesNotMatch(row, /Q4 FY13/);
  assert.doesNotMatch(row, /,yes,/, 'and it is not reported as a genuine period crossing');
});
