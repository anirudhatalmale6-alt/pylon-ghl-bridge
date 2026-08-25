import test from 'node:test';
import assert from 'node:assert/strict';
import { signWebhookBody, verifyWebhookSignature } from '../src/pylon.js';

const SECRET = 'whsec_test_1234567890';
const BODY = JSON.stringify({ data: { type: 'events', id: 'abc', attributes: { name: 'web_proposals.signed' } } });

function headersFor(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signed = signWebhookBody({ rawBody: body, secret, timestamp });
  return {
    'pylon-webhook-signature': signed.signature,
    'pylon-webhook-timestamp': signed.timestamp,
    'pylon-webhook-version': '2021-07',
  };
}

test('accepts a correctly signed request', () => {
  const result = verifyWebhookSignature({ rawBody: Buffer.from(BODY), headers: headersFor(BODY), secret: SECRET });
  assert.equal(result.ok, true);
});

test('control: the same body with the wrong secret is rejected', () => {
  // Without this control a bug that always returns ok:true would pass the test above.
  const result = verifyWebhookSignature({
    rawBody: Buffer.from(BODY),
    headers: headersFor(BODY, { secret: 'whsec_someone_elses_secret' }),
    secret: SECRET,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match/i);
});

test('rejects a body that was altered after signing', () => {
  const headers = headersFor(BODY);
  const tampered = BODY.replace('web_proposals.signed', 'web_proposals.viewed');
  const result = verifyWebhookSignature({ rawBody: Buffer.from(tampered), headers, secret: SECRET });
  assert.equal(result.ok, false);
});

test('rejects a replayed request outside the tolerance window', () => {
  const stale = Math.floor(Date.now() / 1000) - 4000;
  const result = verifyWebhookSignature({
    rawBody: Buffer.from(BODY),
    headers: headersFor(BODY, { timestamp: stale }),
    secret: SECRET,
    toleranceSeconds: 300,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /timestamp/i);
});

test('a stale request still verifies when the tolerance is disabled', () => {
  const stale = Math.floor(Date.now() / 1000) - 4000;
  const result = verifyWebhookSignature({
    rawBody: Buffer.from(BODY),
    headers: headersFor(BODY, { timestamp: stale }),
    secret: SECRET,
    toleranceSeconds: 0,
  });
  assert.equal(result.ok, true);
});

test('reports each missing header by name', () => {
  const headers = headersFor(BODY);
  assert.match(
    verifyWebhookSignature({ rawBody: Buffer.from(BODY), headers: { 'pylon-webhook-timestamp': headers['pylon-webhook-timestamp'] }, secret: SECRET }).reason,
    /pylon-webhook-signature/i,
  );
  assert.match(
    verifyWebhookSignature({ rawBody: Buffer.from(BODY), headers: { 'pylon-webhook-signature': headers['pylon-webhook-signature'] }, secret: SECRET }).reason,
    /pylon-webhook-timestamp/i,
  );
});

test('header casing from Pylon does not matter', () => {
  const signed = signWebhookBody({ rawBody: BODY, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) });
  const result = verifyWebhookSignature({
    rawBody: Buffer.from(BODY),
    headers: { 'Pylon-Webhook-Signature': signed.signature, 'Pylon-Webhook-Timestamp': signed.timestamp },
    secret: SECRET,
  });
  assert.equal(result.ok, true);
});

test('refuses to verify when no secret is configured', () => {
  const result = verifyWebhookSignature({ rawBody: Buffer.from(BODY), headers: headersFor(BODY), secret: '' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PYLON_WEBHOOK_SECRET/);
});
