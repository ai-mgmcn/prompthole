// Runs inside a worker thread: parses a request body and applies the content rules. A catastrophic regex can
// only ever freeze THIS thread; the pool kills it on timeout and the gateway keeps serving.
import { parentPort } from 'node:worker_threads';
import { scanValue } from '../lib/core.mjs';

let rules = [];
const cleanCache = new Set(); // fingerprints of long texts that matched nothing under the current rules
parentPort.on('message', (m) => {
  if (m.rules) { rules = m.rules; cleanCache.clear(); } // sent only when the rules changed since this worker last saw them
  let parsed;
  try { parsed = JSON.parse(Buffer.from(m.raw.buffer, m.raw.byteOffset, m.raw.byteLength).toString('utf8')); }
  catch { return parentPort.postMessage({ id: m.id, unparseable: true }); }
  const r = scanValue(rules, parsed, { keepText: m.keepText, cleanCache });
  const out = { id: m.id, model: (parsed && typeof parsed === 'object' && typeof parsed.model === 'string' ? parsed.model : null), hits: r.hits, blocked: r.blocked };
  if (m.wantValue) out.value = r.value;
  else if (r.hits.some((h) => h.mode === 'mask')) out.body = JSON.stringify(r.value);
  parentPort.postMessage(out);
});
