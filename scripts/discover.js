#!/usr/bin/env node
/**
 * Prints everything you need to fill in .env and config/mapping.json:
 * every pipeline, every stage, and every contact/opportunity custom field with
 * its id, key and type. Also writes docs/discovery.md so the output can be kept.
 *
 *   npm run discover
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, projectRoot } from '../src/config.js';
import { GhlClient } from '../src/ghl.js';
import { PylonClient } from '../src/pylon.js';

const missing = [];
if (!config.ghl.apiToken) missing.push('GHL_API_TOKEN');
if (!config.ghl.locationId) missing.push('GHL_LOCATION_ID');
if (missing.length) {
  console.error(`Set ${missing.join(' and ')} in .env first.`);
  process.exit(1);
}

const ghl = new GhlClient({ ...config.ghl, dryRun: false });
const pylon = new PylonClient(config.pylon);

const out = [];
function say(line = '') {
  console.log(line);
  out.push(line);
}

try {
  say('# GoHighLevel discovery');
  say();
  say(`Location: \`${config.ghl.locationId}\``);
  say(`Generated: ${new Date().toISOString()}`);
  say();

  const pipelines = await ghl.listPipelines({ fresh: true });
  say('## Pipelines and stages');
  say();
  if (!pipelines.length) say('_No pipelines found in this location._');
  for (const pipeline of pipelines) {
    say(`### ${pipeline.name}`);
    say();
    say(`\`GHL_PIPELINE_ID=${pipeline.id}\``);
    say();
    say('| Stage | Stage id |');
    say('| --- | --- |');
    for (const stage of pipeline.stages ?? []) {
      say(`| ${stage.name} | \`${stage.id}\` |`);
    }
    say();
  }

  const fields = await ghl.listCustomFields('all', { fresh: true });
  const contactFields = fields.filter((f) => f.model === 'contact');
  const opportunityFields = fields.filter((f) => f.model === 'opportunity');

  for (const [title, list] of [
    ['Contact custom fields', contactFields],
    ['Opportunity custom fields', opportunityFields],
  ]) {
    say(`## ${title}`);
    say();
    if (!list.length) {
      say('_None. Run `npm run bootstrap-fields -- --apply` to create the set this bridge expects._');
      say();
      continue;
    }
    say('| Name | Field key (use this in mapping.json) | Type | Id |');
    say('| --- | --- | --- | --- |');
    for (const field of list) {
      say(`| ${field.name} | \`${field.fieldKey}\` | ${field.dataType} | \`${field.id}\` |`);
    }
    say();
  }

  if (config.pylon.apiToken) {
    say('## Pylon');
    say();
    try {
      await pylon.ping();
      say('- API token: OK');
    } catch (error) {
      say(`- API token: FAILED — ${error.message}`);
    }
    say();
  }

  const target = path.join(projectRoot, 'docs', 'discovery.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${out.join('\n')}\n`);
  console.log(`\nWritten to ${target}`);
} catch (error) {
  console.error(`\nDiscovery failed: ${error.message}`);
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
  process.exit(1);
}
