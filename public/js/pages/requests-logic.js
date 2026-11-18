// The Requests page without the DOM: what the user chose, the URL that asks for it, and the HTML for rows and page buttons.
// Kept apart from requests.js so it can be tested directly.
import { esc, fmt } from '../dom.js';
import { withIcon } from '../icons.js';

// What the user chose to look at. The server loads the matching days from the audit files; nothing here is limited to "recent".
export const S = { q: '', action: '', range: '24h', from: '', to: '', page: 1, size: 50 };
const SPANS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
export const empty = () => ({ items: [], total: 0, page: 1, pages: 1, size: S.size });

const startOfDay = (v) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };               // local midnight
const endOfDay = (v) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); }; // local 23:59:59.999

// the time range as { from, to } in ms (either may be missing), or { error }
export function bounds(now = Date.now()) {
  if (S.range === 'all') return {};
  if (S.range === 'today') { const d = new Date(now); return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }; }
  if (SPANS[S.range]) return { from: Math.floor((now - SPANS[S.range]) / 60000) * 60000 }; // rounded to the minute so polling can be answered with "not modified"
  const from = S.from ? startOfDay(S.from) : undefined, to = S.to ? endOfDay(S.to) : undefined;
  if (from !== undefined && to !== undefined && from > to) return { error: 'The start date is after the end date.' };
  return { from, to };
}

export function params(b) {
  const q = new URLSearchParams({ page: S.page, size: S.size });
  if (b.from !== undefined) q.set('from', b.from);
  if (b.to !== undefined) q.set('to', b.to);
  if (S.q) q.set('q', S.q);
  if (S.action.startsWith('calls:')) q.set('calls', S.action.slice(6)); else if (S.action) q.set('action', S.action);
  return q.toString();
}

// Asks the server for the page the user chose. Answers that arrive out of order (typing fast, clicking pages quickly) come back as null.
export function createLoader(api) {
  let seq = 0;
  return async function load() {
    const b = bounds();
    if (b.error) { seq++; return { failed: b.error, data: empty() }; }
    const mine = ++seq;
    try {
      const data = await api(`/api/audit?${params(b)}`);
      return mine === seq ? { failed: '', data } : null;
    } catch (e) { return mine === seq ? { failed: `Could not load requests: ${e.message}`, data: empty() } : null; }
  };
}

// 1 … 4 5 [6] 7 8 … 20
export function pageList(page, pages) {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages)), out = [];
  for (const n of [...keep].sort((a, b) => a - b)) { if (out.length && n - out.at(-1) > 1) out.push('…'); out.push(n); }
  return out;
}

export const pagerHtml = ({ page, pages }) => `<button class="btn" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>`
  + pageList(page, pages).map((n) => (n === '…' ? '<span class="faint">…</span>' : `<button class="btn${n === page ? ' p' : ''}" data-p="${n}">${n}</button>`)).join('')
  + `<button class="btn" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>`;

export const countText = ({ items, total, page, size }) => (total ? `${(page - 1) * size + 1}–${(page - 1) * size + items.length} of ${total.toLocaleString()}` : '');
export const emptyText = () => (S.q || S.action ? 'No requests match these filters in this time range.' : 'No requests in this time range — widen it, or point a tool at PromptHole (Setup).');

export function storageText(d) {
  if (!d.days.length) return '';
  const mb = d.bytes / 1048576;
  return `History on disk: ${d.days.length} day${d.days.length === 1 ? '' : 's'} (${d.days[0].date} to ${d.days.at(-1).date}), ${mb < 1 ? '<1' : mb.toFixed(mb < 10 ? 1 : 0)} MB. ${d.retentionDays ? `Days older than ${d.retentionDays} are deleted automatically.` : 'Nothing is deleted automatically.'}`;
}

// today: just the time; other days: the date too
export const when = (ts, now = new Date()) => { const d = new Date(ts), t = d.toLocaleTimeString(); return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${t}`; };

export const matched = (x) => x.hits.map((h) => `${esc(h.name)} <span class="faint">×${h.count}</span>`).join(', ') || '<span class="faint">—</span>';
export const pillFor = (mode) => (mode === 'block' ? 'blocked' : mode === 'mask' ? 'masked' : 'logged');
export const tokenLine = (t) => (t
  ? `${t.in} in${t.cacheRead || t.cacheWrite ? ` (${t.cacheRead} read from cache${t.cacheWrite ? `, ${t.cacheWrite} written to cache` : ''})` : ''} · ${t.out} out${t.reasoning ? ` (${t.reasoning} reasoning)` : ''}`
  : '<span class="faint">not reported</span>');

export const rowHtml = (x) => `<tr class="click" data-id="${esc(x.id)}"><td class="num">${when(x.ts)}</td><td title="${esc(x.tool)}">${withIcon(x.tool)}</td><td class="mut" title="${esc(x.model || '')}">${x.model ? withIcon(x.model) : '—'}</td><td><span class="pill ${esc(x.action)}">${esc(x.action)}</span>${x.blockedCalls ? ` <span class="pill blocked" title="${x.blockedCalls} command(s) the model asked for were blocked">cmd ×${x.blockedCalls}</span>` : ''}</td><td>${matched(x)}</td><td class="num ${x.status >= 200 && x.status < 300 ? 's-ok' : 's-bad'}">${x.status || '—'}</td><td class="num" style="text-align:right">${x.tokens ? fmt(x.tokens.in) + ' / ' + fmt(x.tokens.out) : '—'}</td><td class="num" style="text-align:right">${(x.bytes / 1024).toFixed(1)} KB</td><td class="num" style="text-align:right">${x.ms}</td></tr>`;
