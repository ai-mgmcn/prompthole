// What the "Requests · last 60 min" chart says about itself: time labels under the bars, a peak figure, and a tooltip per bar.
// series: one entry per minute, oldest first: { t (ms, start of the minute), total, flagged }

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// five labels evenly spread along the bottom: the first minute, three in between, and "now"
export function axisLabels(series) {
  if (!series.length) return [];
  const last = series.length - 1;
  return [0, 0.25, 0.5, 0.75].map((f) => clock(series[Math.round(last * f)].t)).concat('now');
}

export const peak = (series) => Math.max(0, ...series.map((b) => b.total));
export const sum = (series) => series.reduce((s, b) => s + b.total, 0);

// "2:41 PM · 7 requests · 2 flagged"
export const barTitle = (b) => `${clock(b.t)} · ${b.total} request${b.total === 1 ? '' : 's'}${b.flagged ? ` · ${b.flagged} flagged` : ''}`;

export const summary = (series) => (sum(series) ? `${sum(series)} in the last hour · peak ${peak(series)} / min` : 'nothing in the last hour');
