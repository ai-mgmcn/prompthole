// The "Requests · last 60 min" chart: time labels under the bars, tooltips and the summary line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisLabels, peak, sum, barTitle, summary } from '../public/js/chart.js';

const T = new Date(2026, 10, 18, 15, 0, 0).getTime();
const series = (counts = []) => Array.from({ length: 60 }, (_, i) => ({ t: T - (59 - i) * 60000, total: counts[i] || 0, flagged: 0 }));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

test('five labels along the bottom: four clock times, then "now"', () => {
  const s = series(), l = axisLabels(s);
  assert.equal(l.length, 5); assert.equal(l.at(-1), 'now');
  assert.equal(l[0], clock(s[0].t)); assert.equal(l[1], clock(s[Math.round(59 * 0.25)].t)); assert.equal(l[2], clock(s[Math.round(59 * 0.5)].t)); assert.equal(l[3], clock(s[Math.round(59 * 0.75)].t));
  assert.equal(new Set(l.slice(0, 4)).size, 4, 'the labels are different times');
});

test('a short or empty series still works', () => {
  assert.deepEqual(axisLabels([]), []);
  const one = axisLabels([{ t: T, total: 1, flagged: 0 }]); assert.equal(one.length, 5); assert.equal(one.at(-1), 'now');
});

test('peak, total and the summary line', () => {
  const s = series([0, 3, 0, 12, 5]);
  assert.equal(peak(s), 12); assert.equal(sum(s), 20); assert.equal(peak([]), 0); assert.equal(sum([]), 0);
  assert.equal(summary(s), '20 in the last hour · peak 12 / min');
  assert.equal(summary(series()), 'nothing in the last hour');
});

test('tooltips say the time, the count (singular or plural) and the flagged count', () => {
  assert.equal(barTitle({ t: T, total: 1, flagged: 0 }), `${clock(T)} · 1 request`);
  assert.equal(barTitle({ t: T, total: 7, flagged: 2 }), `${clock(T)} · 7 requests · 2 flagged`);
  assert.equal(barTitle({ t: T, total: 0, flagged: 0 }), `${clock(T)} · 0 requests`);
});
