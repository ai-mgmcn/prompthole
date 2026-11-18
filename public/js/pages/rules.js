import { $, $$, esc, ICON_X } from '../dom.js';
import { api, put, post } from '../http.js';

let R = [], Q = '', S = { storeMatchedText: true };
const OPEN = new Set(['Custom']);
const CAP = new Map(), PAGE = 150; // rows rendered per group: a library of 1000+ rules would otherwise create thousands of DOM nodes
const groupOf = (r) => r.group || 'Custom';
const inGroup = (g) => R.filter((r) => groupOf(r) === g);

export const reloadRules = async () => { R = await api('/api/rules'); render(); };

async function save() {
  const r = await put('/api/rules', R);
  $('#rErr').textContent = r.ok ? '' : r.j.error;
  R = r.ok ? r.j : await api('/api/rules');
  render();
}

const row = (r, i) => `<div class="item rl"><div class="sw ${r.enabled ? 'on' : ''}" data-i="${i}"></div><span class="cut" title="${esc(r.desc || r.id)}"><b style="font-weight:500">${esc(r.name)}</b>${r.approx ? '<span class="badge" title="Converted from Go regex: case-insensitivity applies to the whole pattern, so it may match slightly more than the original">adapted</span>' : ''}</span><span class="mut">${r.type}</span><code class="pat" title="${r.secret ? 'hidden' : esc(r.pattern)}">${r.secret ? esc(r.pattern.slice(0, 2)) + '••••••' : esc(r.pattern)}</code><select data-m="${i}">${['mask', 'block', 'log'].map((m) => `<option ${m === r.mode ? 'selected' : ''}>${m}</option>`).join('')}</select><button class="btn i" data-d="${i}">${ICON_X}</button></div>`;

const groupOrder = (a, b) => (a === 'Custom' ? -1 : b === 'Custom' ? 1 : a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b));

function render() {
  const q = Q.trim().toLowerCase(), groups = new Map();
  R.forEach((r, i) => { const g = groupOf(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
  let html = '<div class="item rl hdr"><span></span><span>Name</span><span>Type</span><span>Pattern</span><span>Action</span><span></span></div>';
  for (const g of [...groups.keys()].sort(groupOrder)) {
    const idx = groups.get(g);
    const shown = q ? idx.filter((i) => `${R[i].name} ${R[i].id} ${g} ${R[i].secret ? '' : R[i].pattern}`.toLowerCase().includes(q)) : idx;
    if (q && !shown.length) continue;
    const open = q || OPEN.has(g), on = idx.filter((i) => R[i].enabled).length;
    html += `<div class="item rl grp" data-gh="${esc(g)}"><div class="sw ${on === idx.length ? 'on' : ''}" data-gs="${esc(g)}" title="Turn the whole group on / off"></div><b>${open ? '▾' : '▸'} ${esc(g)}</b><span></span><span class="faint">${idx.length} rules · ${on} on</span><select data-gm="${esc(g)}" title="Set the action for the whole group"><option value="">Set all…</option><option>mask</option><option>block</option><option>log</option></select><button class="btn i" data-gd="${esc(g)}" title="Delete the whole group">${ICON_X}</button></div>`;
    if (open) {
      const cap = CAP.get(g) || PAGE;
      html += shown.slice(0, cap).map((i) => row(R[i], i)).join('');
      if (shown.length > cap) html += `<div class="item more" data-more="${esc(g)}">Show ${Math.min(PAGE * 2, shown.length - cap)} more (${shown.length - cap} not shown)</div>`;
    }
  }
  $('#rl').innerHTML = html;
  $$('#rl [data-more]').forEach((e) => e.onclick = () => { CAP.set(e.dataset.more, (CAP.get(e.dataset.more) || PAGE) + PAGE * 2); render(); });
  $$('#rl .pat').forEach((e) => e.onclick = () => e.classList.toggle('open'));
  $$('#rl [data-gh]').forEach((e) => e.onclick = () => { const g = e.dataset.gh; OPEN.has(g) ? OPEN.delete(g) : OPEN.add(g); render(); });
  $$('#rl [data-gs]').forEach((e) => e.onclick = (ev) => { ev.stopPropagation(); const rs = inGroup(e.dataset.gs), allOn = rs.every((r) => r.enabled); rs.forEach((r) => r.enabled = !allOn); save(); });
  $$('#rl [data-gm]').forEach((e) => { e.onclick = (ev) => ev.stopPropagation(); e.onchange = () => { if (e.value) { inGroup(e.dataset.gm).forEach((r) => r.mode = e.value); save(); } }; });
  $$('#rl [data-gd]').forEach((e) => e.onclick = (ev) => {
    ev.stopPropagation();
    const g = e.dataset.gd;
    if (confirm(`Delete all ${inGroup(g).length} rules in "${g}"?`)) { R = R.filter((r) => groupOf(r) !== g); save(); }
  });
  $$('#rl [data-i]').forEach((e) => e.onclick = () => { R[e.dataset.i].enabled = !R[e.dataset.i].enabled; save(); });
  $$('#rl [data-m]').forEach((e) => e.onchange = () => { R[e.dataset.m].mode = e.value; save(); });
  $$('#rl [data-d]').forEach((e) => e.onclick = () => { R.splice(e.dataset.d, 1); save(); });
}

const renderSettings = () => $('#swKeep').classList.toggle('on', S.storeMatchedText);

export const rules = {
  id: 'rules', title: 'Rules',
  init() {
    $('#rQ').oninput = (e) => { Q = e.target.value; render(); };
    $('#swKeep').onclick = async () => { const r = await put('/api/settings', { storeMatchedText: !S.storeMatchedText }); if (r.ok) { S = r.j; renderSettings(); } };
    $('#purge').onclick = async () => { const r = await post('/api/settings/purge'); $('#purgeMsg').textContent = `Removed stored text from ${r.j.purged} match record(s).`; };
    $('#add').onclick = () => {
      const name = $('#nName').value.trim(), pattern = $('#nPat').value;
      if (!name || !pattern) return;
      R.push({ id: 'u' + Date.now().toString(36), name, type: $('#nType').value, pattern, mode: $('#nMode').value, enabled: true });
      $('#nName').value = $('#nPat').value = '';
      save();
    };
    $('#tb').onclick = async () => {
      const r = (await post('/api/test', { text: $('#tt').value })).j;
      $('#tr').textContent = (r.blocked ? '⛔ would block\n' : r.hits.length ? '' : '✓ no match\n') + r.hits.map((h) => `• ${h.name} ×${h.count} (${h.mode})`).join('\n') + (r.blocked || !r.hits.length ? '' : '\n→ ' + r.output);
    };
  },
  async load() { S = await api('/api/settings'); renderSettings(); await reloadRules(); },
};
