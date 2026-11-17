// Persistence: small JSON documents plus the append-only event log. Everything is owner-readable only (0600):
// rules may hold exact-match secrets and events may hold matched text.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLIENTS } from '../lib/core.mjs';
import { DEFAULT_TOOL_RULES } from '../lib/toolcalls.mjs';
import { DEFAULT_UPSTREAMS } from './config.mjs';

export class JsonDoc {
  // defaults: for object documents, missing keys are filled in so new settings appear after an upgrade
  constructor(file, fallback, { defaults = null } = {}) {
    this.file = file;
    const exists = fs.existsSync(file);
    try { this.value = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(fallback); }
    catch (e) { throw new Error(`cannot read ${file}: ${e.message}. Fix or delete the file and start again.`); }
    if (defaults) this.value = { ...defaults, ...this.value };
    if (!exists) this.save();
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2), { mode: 0o600 }); fs.chmodSync(this.file, 0o600); }
  set(v) { this.value = v; this.save(); return v; }
}

export class EventLog {
  constructor(file, max) {
    this.file = file; this.max = max; this.list = []; this.appended = 0;
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
    this.list.push(ev);
    if (this.list.length > this.max) this.list.shift();
    try {
      fs.appendFileSync(this.file, JSON.stringify(ev) + '\n', { mode: 0o600 });
      if (++this.appended > this.max) this.rewrite(); // the file never grows beyond ~2x the in-memory log
    } catch { /* a full disk must not take the gateway down */ }
  }
  recent(n) { return this.list.slice(-n).reverse(); }
  // remove stored raw matched text from memory and disk; counts and metadata stay
  purgeMatchedText() {
    let purged = 0;
    for (const e of this.list) for (const h of e.hits) if (h.matches) { delete h.matches; purged++; }
    this.rewrite();
    return purged;
  }
}

export function createStore(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const f = (name) => path.join(config.dataDir, name);
  const defaultRules = JSON.parse(fs.readFileSync(path.join(config.root, 'rules.default.json'), 'utf8'));
  return {
    rules: new JsonDoc(f('rules.json'), defaultRules),                 // what to look for in what you SEND
    toolRules: new JsonDoc(f('toolrules.json'), DEFAULT_TOOL_RULES),   // what to flag / block when the MODEL asks to run something
    upstreams: new JsonDoc(f('upstreams.json'), DEFAULT_UPSTREAMS),
    clients: new JsonDoc(f('clients.json'), DEFAULT_CLIENTS),
    settings: new JsonDoc(f('settings.json'), {}, { defaults: { storeMatchedText: true, inspectToolCalls: true } }),
    events: new EventLog(f('events.jsonl'), config.maxEvents),
  };
}
