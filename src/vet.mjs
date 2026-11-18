// Finds regexes that can backtrack catastrophically ("ReDoS"). A pattern is probed in a worker thread against inputs
// designed to provoke exponential behaviour; if the worker does not finish in time, the pattern is unsafe.
// This is a safety net at save time. The hard guarantee is the scan pool's per-request timeout.
import { Worker } from 'node:worker_threads';

const FILE = new URL('./vet-worker.mjs', import.meta.url);
const MAX_VERDICTS = 20_000; // enough for any real rule set; stops a stream of one-off patterns from growing the cache for ever
const verdicts = new Map(); // "flags\0pattern" -> true (safe) | false (unsafe); rules are re-saved on every toggle, so cache hard
const remember = (key, safe) => { if (verdicts.size >= MAX_VERDICTS) verdicts.clear(); verdicts.set(key, safe); };
export const verdictCount = () => verdicts.size; // for tests
const keyOf = (p, f) => `${f || ''}\u0000${p}`;

// items: [{ pattern, flags }] -> Set of indexes that are unsafe
export async function vetPatterns(items, { perPatternMs = 400 } = {}) {
  const unsafe = new Set(), todo = [];
  items.forEach((it, i) => {
    const v = verdicts.get(keyOf(it.pattern, it.flags));
    if (v === false) unsafe.add(i); else if (v === undefined) todo.push({ i, pattern: it.pattern, flags: (it.flags || '').replace(/[^ims]/g, '') });
  });
  let from = 0;
  while (from < todo.length) {
    const rest = todo.slice(from);
    const bad = await new Promise((resolve) => {
      const w = new Worker(FILE); let current = -1, timer = null;
      const finish = (v) => { clearTimeout(timer); w.terminate(); resolve(v); };
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(current), perPatternMs); };
      w.on('message', (m) => { if (m.done) finish(null); else { current = m.start; arm(); } });
      w.on('error', () => finish(null));
      arm(); w.postMessage({ items: rest });
    });
    if (bad === null) { for (const t of rest) if (!unsafe.has(t.i)) remember(keyOf(t.pattern, t.flags), true); break; }
    const k = todo.findIndex((t) => t.i === bad);
    for (const t of todo.slice(from, k)) remember(keyOf(t.pattern, t.flags), true); // everything before the culprit finished
    remember(keyOf(todo[k].pattern, todo[k].flags), false); unsafe.add(bad);
    from = k + 1;
  }
  return unsafe;
}

export const UNSAFE_MESSAGE = 'pattern can take extremely long on some inputs (catastrophic backtracking). Rewrite it, for example avoid nested repetition like (a+)+';
