// Bulk rule import panel (lives inside the Rules page).
import { $, $$, esc } from '../dom.js';
import { post } from '../http.js';
import { reloadRules } from './rules.js';

const needsText = (s) => s === 'list' || s === 'env';
const body = () => ({ source: $('#iSrc').value, text: $('#iText').value, url: $('#iUrl').value.trim(), minConfidence: $('#iLow').checked ? 'all' : 'high' });
const skipHtml = (p) => (p.skippedCount ? `<details><summary>${p.skippedCount} skipped — why</summary><pre>${esc(p.skipped.map((s) => `${s.id}: ${s.reason}`).join('\n'))}</pre></details>` : '');

function onSourceChange() {
  const s = $('#iSrc').value;
  $('#iPaste').classList.toggle('hide', !needsText(s));
  $('#iUrlWrap').classList.toggle('hide', s !== 'url');
  $('#iLowWrap').classList.toggle('hide', s !== 'secrets-db' && s !== 'url');
  $('#iText').placeholder = s === 'list' ? 'one per line\n# comment\nProject Falcon\nre:internal-[a-z]{4}-\\d+' : 'DB_PASSWORD=...\nSTRIPE_KEY=...';
  $('#iHint').textContent = s === 'list' ? 'One per line. Prefix with re: for a regex.' : 'Only secret-looking values are used.';
  $('#iOut').innerHTML = '';
}

async function preview() {
  $('#iOut').innerHTML = '<div class="sub">Loading…</div>';
  const r = await post('/api/rules/preview', body());
  if (!r.ok) { $('#iOut').innerHTML = `<div class="err">${esc(r.j.error)}</div>`; return; }
  const p = r.j, groups = Object.entries(p.groups).sort((a, b) => b[1].total - a[1].total);
  if (!p.total) { $('#iOut').innerHTML = `<div class="sub">Nothing to import.${p.skippedCount ? ` ${p.skippedCount} skipped.` : ''}</div>` + skipHtml(p); return; }
  $('#iOut').innerHTML = `${p.source === 'url' ? `<div class="sub" style="margin-bottom:6px">Detected format: <b>${esc(p.label)}</b></div>` : ''}<div>${p.total} rules · <b>${p.fresh} new</b> · ${p.total - p.fresh} already imported${p.approx ? ` · ${p.approx} adapted` : ''}${p.skippedCount ? ` · ${p.skippedCount} skipped` : ''}</div>
 <div class="chips">${groups.map(([g, v]) => `<label class="chip"><input type="checkbox" data-g="${esc(g)}" checked>${esc(g)} <span class="faint">${v.total}</span></label>`).join('')}</div>
 ${p.storesSecrets ? '<div class="warn">These values are saved as exact-match rules in plain text in data/rules.json (readable only by your user). Anyone who can read that file can read them.</div>' : ''}
 ${skipHtml(p)}
 <div class="form" style="grid-template-columns:auto auto 1fr;margin-top:8px"><select id="iMode"><option value="log">Log only (safe to start)</option><option value="mask">Mask</option><option value="block">Block</option></select><button class="btn p" id="iGo">Import</button><span class="sub" id="iMsg"></span></div>`;
  $('#iMode').value = p.storesSecrets ? 'mask' : 'log'; // library rules start as "log only"; your own secrets start as "mask"
  $('#iGo').onclick = async () => {
    const groups = [...$$('#iOut [data-g]')].filter((c) => c.checked).map((c) => c.dataset.g);
    const done = await post('/api/rules/import', { ...body(), mode: $('#iMode').value, groups });
    if (!done.ok) { $('#iMsg').textContent = done.j.error; return; }
    $('#iMsg').textContent = `Done: ${done.j.added} added, ${done.j.updated} updated. ${done.j.total} rules in total.`;
    await reloadRules();
  };
}

export function initImport() {
  $('#rImp').onclick = () => $('#imp').classList.toggle('hide');
  $('#impX').onclick = () => $('#imp').classList.add('hide');
  $('#iSrc').onchange = onSourceChange;
  $('#iFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#iText').value = await f.text(); };
  $('#iPrev').onclick = preview;
}
