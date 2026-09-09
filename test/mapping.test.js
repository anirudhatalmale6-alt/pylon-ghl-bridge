import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomFields, indexCustomFields, render } from '../src/mapping.js';
import { normalizePaymentEvent, normalizeSignedEvent, splitName, centsToMajor } from '../src/normalize.js';
import { GHL_FIELDS, readFixture } from './helpers/upstreams.js';

const payload = normalizeSignedEvent({
  event: readFixture('event-signed.json').data,
  project: readFixture('project.json').data,
  design: readFixture('design.json').data,
});

test('cents are converted to the major units GoHighLevel expects', () => {
  assert.equal(centsToMajor(1560000), 15600);
  assert.equal(centsToMajor(0), 0);
  assert.equal(centsToMajor(null), null);
});

test('the contract total is the design price, not the sum of line items', () => {
  // The quote contains a negative STC rebate line; the price the customer
  // signed for is pricing.total, and that is what the opportunity is worth.
  assert.equal(payload.contract.total_amount, 15600);
  assert.equal(payload.contract.total_amount_formatted, '$15,600.00');
  assert.equal(payload.contract.currency, 'AUD');
});

test('client details come from the signer, falling back to the project record', () => {
  assert.equal(payload.client.name, 'Andre Rieu');
  assert.equal(payload.client.first_name, 'Andre');
  assert.equal(payload.client.last_name, 'Rieu');
  assert.equal(payload.client.email, 'andre@example.com');
  assert.equal(payload.client.phone, '0417 522 630');
  assert.equal(payload.client.address.full, '19 Parmesan Avenue, Glen Iris, Victoria, 3147');
  assert.equal(payload.client.address.country_code, 'AU');
});

test('single-word and multi-word names split sensibly', () => {
  assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitName('Mary Jane Watson'), { firstName: 'Mary Jane', lastName: 'Watson' });
  assert.deepEqual(splitName('  spaced   out  '), { firstName: 'spaced', lastName: 'out' });
  assert.deepEqual(splitName(''), { firstName: '', lastName: '' });
});

test('a single-token template keeps the underlying type', () => {
  const value = render('{{contract.total_amount}}', payload);
  assert.equal(typeof value, 'number');
  assert.equal(value, 15600);
});

test('|| falls through to the next non-empty value, then to a literal', () => {
  assert.equal(render('{{client.nope || client.email}}', payload), 'andre@example.com');
  assert.equal(render('{{client.nope || client.also_nope || "unknown"}}', payload), 'unknown');
});

test('filters format values the way GoHighLevel wants them', () => {
  assert.equal(render('{{contract.signed_at | date}}', payload), '2026-08-25');
  assert.equal(render('{{project.is_accepted | yesno}}', payload), 'Yes');
  assert.equal(render('{{contract.line_items | count}}', payload), 2);
});

test('mixed text and tokens render as one string', () => {
  assert.equal(
    render('{{contract.name}} - {{client.address.line1}}', payload),
    '6.6 kW Solar + 10 kWh Battery - 19 Parmesan Avenue',
  );
});

test('custom fields resolve by key, by name and by id', () => {
  const index = indexCustomFields(GHL_FIELDS);
  assert.equal(index.lookup('opportunity.contract_value', 'opportunity').id, 'cf_val');
  assert.equal(index.lookup('Contract Value', 'opportunity').id, 'cf_val');
  assert.equal(index.lookup('cf_val').id, 'cf_val');
  assert.equal(index.lookup('does.not.exist', 'opportunity'), null);
});

test('numeric and date fields are coerced to the field type', () => {
  const index = indexCustomFields(GHL_FIELDS);
  const { entries } = buildCustomFields({
    mappingFields: {
      'opportunity.contract_value': '{{contract.total_amount}}',
      'opportunity.contract_signed_date': '{{contract.signed_at}}',
      'opportunity.system_size_kw': '{{contract.system_size_kw}}',
    },
    source: payload,
    index,
    model: 'opportunity',
    valueKey: 'fieldValue',
  });
  const byId = Object.fromEntries(entries.map((e) => [e.id, e.fieldValue]));
  assert.equal(byId.cf_val, 15600);
  assert.equal(typeof byId.cf_val, 'number');
  assert.equal(byId.cf_kw, 6.6);
  assert.equal(entries.find((e) => e.id === 'cf_date').fieldValue, '2026-08-25');
});

test('an unmapped field is reported, not silently dropped', () => {
  const index = indexCustomFields(GHL_FIELDS);
  const { entries, unresolved } = buildCustomFields({
    mappingFields: { 'opportunity.field_the_client_deleted': '{{contract.title}}' },
    source: payload,
    index,
    model: 'opportunity',
    valueKey: 'fieldValue',
  });
  assert.equal(entries.length, 0);
  assert.deepEqual(unresolved, ['opportunity.field_the_client_deleted']);
});

test('an empty value is skipped so an existing CRM value is never blanked', () => {
  const index = indexCustomFields(GHL_FIELDS);
  const { entries, skipped } = buildCustomFields({
    mappingFields: { 'opportunity.signed_contract_pdf': '{{contract.signed_pdf_stored_url}}' },
    source: payload, // stored url is null until the PDF has been re-hosted
    index,
    model: 'opportunity',
    valueKey: 'fieldValue',
  });
  assert.equal(entries.length, 0);
  assert.equal(skipped.length, 1);
});

test('writeEmpty:true does overwrite, for the case where blanking is wanted', () => {
  const index = indexCustomFields(GHL_FIELDS);
  const { entries } = buildCustomFields({
    mappingFields: { 'opportunity.signed_contract_pdf': '{{contract.signed_pdf_stored_url}}' },
    source: payload,
    index,
    model: 'opportunity',
    valueKey: 'fieldValue',
    writeEmpty: true,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fieldValue, '');
});

test('a payment event normalises amount, purpose and receipt', () => {
  const paid = normalizePaymentEvent({
    event: readFixture('event-payment.json').data,
    project: readFixture('project.json').data,
    design: readFixture('design.json').data,
  });
  assert.equal(paid.payment.amount, 1560);
  assert.equal(paid.payment.currency, 'AUD');
  assert.equal(paid.payment.purpose, 'deposit');
  assert.equal(paid.payment.purpose_label, 'Deposit');
  assert.equal(paid.payment.amount_formatted, '$1,560.00');
  assert.match(paid.payment.receipt_url, /^https:\/\/receipts/);
});

test('an unknown filter fails loudly instead of writing rubbish', () => {
  assert.throws(() => render('{{contract.title | shout}}', payload), /Unknown filter "shout"/);
});
