import fs from 'node:fs';
import { IntegrationError } from './lib/errors.js';

/**
 * The field-mapping engine.
 *
 * config/mapping.json is the ONLY file the client should ever need to edit to
 * change where a value lands in GoHighLevel. Values are little templates:
 *
 *   "{{contract.total_amount}}"                       a single value
 *   "{{client.email || client.project_contact_email}}" first non-empty wins
 *   "{{contract.signed_at | date}}"                   run through a filter
 *   "Signed {{contract.signed_at | date}} - {{contract.name}}"   free text mix
 *   "{{client.email || \"no-email@example.com\"}}"     quoted literal fallback
 */

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

const FILTERS = {
  date: (v) => toIsoDate(v),
  datetime: (v) => (v ? new Date(v).toISOString() : ''),
  number: (v) => (v === null || v === '' || v === undefined ? '' : String(Number(v))),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trim: (v) => String(v ?? '').trim(),
  json: (v) => (v === undefined ? '' : JSON.stringify(v)),
  yesno: (v) => (v ? 'Yes' : 'No'),
  first: (v) => (Array.isArray(v) ? v[0] ?? '' : v),
  count: (v) => (Array.isArray(v) ? v.length : v ? 1 : 0),
};

export function toIsoDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function getPath(source, dotted) {
  if (!dotted) return undefined;
  let current = source;
  for (const segment of dotted.split('.')) {
    if (current === null || current === undefined) return undefined;
    const index = Number.parseInt(segment, 10);
    current = Array.isArray(current) && Number.isFinite(index) ? current[index] : current[segment];
  }
  return current;
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function resolveExpression(expression, source) {
  // Split on a single "|" only — "||" is the fallback operator, not a filter.
  const [refPart, ...filterParts] = expression.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim());
  let value;
  for (const alternative of refPart.split('||').map((s) => s.trim())) {
    if (!alternative) continue;
    if (/^".*"$/.test(alternative) || /^'.*'$/.test(alternative)) {
      value = alternative.slice(1, -1);
    } else {
      value = getPath(source, alternative);
    }
    if (!isEmpty(value)) break;
  }
  for (const filterName of filterParts) {
    const filter = FILTERS[filterName];
    if (!filter) {
      throw new IntegrationError(`Unknown filter "${filterName}" in mapping expression "{{${expression}}}".`, {
        kind: 'mapping',
        system: 'bridge',
      });
    }
    value = filter(value);
  }
  return value;
}

/**
 * Renders one mapping value. A template that is exactly one token keeps the
 * underlying type (numbers stay numbers, which matters for monetaryValue);
 * anything else is stringified and concatenated.
 */
export function render(template, source) {
  if (typeof template !== 'string') return template;

  const single = template.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (single) return resolveExpression(single[1], source);

  let missing = false;
  const rendered = template.replace(TOKEN, (_match, expression) => {
    const value = resolveExpression(expression, source);
    if (isEmpty(value)) missing = true;
    return isEmpty(value) ? '' : String(value);
  });
  const cleaned = rendered.replace(/\s{2,}/g, ' ').trim();
  return missing && cleaned === '' ? '' : cleaned;
}

export function loadMapping(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new IntegrationError(`Could not read the field-mapping file at ${file}: ${error.message}`, {
      kind: 'mapping',
      system: 'bridge',
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new IntegrationError(
      `The field-mapping file at ${file} is not valid JSON: ${error.message}. A trailing comma is the usual cause.`,
      { kind: 'mapping', system: 'bridge', cause: error },
    );
  }
  if (!parsed.events || typeof parsed.events !== 'object') {
    throw new IntegrationError(`The field-mapping file at ${file} has no "events" object.`, {
      kind: 'mapping',
      system: 'bridge',
    });
  }
  parsed.warnings = checkInvoiceStages(parsed);
  return parsed;
}

/**
 * Payment stages that do not add up to the contract are a real problem — the
 * customer gets billed for less (or more) than they signed for, and nothing
 * else in the system would ever notice. Reported, not enforced: a business may
 * genuinely invoice part of a job here and the rest elsewhere.
 */
export function checkInvoiceStages(mapping) {
  const warnings = [];
  for (const [eventName, event] of Object.entries(mapping.events ?? {})) {
    const stages = event?.invoices?.stages;
    if (!stages?.length) continue;

    const keys = stages.map((s) => s.key);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (duplicates.length) {
      warnings.push(`Invoice stages for "${eventName}" reuse the key(s) ${[...new Set(duplicates)].join(', ')}. Keys must be unique — they are what stops a stage being billed twice.`);
    }

    // Only percentage stages can be summed; a fixed amount is deliberate.
    if (stages.some((s) => s.amount !== undefined && s.amount !== null)) continue;
    const total = stages.reduce((sum, s) => sum + (Number(s.percent) || 0), 0);
    if (Math.abs(total - 100) > 0.001) {
      warnings.push(
        `The invoice stages for "${eventName}" add up to ${total}% of the contract, not 100%. ` +
          `On a $10,000 contract the customer would be invoiced $${((total / 100) * 10000).toLocaleString('en-AU')} in total. ` +
          'Adjust the "percent" values in config/mapping.json if that is not intended.',
      );
    }
  }
  return warnings;
}

/**
 * Builds a lookup so mapping keys can be written as any of:
 *   the field key   "contract.signed_contract_url"  (as shown in GHL)
 *   the field name  "Signed Contract URL"
 *   the raw id      "8Xy2..."
 */
export function indexCustomFields(fields) {
  const byKey = new Map();
  const byName = new Map();
  const byId = new Map();
  for (const field of fields) {
    if (field.fieldKey) {
      byKey.set(field.fieldKey.toLowerCase(), field);
      // GHL prefixes keys with the model ("contact.foo"); allow the bare form.
      const bare = field.fieldKey.split('.').slice(1).join('.');
      if (bare) byKey.set(bare.toLowerCase(), field);
    }
    if (field.name) byName.set(field.name.trim().toLowerCase(), field);
    if (field.id) byId.set(field.id, field);
  }
  return {
    all: fields,
    lookup(reference, model) {
      if (!reference) return null;
      const ref = String(reference).trim();
      const direct = byId.get(ref);
      if (direct) return direct;
      const byKeyHit = byKey.get(ref.toLowerCase());
      if (byKeyHit && (!model || byKeyHit.model === model)) return byKeyHit;
      const byNameHit = byName.get(ref.toLowerCase());
      if (byNameHit && (!model || byNameHit.model === model)) return byNameHit;
      return byKeyHit || byNameHit || null;
    },
  };
}

/**
 * Resolves the customFields block of a mapping section against the live GHL
 * field list. Returns the entries to send plus a list of references that could
 * not be matched — the caller surfaces those instead of silently dropping data.
 */
export function buildCustomFields({ mappingFields = {}, source, index, model, valueKey, writeEmpty = false }) {
  const entries = [];
  const unresolved = [];
  const skipped = [];

  for (const [reference, template] of Object.entries(mappingFields)) {
    const field = index.lookup(reference, model);
    if (!field) {
      unresolved.push(reference);
      continue;
    }
    let value = render(template, source);
    if (isEmpty(value)) {
      if (!writeEmpty) {
        skipped.push({ reference, reason: 'no value in this event' });
        continue;
      }
      value = '';
    }
    if (field.dataType === 'DATE') value = toIsoDate(value) || value;
    if (['NUMERICAL', 'MONETORY', 'MONETARY'].includes(field.dataType)) {
      const numeric = Number(value);
      value = Number.isFinite(numeric) ? numeric : value;
    }
    entries.push({ id: field.id, [valueKey]: value, _name: field.name, _key: field.fieldKey });
  }

  return { entries, unresolved, skipped };
}

/** Strips the debugging keys before the payload goes over the wire. */
export function cleanCustomFields(entries) {
  return entries.map(({ _name, _key, ...rest }) => rest);
}

export function renderObject(mappingObject = {}, source, { writeEmpty = false } = {}) {
  const out = {};
  for (const [key, template] of Object.entries(mappingObject)) {
    const value = render(template, source);
    if (isEmpty(value) && !writeEmpty) continue;
    out[key] = value;
  }
  return out;
}
