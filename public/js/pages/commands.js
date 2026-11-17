// Audit of what the model asked your tools to run, with a one-click Block.
import { $, $$, esc, escRe, ICON_X } from '../dom.js';
import { api, put } from '../http.js';

let rules = [], counts = {}, calls = [], pending = null;
const MATCH_LABEL = { exact: 'exact command', prefix: 'starts with', contains: 'contains', regex: 'regex' };

const prefill = (match, text) => ({ exact: text, prefix: text.split(/\s+/).slice(0, 2).join(' '), contains: text, regex: escRe(text) }[match]);

async function save() {
  const r = await put('/api/toolrules', rules);
  $('#trErr').textContent = r.ok ? '' : r.j.error;
  await load();
}

function blockForm(c) {
  return `<div class="blockform"><div class="form" style="grid-template-columns:150px 1fr auto auto">
    <select id="bfMatch">${Object.entries(MATCH_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <input id="bfPat" class="mono"><button class="btn p" id="bfGo">Block this</button><button class="btn" id="bfNo">Cancel</button></div>
    <div class="sub" style="margin-top:6px">Next time the model asks <b>${esc(c.name)}</b> to do this, PromptHole swaps it for a text note and the tool never runs it.</div></div>`;
}

function openForm(c) {
  pending = c;
  $('#bf').innerHTML = blockForm(c);
  const sync = () => { $('#bfPat').value = prefill($('#bfMatch').value, c.text); };
  $('#bfMatch').value = 'prefix'; sync();
  $('#bfMatch').onchange = sync;
  $('#bfNo').onclick = () => { pending = null; $('#bf').innerHTML = ''; };
  $('#bfGo').onclick = () => {
    const pattern = $('#bfPat').value.trim();
    if (!pattern) return;
    rules.push({ id: 'tr-' + Date.now().toString(36), name: `Block: ${pattern.slice(0, 40)}`, tool: '*', match: $('#bfMatch').value, pattern, action: 'block', enabled: true });
    pending = null; $('#bf').innerHTML = '';
    save();
  };
}

function renderCalls() {
  $('#cc').innerHTML = '<div class="item cc hdr"><span>Time</span><span>Client</span><span>Command (click to expand)</span><span>Status</span><span></span></div>'
    + (calls.map((c, i) => `<div class="item cc"><span class="num">${new Date(c.ts).toLocaleTimeString()}</span><span class="cut">${esc(c.client)} · ${esc(c.name)}</span><code title="${esc(c.text)}">${esc(c.text)}</code><span><span class="pill ${c.action}">${c.action}</span></span><span class="acts">${c.action === 'blocked' ? `<button class="btn" data-ub="${esc(c.rule)}">Unblock</button>` : `<button class="btn" data-b="${i}">Block…</button>`}</span></div>`).join('') || '<div class="empty">No tool calls seen yet. They appear when a model asks your tool to run something.</div>');
  $$('#cc code').forEach((e) => e.onclick = () => e.classList.toggle('open'));
  $$('#cc [data-b]').forEach((e) => e.onclick = () => openForm(calls[e.dataset.b]));
  $$('#cc [data-ub]').forEach((e) => e.onclick = () => { const r = rules.find((x) => x.id === e.dataset.ub); if (r) { r.enabled = false; save(); } });
}

const hits = (id) => { const c = counts[id]; return c ? `${c.flagged} / ${c.blocked}` : '0'; };

function renderRules() {
  $('#tl').innerHTML = '<div class="item tc hdr"><span></span><span>Name</span><span>Tool</span><span>Match</span><span>Hits (flag / block)</span><span>Action</span><span></span></div>'
    + rules.map((r, i) => `<div class="item tc"><div class="sw ${r.enabled ? 'on' : ''}" data-i="${i}"></div><span class="cut" title="${esc(r.name)}">${esc(r.name)}</span><span class="mut">${esc(r.tool)}</span><code title="${esc(r.pattern)}"><span class="faint">${MATCH_LABEL[r.match]}</span> ${esc(r.pattern)}</code><span class="num" title="flagged / blocked">${hits(r.id)}</span><select data-a="${i}">${['flag', 'block'].map((a) => `<option ${a === r.action ? 'selected' : ''}>${a}</option>`).join('')}</select><button class="btn i" data-d="${i}">${ICON_X}</button></div>`).join('');
  $$('#tl [data-i]').forEach((e) => e.onclick = () => { rules[e.dataset.i].enabled = !rules[e.dataset.i].enabled; save(); });
  $$('#tl [data-a]').forEach((e) => e.onchange = () => { rules[e.dataset.a].action = e.value; save(); });
  $$('#tl [data-d]').forEach((e) => e.onclick = () => { rules.splice(e.dataset.d, 1); save(); });
}

async function load() {
  const [tr, events] = await Promise.all([api('/api/toolrules'), api('/api/events?limit=300')]);
  rules = tr.rules; counts = tr.counts || {};
  $('#swInspect').classList.toggle('on', !!tr.inspectToolCalls);
  calls = events.flatMap((e) => (e.calls || []).map((c) => ({ ...c, ts: e.ts, client: e.tool }))).slice(0, 100);
  if (!pending) renderCalls();
  renderRules();
}

export const commands = {
  id: 'commands', title: 'Commands',
  init() {
    $('#swInspect').onclick = async () => { await put('/api/settings', { inspectToolCalls: !$('#swInspect').classList.contains('on') }); load(); };
    $('#trAdd').onclick = () => {
      const pattern = $('#trPat').value.trim(), match = $('#trMatch').value;
      if (!pattern) return;
      rules.push({ id: 'tr-' + Date.now().toString(36), name: $('#trName').value.trim() || pattern.slice(0, 40), tool: $('#trTool').value.trim() || '*', match, pattern, action: $('#trAction').value, enabled: true });
      $('#trName').value = $('#trPat').value = '';
      save();
    };
  },
  load,
};
