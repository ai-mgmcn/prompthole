// A small pool of worker threads that scan request bodies off the main thread.
//   - the gateway's event loop never runs user regexes over big inputs, so one huge or hostile request cannot stall everyone
//   - every scan has a time limit; on timeout the worker is killed and replaced (a hard guarantee, unlike regex "safety checks")
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const WORKER_FILE = new URL('./scan-worker.mjs', import.meta.url);
export class ScanError extends Error { constructor(kind, message) { super(message); this.kind = kind; } } // kind: timeout | crash | busy | closed

export function createScanPool({ size = Math.max(1, Math.min(4, os.availableParallelism() - 1)), timeoutMs = 3000, maxQueue = 256 } = {}) {
  const slots = [], queue = []; let seq = 0, closed = false;

  const spawn = () => {
    const slot = { worker: new Worker(WORKER_FILE), job: null, rulesVersion: -1 };
    slot.worker.on('message', (m) => { const j = slot.job; if (j && j.id === m.id) { clearTimeout(j.timer); slot.job = null; j.resolve(m); next(); } });
    slot.worker.on('error', () => fail(slot, new ScanError('crash', 'scan worker crashed')));
    slot.worker.on('exit', () => { if (!closed && slots.includes(slot)) fail(slot, new ScanError('crash', 'scan worker exited')); });
    slot.worker.unref(); // an idle pool must not keep the process alive
    return slot;
  };
  const replace = (slot) => { const i = slots.indexOf(slot); if (i < 0) return; slot.worker.removeAllListeners('exit'); slot.worker.terminate(); if (!closed) slots[i] = spawn(); };
  const fail = (slot, err) => { const j = slot.job; slot.job = null; if (j) { clearTimeout(j.timer); j.reject(err); } replace(slot); next(); };

  function next() {
    while (queue.length) {
      const slot = slots.find((s) => !s.job); if (!slot) return;
      const j = queue.shift();
      slot.job = j;
      j.timer = setTimeout(() => fail(slot, new ScanError('timeout', `scan exceeded ${timeoutMs} ms`)), timeoutMs);
      const msg = { id: j.id, raw: j.raw, keepText: j.keepText, wantValue: j.wantValue };
      if (slot.rulesVersion !== j.version) { msg.rules = j.rules; slot.rulesVersion = j.version; }
      slot.worker.postMessage(msg);
    }
  }
  for (let i = 0; i < size; i++) slots.push(spawn());

  return {
    // raw: Buffer holding JSON. version: bumps whenever `rules` changes (so each worker gets the rules once, not per request)
    scan({ raw, rules, version, keepText = false, wantValue = false }) {
      if (closed) return Promise.reject(new ScanError('closed', 'scan pool closed'));
      if (queue.length >= maxQueue) return Promise.reject(new ScanError('busy', 'too many scans waiting'));
      return new Promise((resolve, reject) => { queue.push({ id: ++seq, raw, rules, version, keepText, wantValue, resolve, reject }); next(); });
    },
    stats: () => ({ size: slots.length, busy: slots.filter((s) => s.job).length, queued: queue.length }),
    async close() { closed = true; for (const j of queue.splice(0)) j.reject(new ScanError('closed', 'scan pool closed')); await Promise.all(slots.map((s) => { if (s.job) { clearTimeout(s.job.timer); s.job.reject(new ScanError('closed', 'scan pool closed')); } return s.worker.terminate(); })); },
  };
}
