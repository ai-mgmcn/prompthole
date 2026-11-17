import { $, esc, fmt } from '../dom.js';
import { api } from '../http.js';

const bars = (el, m, f = String) => {
  const e = Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, 6), mx = Math.max(1, ...e.map((x) => x[1]));
  $(el).innerHTML = e.length
    ? e.map(([k, v]) => `<div class="bar"><span class="l" title="${esc(k)}">${esc(k)}</span><span class="t"><i style="width:${v / mx * 100}%"></i></span><span class="n">${f(v)}</span></div>`).join('')
    : '<div class="none">No data yet</div>';
};

function chart(series) {
  const w = 600, h = 120, mx = Math.max(1, ...series.map((b) => b.total)), bw = w / series.length;
  $('#chart').setAttribute('viewBox', `0 0 ${w} ${h}`);
  $('#chart').innerHTML = `<line x1="0" x2="${w}" y1="${h - .5}" y2="${h - .5}" stroke="var(--line)"/>` + series.map((b, i) => {
    const th = b.total / mx * (h - 6), fh = b.flagged / mx * (h - 6);
    return `<rect x="${i * bw + 1.5}" y="${h - th}" width="${bw - 3}" height="${Math.max(th, b.total ? 2 : 0)}" rx="1.5" fill="var(--acc)" opacity=".5"/><rect x="${i * bw + 1.5}" y="${h - fh}" width="${bw - 3}" height="${fh}" rx="1.5" fill="var(--bad)"/>`;
  }).join('');
  $('#legend').innerHTML = '<span style="color:var(--acc2)">■</span> all &nbsp;<span style="color:var(--bad)">■</span> flagged';
}

const kpi = (label, value, detail, color) => `<div class="card kpi"><div class="ct"><span>${label}</span></div><div class="v" style="color:${color || 'inherit'}">${value || 0}</div><div class="d">${detail}</div></div>`;

export const overview = {
  id: 'over', title: 'Overview',
  async load() {
    const s = await api('/api/stats'), a = s.actions, T = s.tokens || { in: 0, out: 0 }, C = s.calls || { blocked: 0, total: 0 };
    const flagged = (a.blocked || 0) + (a.masked || 0) + (a.logged || 0);
    const tokenDetail = `${fmt(T.in)} in${T.cacheRead ? ` (${fmt(T.cacheRead)} cached)` : ''} · ${fmt(T.out)} out${T.reasoning ? ` · ${fmt(T.reasoning)} reasoning` : ''}`;
    $('#kpis').innerHTML = kpi('Requests', s.total, `${flagged} flagged`)
      + kpi('Tokens', fmt(T.in + T.out), tokenDetail)
      + kpi('Blocked', a.blocked, 'rejected locally', 'var(--bad)')
      + kpi('Masked', a.masked, 'placeholders sent', 'var(--mask)')
      + kpi('Commands blocked', C.blocked, `${C.total} tool calls seen`, 'var(--bad)');
    chart(s.series);
    bars('#rulesHit', s.rules); bars('#tools', s.tools); bars('#provs', s.providers); bars('#models', s.models);
    bars('#tokModels', s.tokensByModel, fmt); bars('#tokTools', s.tokensByTool, fmt);
  },
};
