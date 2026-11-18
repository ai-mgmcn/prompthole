// Requests page: the audit trail for a time range, with page numbers. The logic and HTML helpers are in requests-logic.js.
import { $, $$, esc, ICON_X } from '../dom.js';
import { api } from '../http.js';
import { openDrawer, closeDrawer } from '../drawer.js';
import { navigate } from '../router.js';
import { withIcon } from '../icons.js';
import { S, empty, createLoader, pagerHtml, countText, emptyText, storageText, rowHtml, matched, pillFor, tokenLine } from './requests-logic.js';

let data = empty(), failed = '';
const loader = createLoader(api);

// matched text is hidden until the user clicks Reveal
const matchBox = (m) => `<div class="mt"><div style="display:flex;gap:8px;align-items:center"><code class="rv" data-t="${esc(m.text)}${m.truncated ? '…' : ''}">••••••••</code><span style="flex:1"></span><button class="btn" data-rv="1" style="height:24px;padding:0 8px;font-size:12px">Reveal</button></div><pre class="rc" data-c="${esc(m.context || '')}">hidden</pre></div>`;

function detail(x) {
  const headers = Object.entries(x.headers || {});
  const hits = x.hits.length
    ? x.hits.map((h) => `<div style="display:flex;gap:8px;align-items:center;min-height:30px"><span class="pill ${pillFor(h.mode)}">${h.mode}</span>${esc(h.name)} <span class="faint">×${h.count}</span><code>${esc(h.sample)}</code></div>${(h.matches || []).map(matchBox).join('')}`).join('')
    : '<div class="faint">Nothing matched</div>';
  const calls = (x.calls || []).length
    ? x.calls.map((c, i) => `<div class="callrow"><span class="pill ${c.action}">${c.action}</span><b style="font-weight:500">${esc(c.name)}</b><code title="${esc(c.text)}">${esc(c.text)}</code>${c.action === 'blocked' ? `<button class="btn" data-mng="${esc(c.rule || '')}">Unblock…</button>` : `<button class="btn" data-blk="${i}">Block…</button>`}</div>`).join('')
    : '<div class="faint">None in this response</div>';
  return `<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:14px">Request</b><button class="btn i" id="dx">${ICON_X}</button></div>
 <div style="margin:10px 0 4px"><span class="pill ${x.action}">${x.action}</span>${x.error ? ` <span class="faint">${esc(x.error)}</span>` : ''}</div>
 <dl class="dl" style="margin-top:12px"><dt>Time</dt><dd>${new Date(x.ts).toLocaleString()}</dd><dt>Tool</dt><dd>${withIcon(x.tool)}</dd><dt>Provider</dt><dd>${withIcon(x.provider)}</dd><dt>Model</dt><dd>${x.model ? withIcon(x.model) : '—'}</dd><dt>Path</dt><dd class="mono">${esc(x.path)}</dd><dt>Status</dt><dd>${x.status}</dd><dt>Duration</dt><dd>${x.ms} ms</dd><dt>Tokens</dt><dd>${tokenLine(x.tokens)}</dd><dt>Body</dt><dd>${(x.bytes / 1024).toFixed(1)} KB</dd></dl>
 <div class="sec">Matched in what you sent</div>${hits}
 <div class="sec">Tool calls the model asked for</div>${calls}
 <div class="sec">Headers (credentials removed)</div>${headers.length ? `<dl class="dl mono">${headers.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '<div class="faint">—</div>'}`;
}

async function open(row) { // the list is slim; the full record (headers, matched text) is fetched on demand
  const x = await api(`/api/event?id=${encodeURIComponent(row.id)}&ts=${row.ts}`).catch(() => null);
  if (!x) return;
  openDrawer(detail(x));
  $('#dx').onclick = closeDrawer;
  // hand the command over to the Commands page, which shows how you want to match it
  $$('#dr [data-blk]').forEach((b) => b.onclick = () => { const c = x.calls[b.dataset.blk]; closeDrawer(); navigate('commands', { block: { name: c.name, text: c.text } }); });
  $$('#dr [data-mng]').forEach((b) => b.onclick = () => { closeDrawer(); navigate('commands', { focusRule: b.dataset.mng }); });
  $$('#dr [data-rv]').forEach((b) => b.onclick = () => {
    const box = b.closest('.mt'), v = box.querySelector('.rv'), c = box.querySelector('.rc'), show = b.textContent === 'Reveal';
    v.textContent = show ? v.dataset.t : '••••••••'; c.textContent = show ? c.dataset.c : 'hidden'; b.textContent = show ? 'Hide' : 'Reveal';
  });
}

function render() {
  const { items, pages } = data;
  $('#evErr').textContent = failed;
  $('#evEmpty').classList.toggle('hide', !!items.length || !!failed);
  $('#evEmpty').textContent = emptyText();
  $('#evCount').textContent = countText(data);
  $('#evPager').classList.toggle('hide', pages <= 1);
  $('#evPages').innerHTML = pagerHtml(data);
  $$('#evPages [data-p]').forEach((b) => b.onclick = () => go(Number(b.dataset.p)));
  $('#ev').innerHTML = items.map(rowHtml).join('');
  $$('#ev tr').forEach((r, i) => r.onclick = () => open(items[i]));
}

async function fetchPage() {
  const r = await loader();
  if (!r) return; // a newer request has been made since; its answer will be drawn instead
  ({ data, failed } = r); S.page = data.page; // the server moves a page that no longer exists to the last one
  render();
}

function go(page) { S.page = Math.max(1, page); fetchPage(); }
function restart() { S.page = 1; fetchPage(); }

async function showStorage() { // how much history is on disk (shown under the table)
  const d = await api('/api/audit/days').catch(() => null);
  if (d) $('#evStore').textContent = storageText(d);
}

export const requests = {
  id: 'log', title: 'Requests',
  init() {
    let timer;
    $('#evQ').oninput = (e) => { S.q = e.target.value; clearTimeout(timer); timer = setTimeout(restart, 250); };
    $('#evAct').onchange = (e) => { S.action = e.target.value; restart(); };
    $('#evSize').onchange = (e) => { S.size = Number(e.target.value); restart(); };
    $('#evRange').onchange = (e) => { S.range = e.target.value; $('#evCustom').classList.toggle('hide', S.range !== 'custom'); restart(); };
    $('#evFrom').onchange = (e) => { S.from = e.target.value; restart(); };
    $('#evTo').onchange = (e) => { S.to = e.target.value; restart(); };
  },
  async load(first) {
    if (first) S.page = 1;
    // polling: only the first page follows new requests; on later pages the rows stay put while you read them
    if (first || S.page === 1) await fetchPage();
    showStorage();
  },
};
