import { $, $$, esc, escRe, ICON_X } from '../dom.js';
import { api, put } from '../http.js';

let C = [];

async function save() {
  const r = await put('/api/clients', C);
  $('#cErr').textContent = r.ok ? '' : r.j.error;
  C = r.ok ? r.j : await api('/api/clients');
  render();
}

function render() {
  $('#cl').innerHTML = '<div class="item cl hdr"><span></span><span></span><span>Tool name</span><span>Header</span><span>Pattern (regex, case-insensitive)</span><span></span></div>'
    + C.map((r, i) => `<div class="item cl"><div class="sw ${r.enabled !== false ? 'on' : ''}" data-t="${i}"></div><span class="faint num">${i + 1}</span><input data-f="name" data-i="${i}" value="${esc(r.name)}"><input class="mono" data-f="header" data-i="${i}" value="${esc(r.header)}"><input class="mono" data-f="pattern" data-i="${i}" value="${esc(r.pattern)}"><span class="acts"><button class="btn i" data-u="${i}" title="Move up">↑</button><button class="btn i" data-n="${i}" title="Move down">↓</button><button class="btn i" data-x="${i}">${ICON_X}</button></span></div>`).join('');
  $$('#cl [data-t]').forEach((e) => e.onclick = () => { C[e.dataset.t].enabled = C[e.dataset.t].enabled === false; save(); });
  $$('#cl input').forEach((e) => e.onchange = () => { C[e.dataset.i][e.dataset.f] = e.value; save(); });
  $$('#cl [data-x]').forEach((e) => e.onclick = () => { C.splice(e.dataset.x, 1); save(); });
  $$('#cl [data-u]').forEach((e) => e.onclick = () => { const i = +e.dataset.u; if (i > 0) { [C[i - 1], C[i]] = [C[i], C[i - 1]]; save(); } });
  $$('#cl [data-n]').forEach((e) => e.onclick = () => { const i = +e.dataset.n; if (i < C.length - 1) { [C[i + 1], C[i]] = [C[i], C[i + 1]]; save(); } });
}

async function renderSeen() {
  const events = await api('/api/events?limit=500'), seen = {};
  events.forEach((e) => { const ua = (e.headers || {})['user-agent'] || '(none)'; seen[ua] = seen[ua] || { n: 0, tool: e.tool }; seen[ua].n++; });
  const rows = Object.entries(seen).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  $('#seen').innerHTML = rows.length
    ? rows.map(([ua, v], i) => `<div class="item" style="grid-template-columns:1fr 160px 50px auto"><code title="${esc(ua)}">${esc(ua)}</code><span>${esc(v.tool)}</span><span class="num">${v.n}×</span><button class="btn" data-s="${i}">Create rule</button></div>`).join('')
    : '<div class="empty">Nothing yet — send a request through PromptHole.</div>';
  $$('#seen [data-s]').forEach((b) => b.onclick = () => {
    const ua = rows[b.dataset.s][0];
    $('#cHdr').value = 'user-agent'; $('#cPat').value = '^' + escRe(ua.split(/[\s/]/)[0]); $('#cName').focus();
  });
}

export const clients = {
  id: 'clients', title: 'Clients',
  init() {
    $('#cAdd').onclick = () => {
      const r = { name: $('#cName').value.trim(), header: $('#cHdr').value.trim(), pattern: $('#cPat').value, enabled: true };
      if (!r.name || !r.pattern) { $('#cErr').textContent = 'Name and pattern are required'; return; }
      C.unshift(r); $('#cName').value = $('#cPat').value = ''; save();
    };
  },
  async load() { C = await api('/api/clients'); render(); await renderSeen(); },
};
