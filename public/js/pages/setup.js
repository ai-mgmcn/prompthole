import { $, $$, esc, ICON_X } from '../dom.js';
import { api, put } from '../http.js';

let U = [];
const snippet = (u) => { const url = `${location.origin}/${u.prefix}${u.suffix || ''}`; return u.env ? `export ${u.env}=${url}` : url; };

async function save() {
  const r = await put('/api/upstreams', U);
  $('#uErr').textContent = r.ok ? '' : r.j.error;
  U = r.ok ? r.j : await api('/api/upstreams');
  render();
  return r.ok;
}

function render() {
  $('#ups').innerHTML = '<div class="item u hdr"><span>Name</span><span>Upstream</span><span>Configure your tool with</span><span></span></div>'
    + (U.map((u, i) => `<div class="item u"><b style="font-weight:500">${esc(u.label)}</b><span><code title="${esc(u.url)}">${esc(u.url)}</code></span><span><code title="${esc(snippet(u))}">${esc(snippet(u))}</code></span><span class="acts"><button class="btn" data-c="${i}">Copy</button><button class="btn i" data-x="${i}">${ICON_X}</button></span></div>`).join('') || '<div class="empty">No upstreams yet.</div>');
  $$('#ups [data-c]').forEach((e) => e.onclick = () => { navigator.clipboard.writeText(snippet(U[e.dataset.c])); e.textContent = 'Copied'; setTimeout(() => e.textContent = 'Copy', 1200); });
  $$('#ups [data-x]').forEach((e) => e.onclick = () => { U.splice(e.dataset.x, 1); save(); });
}

export const setup = {
  id: 'setup', title: 'Setup',
  init() {
    $('#uAdd').onclick = async () => {
      const u = { label: $('#uLabel').value.trim() || $('#uPrefix').value.trim(), prefix: $('#uPrefix').value.trim().toLowerCase(), url: $('#uUrl').value.trim(), env: $('#uEnv').value.trim(), suffix: $('#uSuffix').value.trim(), format: $('#uFmt').value };
      if (!u.prefix || !u.url) { $('#uErr').textContent = 'Prefix and URL are required'; return; }
      U.push(u);
      if (await save()) ['uLabel', 'uPrefix', 'uUrl', 'uEnv', 'uSuffix'].forEach((id) => $('#' + id).value = '');
    };
  },
  async load() { U = await api('/api/upstreams'); render(); },
};
