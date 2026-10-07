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
      byStatus: groupByStatus(jobs),
    };
  }
}

/**
 * A count and a total for each status Formbay actually returns.
 *
 * Deliberately NOT mapped onto words like "pending" or "scheduled". Formbay has
 * no such statuses — what it returns is approved, new, in_progress, uploaded,
 * rejected, plus a sold date on some. Inventing friendlier names would mean
 * deciding, for example, that "approved" means pending, and that is a judgement
 * about their business that belongs to them, not to me.
 */
export function groupByStatus(jobs = []) {
  const groups = new Map();
  for (const job of jobs) {
    const key = !job.ok ? 'could not be read' : job.soldDate ? 'sold' : (job.status || 'no status');
    const group = groups.get(key) ?? { status: key, count: 0, value: 0 };
    group.count += 1;
    group.value = Math.round((group.value + (job.value ?? 0)) * 100) / 100;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
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
/**
 * Australian financial quarter for a `dd/mm/yyyy` date. Q1 is Jul-Sep.
 *
 * The business reports on the Australian financial year, so a calendar quarter
 * would put July and August either side of a boundary that does not exist in
 * their books.
 */
export function financialQuarter(date) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date ?? '').trim());
  if (!m) return null;
  const month = Number(m[2]);
  const year = Number(m[3]);
  // Jul-Sep is Q1 of the financial year that ENDS the following June.
  const quarter = Math.floor(((month - 7 + 12) % 12) / 3) + 1;
  const fyEnd = month >= 7 ? year + 1 : year;
  return `Q${quarter} FY${String(fyEnd).slice(2)}`;
}

/**
 * The label for a job whose money landed in a different quarter from its
 * installation — the thing accounts cannot currently see and asked for.
 * Returns null when both fall in the same quarter, or either date is missing.
 */
export function crossesPeriod(installedDate, soldDate) {
  const a = financialQuarter(installedDate);
  const b = financialQuarter(soldDate);
  if (!a || !b || a === b) return null;
  return `${a} → ${b}`;
}

/**
 * Every field, one row per Formbay job, for reconciling in a spreadsheet.
 *
 * The page answers "how much is outstanding"; this answers "which jobs crossed
 * a quarter", which is a pivot-table question and belongs in Excel.
 */
export function renderCsv(jobs = []) {
  const header = [
    'Formbay #', 'Type', 'Site', 'Job #', 'Certificates', 'Price', 'Value',
    'Installation date', 'Formbay status', 'Sold/paid date',
    'Installed quarter', 'Paid quarter', 'Crosses period',
  ];
  const cell = (v) => {
    const text = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.join(',')];
  for (const j of jobs) {
    const installedQ = financialQuarter(j.installedDate);
    const paidQ = financialQuarter(j.soldDate);
    lines.push([
      j.reference,
      j.kind === 'pv' ? 'solar' : j.kind === 'bstc' ? 'battery' : '',
      j.address,
      j.jobNumber,
      j.certificates,
      j.price,
      j.value,
      j.installedDate,
      j.ok ? (j.status ?? '') : `could not be read: ${j.error ?? ''}`,
      j.soldDate,
      installedQ,
      paidQ,
      installedQ && paidQ && installedQ !== paidQ ? 'yes' : '',
    ].map(cell).join(','));
  }
  // \r\n so Excel on Windows does not run the whole file onto one line.
  return lines.join('\r\n');
}

export function renderPage({ summary, jobs, token, status = null }) {
  const statusOf = (j) => (!j.ok ? 'could not be read' : j.soldDate ? 'sold' : (j.status || 'no status'));
  const shown = status ? jobs.filter((j) => statusOf(j) === status) : jobs;
  const rows = shown
    .map((j) => {
      const state = !j.ok ? 'error' : j.soldDate ? 'sold' : 'pending';
      // Never invent "not sold": show whatever status Formbay holds.
      const label = !j.ok
        ? (j.error ?? 'could not read')
        : j.soldDate
          ? `sold ${esc(j.soldDate)}`
          : esc(j.status ?? 'no status');
      // Installed and sold/paid as their OWN columns, and flagged when they fall
      // in different quarters: the point of this screen is finding jobs
      // installed in one quarter and not paid until another.
      const crosses = crossesPeriod(j.installedDate, j.soldDate);
      return `<tr class="${state}">
        <td class="mono">${esc(j.reference)}</td>
        <td>${esc(j.kind === 'pv' ? 'solar' : 'battery')}</td>
        <td>${esc(j.address)}</td>
        <td class="num">${j.certificates ?? ''}</td>
        <td class="num">${j.price ? `$${j.price}` : ''}</td>
        <td class="num strong">${money(j.value)}</td>
        <td class="mono">${esc(j.jobNumber)}</td>
        <td class="mono">${esc(j.installedDate)}</td>
        <td class="mono">${esc(j.soldDate)}${crosses ? ` <span class="flag" title="installed ${esc(j.installedDate)}, paid ${esc(j.soldDate)}">${esc(crosses)}</span>` : ''}</td>
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
table{border-collapse:collapse;width:100%;font-size:13px;min-width:1020px}
th{background:#eef1f6;color:var(--navy);text-align:left;padding:9px 10px;font-size:11px;
   letter-spacing:.04em;text-transform:uppercase;position:sticky;top:0}
td{padding:8px 10px;border-top:1px solid #eef1f5;vertical-align:top}
td.num{text-align:right;white-space:nowrap}td.strong{font-weight:600}
td.mono{font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap}
tr.sold td{background:#f2faf5}tr.error td{background:#fdf3f2;color:var(--bad)}
.note{font-size:12px;color:var(--muted);margin:12px 0 0}
form{display:inline}button,.btn{background:var(--navy);color:#fff;border:0;border-radius:8px;
  padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;display:inline-block;
  text-decoration:none;margin-left:8px}
.flag{background:#fff3cd;color:var(--warn);border-radius:4px;padding:1px 5px;font-size:11px;white-space:nowrap}
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
<div class="tablewrap" style="margin-bottom:16px"><table>
<tr><th>Status in Formbay</th><th>Jobs</th><th>Certificate value</th><th></th></tr>
${(summary.byStatus ?? []).map((g) => `<tr${status === g.status ? ' class="sold"' : ''}>
  <td><strong>${esc(g.status)}</strong></td>
  <td class="num">${g.count}</td>
  <td class="num strong">${money(g.value)}</td>
  <td><a href="/tracker?token=${encodeURIComponent(token ?? '')}&status=${encodeURIComponent(g.status)}">show only these</a></td>
</tr>`).join('')}
<tr><td><strong>All jobs</strong></td><td class="num"><strong>${summary.total}</strong></td>
    <td class="num strong">${money(summary.totalValue)}</td>
    <td><a href="/tracker?token=${encodeURIComponent(token ?? '')}">show all</a></td></tr>
</table></div>

${status ? `<p class="note" style="margin:0 0 10px"><strong>Showing only: ${esc(status)}</strong> &mdash; ${shown.length} of ${jobs.length} jobs.</p>` : ''}
<div class="tablewrap"><table>
<tr><th>Formbay #</th><th>Type</th><th>Site</th><th>Certs</th><th>Price</th><th>Value</th><th>Job #</th><th>Installed</th><th>Sold / paid</th><th>Status</th></tr>
${rows || '<tr><td colspan="10">Nothing tracked yet.</td></tr>'}
</table></div>
<p class="note"><strong>"Approved" does not mean paid.</strong> It is Formbay's workflow status
for a job whose paperwork has passed validation. The money is the <strong>sold / paid date</strong> column:
a job can sit on "approved" for months before it is sold, and the date appears only when it is.
That is why both are shown separately.<br>
The amber flag marks a job installed in one financial quarter and not paid until another.<br>
A site with solar and a battery is <strong>two Formbay jobs</strong> and so two rows &mdash; one PV, one BSTC.
Add both for the full value of that site; the spreadsheet download has a Type column for exactly this.<br>
<strong>"No sold date" is Formbay's field, not your records.</strong> Many jobs your spreadsheet marks as sold come back from Formbay as "approved" with that field empty, so treat this as what Formbay knows rather than what has actually been sold.<br>
Value is the certificate count times the price Formbay holds &mdash; Formbay does not publish a total, so it is worked out here.
Anything it refuses to return is shown in red rather than left out, so a job cannot go missing quietly.</p>
<form method="post" action="/tracker/refresh?token=${encodeURIComponent(token ?? '')}">
  <button type="submit">Refresh from Formbay</button></form>
<a class="btn" href="/tracker.csv?token=${encodeURIComponent(token ?? '')}">Download spreadsheet</a>
</div></body></html>`;
}
