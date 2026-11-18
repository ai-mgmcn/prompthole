// Command rules: what to flag or block when the model asks your tools to run something.
// A rule is usually created from a request ("Block…" under "Tool calls the model asked for"), or added by hand here.
import { $, $$, esc, escRe, ICON_X } from '../dom.js';
import { api, put, post } from '../http.js';
import { navigate } from '../router.js';

let rules = [], counts = {};
const MATCH_LABEL = { exact: 'exact command', prefix: 'starts with', contains: 'contains', regex: 'regex' };

const prefill = (match, text) => ({ exact: text, prefix: text.split(/\s+/).slice(0, 2).join(' '), contains: text, regex: escRe(text) }[match]);

async function save() {
  const r = await put('/api/toolrules', rules);
  $('#trErr').textContent = r.ok ? '' : r.j.error;
  await load();
  return r.ok;
}

// opened when the user clicked "Block…" on a command in a request: c = { name, text }
function openForm(c) {
  $('#bf').innerHTML = `<div class="blockform"><b style="font-weight:500">Block this command</b>
    <div class="code-line mono" style="margin:8px 0;color:var(--mut);word-break:break-all">${esc(c.name)} · ${esc(c.text.length > 300 ? c.text.slice(0, 300) + '…' : c.text)}</div>
    <div class="form" style="grid-template-columns:150px 1fr auto auto">
    <select id="bfMatch">${Object.entries(MATCH_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <input id="bfPat" class="mono"><button class="btn p" id="bfGo">Block this</button><button class="btn" id="bfNo">Cancel</button></div>
    <div class="sub" style="margin-top:6px">Next time the model asks <b>${esc(c.name)}</b> to do this, PromptHole swaps it for a text note and the tool never runs it. “Starts with” is usually the right choice; “exact” only blocks this one command.</div></div>`;
  const sync = () => { $('#bfPat').value = prefill($('#bfMatch').value, c.text); };
  $('#bfMatch').value = 'prefix'; sync();
  $('#bfMatch').onchange = sync;
  $('#bfNo').onclick = () => { $('#bf').innerHTML = ''; };
  $('#bfGo').onclick = async () => {
    const pattern = $('#bfPat').value.trim();
    if (!pattern) return;
    rules.push({ id: 'tr-' + Date.now().toString(36), name: `Block: ${pattern.slice(0, 40)}`, tool: '*', match: $('#bfMatch').value, pattern, action: 'block', enabled: true });
    if (await save()) {
      $('#bf').innerHTML = '<div class="blockform"><span class="s-ok">✓ Rule created.</span> The next time the model asks for this, it is blocked. <button class="btn" id="bfBack" style="margin-left:8px">Back to requests</button></div>';
      $('#bfBack').onclick = () => navigate('log');
    }
  };
  $('#bf').scrollIntoView?.({ block: 'nearest' });
}

const hits = (id) => { const c = counts[id]; return c ? `${c.flagged} / ${c.blocked}` : '0'; };

function renderRules(focus) {
  $('#tl').innerHTML = '<div class="item tc hdr"><span></span><span>Name</span><span>Tool</span><span>Match</span><span>Hits (flag / block)</span><span>Action</span><span></span></div>'
    + rules.map((r, i) => `<div class="item tc${r.id === focus ? ' hl' : ''}" data-rid="${esc(r.id)}"><div class="sw ${r.enabled ? 'on' : ''}" data-i="${i}"></div><span class="cut" title="${esc(r.name)}">${esc(r.name)}</span><span class="mut">${esc(r.tool)}</span><code title="${esc(r.pattern)}"><span class="faint">${MATCH_LABEL[r.match]}</span> ${esc(r.pattern)}</code><span class="num" title="flagged / blocked">${hits(r.id)}</span><select data-a="${i}">${['flag', 'block'].map((a) => `<option ${a === r.action ? 'selected' : ''}>${a}</option>`).join('')}</select><button class="btn i" data-d="${i}">${ICON_X}</button></div>`).join('');
  $$('#tl [data-i]').forEach((e) => e.onclick = () => { rules[e.dataset.i].enabled = !rules[e.dataset.i].enabled; save(); });
  $$('#tl [data-a]').forEach((e) => e.onchange = () => { rules[e.dataset.a].action = e.value; save(); });
  $$('#tl [data-d]').forEach((e) => e.onclick = () => { rules.splice(e.dataset.d, 1); save(); });
  if (focus) document.querySelector('#tl .item.hl')?.scrollIntoView?.({ block: 'center' });
}

// payload (when sent here from a request): { block: { name, text } } opens the form; { focusRule: id } highlights a rule
async function load(first, payload) {
  const tr = await api('/api/toolrules');
  rules = tr.rules; counts = tr.counts || {};
  $('#swInspect').classList.toggle('on', !!tr.inspectToolCalls);
  renderRules(payload?.focusRule);
  if (payload?.block) openForm(payload.block);
  else if (first) $('#bf').innerHTML = '';
}

// ---- bulk import ----
const tiBody = () => ({ source: $('#tiSrc').value, url: $('#tiUrl').value.trim(), text: $('#tiText').value });

function tiSourceChange() {
  const s = $('#tiSrc').value;
  $('#tiUrlWrap').classList.toggle('hide', s !== 'url');
  $('#tiTextWrap').classList.toggle('hide', s !== 'text');
  $('#tiOut').innerHTML = '';
}

async function tiPreview() {
  $('#tiOut').innerHTML = '<div class="sub">Loading…</div>';
  const r = await post('/api/toolrules/preview', tiBody());
  if (!r.ok) { $('#tiOut').innerHTML = `<div class="err">${esc(r.j.error)}</div>`; return; }
  const p = r.j, groups = Object.entries(p.groups).sort((a, b) => b[1].total - a[1].total);
  const skipped = p.skippedCount ? `<details><summary>${p.skippedCount} skipped — why</summary><pre>${esc(p.skipped.map((s) => `${s.id}: ${s.reason}`).join('\n'))}</pre></details>` : '';
  if (!p.total) { $('#tiOut').innerHTML = '<div class="sub">Nothing to import.</div>' + skipped; return; }
  $('#tiOut').innerHTML = `<div>${p.total} rules · <b>${p.fresh} new</b> · ${p.total - p.fresh} already imported${p.blocking ? ` · ${p.blocking} marked “block” in the file` : ''}</div>
    <div class="chips">${groups.map(([g, v]) => `<label class="chip"><input type="checkbox" data-g="${esc(g)}" checked>${esc(g)} <span class="faint">${v.total}</span></label>`).join('')}</div>
    ${skipped}
    <div class="form" style="grid-template-columns:auto auto 1fr;margin-top:8px"><select id="tiAct"><option value="flag">Flag all (safe to start)</option><option value="file">Use the file's own actions</option><option value="block">Block all</option></select><button class="btn p" id="tiGo">Import</button><span class="sub" id="tiMsg"></span></div>`;
  $('#tiGo').onclick = async () => {
    const groups = [...$$('#tiOut [data-g]')].filter((c) => c.checked).map((c) => c.dataset.g);
    const done = await post('/api/toolrules/import', { ...tiBody(), action: $('#tiAct').value, groups });
    if (!done.ok) { $('#tiMsg').textContent = done.j.error; return; }
    $('#tiMsg').textContent = `Done: ${done.j.added} added, ${done.j.updated} updated. ${done.j.total} rules in total.`;
    await load();
  };
}

export const commands = {
  id: 'commands', title: 'Commands',
  init() {
    $('#swInspect').onclick = async () => { await put('/api/settings', { inspectToolCalls: !$('#swInspect').classList.contains('on') }); load(); };
    $('#trImp').onclick = () => $('#trPanel').classList.toggle('hide');
    $('#trImpX').onclick = () => $('#trPanel').classList.add('hide');
    $('#tiSrc').onchange = tiSourceChange;
    $('#tiPrev').onclick = tiPreview;
    $('#tiFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#tiText').value = await f.text(); };
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
