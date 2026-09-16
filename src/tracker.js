import fs from 'node:fs';
import path from 'node:path';
import { logger } from './lib/logger.js';

/**
 * The STC tracker: what every job is worth, what has been paid, what is still
 * owed.
 *
 * Formbay has no endpoint that lists jobs — every call needs a formid — so the
 * set of jobs is kept here and topped up as contracts come through. It is
 * seeded from the spreadsheet the business already keeps.
 *
 * Jobs are refreshed in the background and read from a file on the disk, rather
 * than calling Formbay while somebody waits for a page. Several hundred jobs at
 * one HTTP call each is not a page load.
 */
export class Tracker {
  constructor({ dataDir, client }) {
    this.dir = dataDir;
    this.client = client;
    this.file = path.join(dataDir, 'stc-tracker.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  read() {
    if (!fs.existsSync(this.file)) return { refreshedAt: null, jobs: [] };
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      logger.warn('tracker cache unreadable, starting empty', { error: error.message });
      return { refreshedAt: null, jobs: [] };
    }
  }

  write(state) {
    fs.writeFileSync(this.file, JSON.stringify(state, null, 2));
    return state;
  }

  /** References we know about, in the order they were added. */
  references() {
    return this.read().jobs.map((j) => j.reference);
  }

  /** Adds references we have not seen, without disturbing what is cached. */
  add(references = []) {
    const state = this.read();
    const known = new Set(state.jobs.map((j) => j.reference));
    let added = 0;
    for (const reference of references) {
      const clean = String(reference ?? '').trim().toUpperCase().replace(/\s+/g, '');
      if (!clean || known.has(clean)) continue;
      known.add(clean);
      state.jobs.push({ reference: clean, ok: null });
      added += 1;
    }
    this.write(state);
    return { added, total: state.jobs.length };
  }

  /**
   * Re-reads every job from Formbay.
   *
   * Sequential with a small pause rather than parallel: this is somebody else's
   * production system and a few hundred jobs is not worth hammering it for.
   */
  async refresh({ limit = null, pauseMs = 60 } = {}) {
    const state = this.read();
    const jobs = limit ? state.jobs.slice(0, limit) : state.jobs;
    let ok = 0;
    let failed = 0;

    for (const job of jobs) {
      const fresh = await this.client.job(job.reference);
      Object.assign(job, fresh, { checkedAt: new Date().toISOString() });
      if (fresh.ok) ok += 1;
      else failed += 1;
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }

    state.refreshedAt = new Date().toISOString();
    this.write(state);
    logger.info('tracker refreshed', { ok, failed, total: state.jobs.length });
    return { ok, failed, total: state.jobs.length, refreshedAt: state.refreshedAt };
  }

  summary() {
    const { jobs, refreshedAt } = this.read();
    const live = jobs.filter((j) => j.ok);
    const sold = live.filter((j) => j.soldDate);
    const unsold = live.filter((j) => !j.soldDate);
    const sum = (list) => Math.round(list.reduce((t, j) => t + (j.value ?? 0), 0) * 100) / 100;
    return {
      refreshedAt,
      total: jobs.length,
      readable: live.length,
      unreadable: jobs.length - live.length,
      /**
       * Split on whether FORMBAY has a sold date, and named for exactly that.
       *
       * It is not the same as the business's own record: 180 jobs their sheet
       * marks sold come back from Formbay as "approved" with no sold date. So
       * calling the other bucket "not sold" would contradict their books and
       * send someone chasing a sale that already happened.
       */
      sold: { count: sold.length, value: sum(sold) },
      noSoldDate: { count: unsold.length, value: sum(unsold) },
      totalValue: sum(live),
    };
  }
}

/**
 * Pulls the Formbay references out of the spreadsheet the business keeps.
 *
 * Their sheet is the only record of which jobs exist, because Formbay will not
 * list them. Anything that is not a PV or BSTC number is skipped and counted —
 * there are a few, like "Greendeal", and silently dropping them would hide
 * jobs rather than flag them.
 */
export function referencesFromCsv(csv, column = 'FORMBAY #') {
  const lines = String(csv ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { references: [], skipped: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.replace(/^﻿/, '').trim().toUpperCase());
  const index = header.indexOf(column.toUpperCase());
  if (index === -1) return { references: [], skipped: [], error: `No "${column}" column. Found: ${header.join(', ')}` };

  const references = [];
  const skipped = [];
  for (const line of lines.slice(1)) {
    const value = (splitCsvLine(line)[index] ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (!value) continue;
    if (/^(BSTC|PV)\d+$/.test(value)) references.push(value);
    else skipped.push(value);
  }
  return { references: [...new Set(references)], skipped: [...new Set(skipped)] };
}

/** Minimal CSV line split that respects quoted fields containing commas. */
export function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else current += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(current); current = ''; }
    else current += c;
  }
  out.push(current);
  return out;
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v) => (typeof v === 'number' ? `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');

/**
 * The tracker as a page.
 *
 * Deliberately one self-contained HTML document with no external anything: the
 * client cannot open file attachments through the platform we talk on, so a URL
 * they can bookmark is the delivery mechanism.
 */
export function renderPage({ summary, jobs, token }) {
  const rows = jobs
    .map((j) => {
      const state = !j.ok ? 'error' : j.soldDate ? 'sold' : 'pending';
      // Never invent "not sold": show whatever status Formbay holds.
      const label = !j.ok
        ? (j.error ?? 'could not read')
        : j.soldDate
          ? `sold ${esc(j.soldDate)}`
          : esc(j.status ?? 'no status');
      return `<tr class="${state}">
        <td class="mono">${esc(j.reference)}</td>
        <td>${esc(j.address)}</td>
        <td class="num">${j.certificates ?? ''}</td>
        <td class="num">${j.price ? `$${j.price}` : ''}</td>
        <td class="num strong">${money(j.value)}</td>
        <td class="mono">${esc(j.jobNumber)}</td>
        <td>${label}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STC tracker &mdash; Inspire Energy</title><style>
:root{--navy:#1f3864;--line:#dde2ea;--muted:#5c6a7d;--ok:#1a7f4b;--warn:#8a6100;--bad:#b3261e}
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#16202f;background:#f4f6f9}
header{background:var(--navy);color:#fff;padding:16px 20px}
header h1{margin:0;font-size:18px}header p{margin:4px 0 0;font-size:12px;opacity:.8}
.wrap{padding:16px;max-width:1200px;margin:0 auto}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.card{flex:1 1 180px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:20px;color:var(--navy)}.card span{font-size:11px;color:var(--muted)}
.tablewrap{background:#fff;border:1px solid var(--line);border-radius:10px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:820px}
th{background:#eef1f6;color:var(--navy);text-align:left;padding:9px 10px;font-size:11px;
   letter-spacing:.04em;text-transform:uppercase;position:sticky;top:0}
td{padding:8px 10px;border-top:1px solid #eef1f5;vertical-align:top}
td.num{text-align:right;white-space:nowrap}td.strong{font-weight:600}
td.mono{font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap}
tr.sold td{background:#f2faf5}tr.error td{background:#fdf3f2;color:var(--bad)}
.note{font-size:12px;color:var(--muted);margin:12px 0 0}
form{display:inline}button{background:var(--navy);color:#fff;border:0;border-radius:8px;
  padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer}
</style></head><body>
<header><h1>STC tracker</h1>
<p>Read live from Formbay${summary.refreshedAt ? ` &middot; last refreshed ${esc(summary.refreshedAt.replace('T', ' ').slice(0, 16))} UTC` : ' &middot; never refreshed'}</p></header>
<div class="wrap">
<div class="cards">
  <div class="card"><b>${summary.total}</b><span>jobs tracked</span></div>
  <div class="card"><b>${money(summary.totalValue)}</b><span>total certificate value</span></div>
  <div class="card"><b>${money(summary.noSoldDate.value)}</b><span>${summary.noSoldDate.count} with no sold date in Formbay</span></div>
  <div class="card"><b>${money(summary.sold.value)}</b><span>${summary.sold.count} with a sold date in Formbay</span></div>
  ${summary.unreadable ? `<div class="card"><b style="color:var(--bad)">${summary.unreadable}</b><span>could not be read</span></div>` : ''}
</div>
<div class="tablewrap"><table>
<tr><th>Formbay #</th><th>Site</th><th>Certs</th><th>Price</th><th>Value</th><th>Job #</th><th>Status</th></tr>
${rows || '<tr><td colspan="7">Nothing tracked yet.</td></tr>'}
</table></div>
<p class="note"><strong>"No sold date" is Formbay's field, not your records.</strong> Many jobs your spreadsheet marks as sold come back from Formbay as "approved" with that field empty, so treat this as what Formbay knows rather than what has actually been sold.<br>
Value is the certificate count times the price Formbay holds &mdash; Formbay does not publish a total, so it is worked out here.
Anything it refuses to return is shown in red rather than left out, so a job cannot go missing quietly.</p>
<form method="post" action="/tracker/refresh?token=${encodeURIComponent(token ?? '')}">
  <button type="submit">Refresh from Formbay</button></form>
</div></body></html>`;
}
