import { $, esc, fmt } from '../dom.js';
import { api } from '../http.js';
import { withIcon } from '../icons.js';
import { axisLabels, barTitle, summary } from '../chart.js';

const bars = (el, m, f = String, logos = false) => {
  const e = Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, 6), mx = Math.max(1, ...e.map((x) => x[1]));
  $(el).innerHTML = e.length
    ? e.map(([k, v]) => `<div class="bar${logos ? ' lg' : ''}"><span class="l" title="${esc(k)}">${logos ? withIcon(k) : esc(k)}</span><span class="t"><i style="width:${v / mx * 100}%"></i></span><span class="n">${f(v)}</span></div>`).join('')
    : '<div class="none">No data yet</div>';
};

function chart(series) {
  const w = 600, h = 120, mx = Math.max(1, ...series.map((b) => b.total)), bw = w / series.length;
  $('#chart').setAttribute('viewBox', `0 0 ${w} ${h}`);
  $('#chart').innerHTML = `<line x1="0" x2="${w}" y1="${h - .5}" y2="${h - .5}" stroke="var(--line)"/>` + series.map((b, i) => {
    const th = b.total / mx * (h - 6), fh = b.flagged / mx * (h - 6);
    return `<rect x="${i * bw + 1.5}" y="${h - th}" width="${bw - 3}" height="${Math.max(th, b.total ? 2 : 0)}" rx="1.5" fill="var(--acc)" opacity=".5"/><rect x="${i * bw + 1.5}" y="${h - fh}" width="${bw - 3}" height="${fh}" rx="1.5" fill="var(--bad)"/>`
      + `<rect x="${i * bw}" y="0" width="${bw}" height="${h}" fill="transparent"><title>${esc(barTitle(b))}</title></rect>`; // hover for any minute, even an empty one
  }).join('');
  $('#axis').innerHTML = axisLabels(series).map((l) => `<span>${esc(l)}</span>`).join('');
  $('#legend').innerHTML = `${esc(summary(series))} &nbsp; <span style="color:var(--acc2)">■</span> all &nbsp;<span style="color:var(--bad)">■</span> flagged`;
}

const kpi = (label, value, detail, color) => `<div class="card kpi"><div class="ct"><span>${label}</span></div><div class="v" style="color:${color || 'inherit'}">${value || 0}</div><div class="d">${detail}</div></div>`;

export const overview = {
  id: 'over', title: 'Overview',
  async load() {
    // headline numbers are lifetime totals; the breakdowns below cover the latest requests only
    const s = await api('/api/stats'), L = s.lifetime, a = L.actions, T = L.tokens, C = L.calls;
    const flagged = (a.blocked || 0) + (a.masked || 0) + (a.logged || 0), since = new Date(L.since).toLocaleDateString();
    const tokenDetail = `${fmt(T.in)} in${T.cacheRead ? ` (${fmt(T.cacheRead)} cached)` : ''} · ${fmt(T.out)} out${T.reasoning ? ` · ${fmt(T.reasoning)} reasoning` : ''}`;
    $('#kpis').innerHTML = kpi('Requests', fmt(L.requests), `${fmt(flagged)} flagged · since ${since}`)
      + kpi('Tokens', fmt(T.in + T.out), tokenDetail)
      + kpi('Blocked', fmt(a.blocked), 'rejected locally', 'var(--bad)')
      + kpi('Masked', fmt(a.masked), 'placeholders sent', 'var(--mask)')
      + kpi('Commands blocked', fmt(C.blocked), `${fmt(C.total)} tool calls seen`, 'var(--bad)');
    document.querySelectorAll('.win').forEach((e) => { e.textContent = `latest ${fmt(Math.min(L.requests, s.window))}`; });
    chart(s.series);
    bars('#rulesHit', s.rules); bars('#tools', s.tools, String, true); bars('#provs', s.providers, String, true); bars('#models', s.models, String, true);
    bars('#tokModels', s.tokensByModel, fmt, true); bars('#tokTools', s.tokensByTool, fmt, true);
  },
};
