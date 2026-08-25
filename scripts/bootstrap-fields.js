#!/usr/bin/env node
/**
 * Creates the custom fields this bridge writes to, if they are missing.
 *
 *   npm run bootstrap-fields            # dry run: shows what WOULD be created
 *   npm run bootstrap-fields -- --apply # actually creates them
 *
 * Nothing is ever renamed or deleted. Anything that already exists (matched on
 * field key or name) is left exactly as it is.
 */
import { config } from '../src/config.js';
import { GhlClient } from '../src/ghl.js';
import { indexCustomFields } from '../src/mapping.js';

const apply = process.argv.includes('--apply');

const WANTED = [
  // model, fieldKey we expect GHL to generate, display name, data type
  ['opportunity', 'opportunity.contract_reference', 'Contract Reference', 'TEXT'],
  ['opportunity', 'opportunity.contract_value', 'Contract Value', 'MONETORY'],
  ['opportunity', 'opportunity.contract_currency', 'Contract Currency', 'TEXT'],
  ['opportunity', 'opportunity.contract_signed_date', 'Contract Signed Date', 'DATE'],
  ['opportunity', 'opportunity.signed_by', 'Signed By', 'TEXT'],
  ['opportunity', 'opportunity.signed_by_email', 'Signed By Email', 'TEXT'],
  ['opportunity', 'opportunity.signed_contract_pdf', 'Signed Contract PDF', 'TEXT'],
  ['opportunity', 'opportunity.system_size_kw', 'System Size kW', 'NUMERICAL'],
  ['opportunity', 'opportunity.battery_storage_kwh', 'Battery Storage kWh', 'NUMERICAL'],
  ['opportunity', 'opportunity.deposit_amount', 'Deposit Amount', 'TEXT'],
  ['opportunity', 'opportunity.amount_payable', 'Amount Payable', 'TEXT'],
  ['opportunity', 'opportunity.install_address', 'Install Address', 'LARGE_TEXT'],
  ['opportunity', 'opportunity.pylon_project_link', 'Pylon Project Link', 'TEXT'],
  ['opportunity', 'opportunity.web_proposal_link', 'Web Proposal Link', 'TEXT'],
  ['opportunity', 'opportunity.payment_received', 'Payment Received', 'MONETORY'],
  ['opportunity', 'opportunity.payment_type', 'Payment Type', 'TEXT'],
  ['opportunity', 'opportunity.payment_date', 'Payment Date', 'DATE'],
  ['opportunity', 'opportunity.payment_receipt_link', 'Payment Receipt Link', 'TEXT'],

  ['contact', 'contact.pylon_project_reference', 'Pylon Project Reference', 'TEXT'],
  ['contact', 'contact.pylon_project_link', 'Pylon Project Link', 'TEXT'],
  ['contact', 'contact.signed_contract_pdf', 'Signed Contract PDF', 'TEXT'],
  ['contact', 'contact.signed_contract_file', 'Signed Contract File', 'FILE_UPLOAD'],
];

if (!config.ghl.apiToken || !config.ghl.locationId) {
  console.error('Set GHL_API_TOKEN and GHL_LOCATION_ID in .env first.');
  process.exit(1);
}

const ghl = new GhlClient({ ...config.ghl, dryRun: false });

try {
  const index = indexCustomFields(await ghl.listCustomFields('all', { fresh: true }));

  const missing = WANTED.filter(([model, key, name]) => !index.lookup(key, model) && !index.lookup(name, model));
  const present = WANTED.length - missing.length;

  console.log(`${present} of ${WANTED.length} fields already exist in location ${config.ghl.locationId}.`);

  if (!missing.length) {
    console.log('Nothing to create.');
    process.exit(0);
  }

  console.log(`\n${missing.length} field(s) ${apply ? 'will be created' : 'are MISSING (dry run — pass --apply to create them)'}:`);
  for (const [model, key, name, dataType] of missing) {
    console.log(`  ${model.padEnd(12)} ${name.padEnd(28)} ${dataType.padEnd(12)} -> ${key}`);
  }

  if (!apply) {
    console.log('\nRe-run with:  npm run bootstrap-fields -- --apply');
    process.exit(0);
  }

  console.log('');
  for (const [model, key, name, dataType] of missing) {
    const payload = { name, dataType, model };
    if (dataType === 'FILE_UPLOAD') {
      payload.acceptedFormat = ['.pdf'];
      payload.isMultipleFile = true;
      payload.maxNumberOfFiles = 5;
    }
    try {
      const created = await ghl.createCustomField(payload);
      const field = created?.customField ?? created;
      console.log(`  created  ${name.padEnd(28)} id=${field?.id ?? '?'} key=${field?.fieldKey ?? key}`);
    } catch (error) {
      console.error(`  FAILED   ${name.padEnd(28)} ${error.message}`);
    }
  }

  console.log('\nDone. Run `npm run discover` to confirm the field keys, then check config/mapping.json matches.');
} catch (error) {
  console.error(`\nBootstrap failed: ${error.message}`);
  process.exit(1);
}
