import { $, $$, esc, fmt, ICON_X } from '../dom.js';
import { api } from '../http.js';
import { openDrawer, closeDrawer } from '../drawer.js';

let events = [];
const matched = (x) => x.hits.map((h) => `${esc(h.name)} <span class="faint">×${h.count}</span>`).join(', ') || '<span class="faint">—</span>';
const pillFor = (mode) => (mode === 'block' ? 'blocked' : mode === 'mask' ? 'masked' : 'logged');
const tokenLine = (t) => (t
  ? `${t.in} in${t.cacheRead || t.cacheWrite ? ` (${t.cacheRead} read from cache${t.cacheWrite ? `, ${t.cacheWrite} written to cache` : ''})` : ''} · ${t.out} out${t.reasoning ? ` (${t.reasoning} reasoning)` : ''}`
  : '<span class="faint">not reported</span>');

// matched text is hidden until the user clicks Reveal
const matchBox = (m) => `<div class="mt"><div style="display:flex;gap:8px;align-items:center"><code class="rv" data-t="${esc(m.text)}${m.truncated ? '…' : ''}">••••••••</code><span style="flex:1"></span><button class="btn" data-rv="1" style="height:24px;padding:0 8px;font-size:12px">Reveal</button></div><pre class="rc" data-c="${esc(m.context || '')}">hidden</pre></div>`;

function detail(x) {
  const headers = Object.entries(x.headers || {});
  const hits = x.hits.length
    ? x.hits.map((h) => `<div style="display:flex;gap:8px;align-items:center;height:30px"><span class="pill ${pillFor(h.mode)}">${h.mode}</span>${esc(h.name)} <span class="faint">×${h.count}</span><code>${esc(h.sample)}</code></div>${(h.matches || []).map(matchBox).join('')}`).join('')
    : '<div class="faint">Nothing matched</div>';
  const calls = (x.calls || []).length
    ? x.calls.map((c) => `<div style="display:flex;gap:8px;align-items:center;min-height:30px"><span class="pill ${c.action}">${c.action}</span><b style="font-weight:500">${esc(c.name)}</b><code title="${esc(c.text)}">${esc(c.text)}</code></div>`).join('')
    : '<div class="faint">None in this response</div>';
  return `<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:14px">Request</b><button class="btn i" id="dx">${ICON_X}</button></div>
 <div style="margin:10px 0 4px"><span class="pill ${x.action}">${x.action}</span></div>
 <dl class="dl" style="margin-top:12px"><dt>Time</dt><dd>${new Date(x.ts).toLocaleString()}</dd><dt>Tool</dt><dd>${esc(x.tool)}</dd><dt>Provider</dt><dd>${esc(x.provider)}</dd><dt>Model</dt><dd>${esc(x.model || '—')}</dd><dt>Path</dt><dd class="mono">${esc(x.path)}</dd><dt>Status</dt><dd>${x.status}</dd><dt>Duration</dt><dd>${x.ms} ms</dd><dt>Tokens</dt><dd>${tokenLine(x.tokens)}</dd><dt>Body</dt><dd>${(x.bytes / 1024).toFixed(1)} KB</dd></dl>
 <div class="sec">Matched in what you sent</div>${hits}
 <div class="sec">Tool calls the model asked for</div>${calls}
 <div class="sec">Headers (credentials removed)</div>${headers.length ? `<dl class="dl mono">${headers.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '<div class="faint">—</div>'}`;
}

function open(x) {
  openDrawer(detail(x));
  $('#dx').onclick = closeDrawer;
  $$('#dr [data-rv]').forEach((b) => b.onclick = () => {
    const box = b.closest('.mt'), v = box.querySelector('.rv'), c = box.querySelector('.rc'), show = b.textContent === 'Reveal';
    v.textContent = show ? v.dataset.t : '••••••••'; c.textContent = show ? c.dataset.c : 'hidden'; b.textContent = show ? 'Hide' : 'Reveal';
  });
}

export const requests = {
  id: 'log', title: 'Requests',
  async load() {
    events = await api('/api/events?limit=200');
    $('#evEmpty').classList.toggle('hide', !!events.length);
    $('#ev').innerHTML = events.map((x, i) => `<tr class="click" data-i="${i}"><td class="num">${new Date(x.ts).toLocaleTimeString()}</td><td>${esc(x.tool)}</td><td class="mut">${esc(x.model || '—')}</td><td><span class="pill ${x.action}">${x.action}</span></td><td>${matched(x)}</td><td class="num ${x.status >= 200 && x.status < 300 ? 's-ok' : 's-bad'}">${x.status || '—'}</td><td class="num" style="text-align:right">${x.tokens ? fmt(x.tokens.in) + ' / ' + fmt(x.tokens.out) : '—'}</td><td class="num" style="text-align:right">${(x.bytes / 1024).toFixed(1)} KB</td><td class="num" style="text-align:right">${x.ms}</td></tr>`).join('');
    $$('#ev tr').forEach((r) => r.onclick = () => open(events[r.dataset.i]));
  },
};
