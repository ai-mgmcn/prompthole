// Persistence: small JSON documents plus the append-only event log. Everything is owner-readable only (0600):
// rules may hold exact-match secrets and events may hold matched text.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLIENTS } from '../lib/core.mjs';
import { DEFAULT_TOOL_RULES } from '../lib/toolcalls.mjs';
import { DEFAULT_UPSTREAMS } from './config.mjs';
import { slimEvent, matchesFilters } from './event.mjs';
import { AuditLog } from './audit.mjs';

export class JsonDoc {
  // defaults: for object documents, missing keys are filled in so new settings appear after an upgrade
  constructor(file, fallback, { defaults = null } = {}) {
    this.file = file; this.version = 0; // version changes on every save: lets other threads cache by it
    const exists = fs.existsSync(file);
    try { this.value = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(fallback); }
    catch (e) { throw new Error(`cannot read ${file}: ${e.message}. Fix or delete the file and start again.`); }
    if (defaults) this.value = { ...defaults, ...this.value };
    if (!exists) this.save();
  }
  save() { this.version++; fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2), { mode: 0o600 }); fs.chmodSync(this.file, 0o600); }
  set(v) { this.value = v; this.save(); return v; }
}

export { slimEvent };

export class EventLog {
  constructor(file, max) {
    this.file = file; this.max = max; this.list = []; this.appended = 0; this.version = 0; this.onRecord = null; this.audit = null; // audit: the permanent, per-day log (the file above is only the recent window)
    if (fs.existsSync(file)) {
      this.list = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-max)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); // a corrupt line must not stop the server
      this.rewrite(); // trim the file to what is kept in memory
    }
  }
  rewrite() {
    fs.writeFileSync(this.file, this.list.map((e) => JSON.stringify(e)).join('\n') + (this.list.length ? '\n' : ''), { mode: 0o600 });
    this.appended = 0;
  }
  record(ev) {
    this.list.push(ev); this.version++;
    if (this.list.length > this.max) this.list.shift();
    try {
      fs.appendFileSync(this.file, JSON.stringify(ev) + '\n', { mode: 0o600 });
      if (++this.appended > this.max) this.rewrite(); // the file never grows beyond ~2x the in-memory log
    } catch { /* a full disk must not take the gateway down */ }
    try { this.audit?.append(ev); } catch { /* a full disk must not take the gateway down */ }
    try { this.onRecord?.(ev); } catch { /* statistics must never break request handling */ }
  }
  recent(n) { return this.list.slice(-n).reverse(); }
  byId(id) { return this.list.find((e) => e.id === id) || null; }
  // newest first, optionally only events older than `before` (a timestamp) and matching the filters. Used for paging.
  query({ limit = 100, before = Infinity, action = '', tool = '', q = '', calls = '' } = {}) {
    const f = { action, tool, calls, needle: q.trim().toLowerCase() }, out = [];
    for (let i = this.list.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.list[i];
      if (e.ts > before) continue; // equal timestamps are returned again; the page de-duplicates by id
      if (matchesFilters(e, f)) out.push(e);
    }
    return out;
  }
  // remove stored raw matched text from memory and disk; counts and metadata stay
  purgeMatchedText() {
    let purged = 0;
    for (const e of this.list) for (const h of e.hits) if (h.matches) { delete h.matches; purged++; }
    this.rewrite(); this.version++;
    // every event in the window is also in the audit trail, so the trail's count is the real number (adding them would count each twice)
    try { purged = Math.max(purged, this.audit?.purgeMatchedText() || 0); } catch { /* keep going: the window is already clean */ }
    return purged;
  }
}

// Lifetime totals. The event log only keeps the last N requests, so the headline numbers are counted separately and never roll off.
const freshCounters = () => ({ since: Date.now(), requests: 0, actions: {}, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }, calls: { total: 0, flagged: 0, blocked: 0 } });
export function countEvent(c, e) {
  c.requests++; c.actions[e.action] = (c.actions[e.action] || 0) + 1;
  if (e.tokens) { c.tokens.requests++; for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'reasoning']) c.tokens[k] += e.tokens[k] || 0; }
  for (const x of e.calls || []) { c.calls.total++; if (x.action === 'flagged') c.calls.flagged++; else if (x.action === 'blocked') c.calls.blocked++; }
}

// Built-in rules added in a newer version reach existing installs once; ones the user deleted are not resurrected.
function mergeNewDefaults(doc, settings, key, defaults, idOf, add) {
  const seen = (settings.value.seenDefaults ||= {});
  if (!seen[key]) { seen[key] = defaults.map(idOf); settings.save(); return; } // first run of this version: everything present counts as offered
  const fresh = defaults.filter((d) => !seen[key].includes(idOf(d)));
  if (!fresh.length) return;
  for (const d of fresh) { add(doc.value, structuredClone(d)); seen[key].push(idOf(d)); }
  doc.save(); settings.save();
}

export function createStore(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const f = (name) => path.join(config.dataDir, name);
  const defaultRules = JSON.parse(fs.readFileSync(path.join(config.root, 'rules.default.json'), 'utf8'));
  const countersExisted = fs.existsSync(f('counters.json'));
  const store = {
    rules: new JsonDoc(f('rules.json'), defaultRules),                 // what to look for in what you SEND
    toolRules: new JsonDoc(f('toolrules.json'), DEFAULT_TOOL_RULES),   // what to flag / block when the MODEL asks to run something
    upstreams: new JsonDoc(f('upstreams.json'), DEFAULT_UPSTREAMS),
    clients: new JsonDoc(f('clients.json'), DEFAULT_CLIENTS),
    settings: new JsonDoc(f('settings.json'), {}, { defaults: { storeMatchedText: true, inspectToolCalls: true } }),
    counters: new JsonDoc(f('counters.json'), freshCounters()),
    events: new EventLog(f('events.jsonl'), config.maxEvents),
  };
  // the permanent audit trail; history from before it existed (the recent-events file) is carried over once
  const audit = new AuditLog(f('audit'), { retentionDays: config.auditDays || 0 });
  if (audit.isEmpty()) for (const e of store.events.list) audit.append(e);
  audit.prune();
  const pruneTimer = setInterval(() => { try { audit.prune(); } catch { /* retry next time */ } }, 6 * 3600_000); pruneTimer.unref();
  store.events.audit = audit; store.audit = audit;
  mergeNewDefaults(store.toolRules, store.settings, 'toolRules', DEFAULT_TOOL_RULES, (r) => r.id, (list, r) => list.push(r));
  mergeNewDefaults(store.clients, store.settings, 'clients', DEFAULT_CLIENTS, (r) => r.name, (list, r) => list.unshift(r));

  if (!countersExisted) { // first run with lifetime totals: start from what the event log already holds
    const c = store.counters.value;
    for (const e of store.events.list) countEvent(c, e);
    if (store.events.list.length) c.since = store.events.list[0].ts;
    store.counters.save();
  }

  let timer = null; // counters are saved at most every 2 s, and on shutdown
  store.events.onRecord = (e) => { countEvent(store.counters.value, e); timer ||= setTimeout(() => { timer = null; store.counters.save(); }, 2000).unref(); };
  store.stop = () => clearInterval(pruneTimer); // for tests and embedding; the timer is also unref'd
  store.flush = () => { if (timer) { clearTimeout(timer); timer = null; } store.counters.save(); };
  return store;
}
