// The dashboard's JSON API as a route table. Each handler returns a value (sent as JSON) or throws HttpError.
import { scanValue as scan, validRules, validUpstreams, validClients } from '../lib/core.mjs';
import { validToolRules, splitFlags } from '../lib/toolcalls.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { SOURCES, detectFormat } from '../lib/rulelib.mjs';
import { parseCommandRules, looksLikeCommandRules } from '../lib/cmdlib.mjs';
import { HttpError, json, localHost, badOrigin, readJson } from './http.mjs';
import { createSourceLoader } from './presets.mjs';
import { stats, toolRuleCounts } from './stats.mjs';
import { slimEvent } from './store.mjs';
import { ScanError } from './scan-pool.mjs';
import { vetPatterns, UNSAFE_MESSAGE } from './vet.mjs';

const SETTING_KEYS = ['storeMatchedText', 'inspectToolCalls'];
const asBool = (v) => v === true || v === false;

export function createApi({ store, config, pool }) {
  const loadSource = createSourceLoader(config.presets, { allowPrivateUrls: config.allowPrivateUrls });
  const routes = new Map();
  // etag: optional function returning a string that changes whenever the response would; lets the dashboard poll cheaply (304, no body)
  const add = (method, path, handler, etag = null) => routes.set(`${method} ${path}`, { handler, etag });
  const eventsTag = ({ url }) => `${store.events.version}|${url.search}`;

  // first regex that could hang the gateway, as an error message (or null)
  async function unsafeRegex(items) {
    const bad = await vetPatterns(items.map((i) => ({ pattern: i.pattern, flags: i.flags })));
    return bad.size ? `${items[[...bad][0]].name}: ${UNSAFE_MESSAGE}` : null;
  }

  // GET returns the document; PUT validates, normalises, saves. Used by every editable list.
  const collection = (path, doc, { validate, normalize = (x) => x }) => {
    add('GET', path, () => doc.value);
    add('PUT', path, async ({ req }) => {
      const next = await readJson(req);
      const bad = await validate(next);
      if (bad) throw new HttpError(400, bad);
      return doc.set(normalize(next));
    });
  };

  // ---- overview ----
  add('GET', '/api/stats', () => ({ ...stats(store.events.list), lifetime: store.counters.value, window: config.maxEvents }), ({ url }) => `${eventsTag({ url })}|${Math.floor(Date.now() / 60000)}`);
  // Request log. Newest first. `before` (a timestamp) pages backwards; view=list leaves out headers and matched text (fetch those per event).
  add('GET', '/api/events', ({ url }) => {
    const p = url.searchParams, num = (k, d) => Number(p.get(k)) || d;
    const list = store.events.query({ limit: Math.min(Math.max(num('limit', 100), 1), 500), before: num('before', Infinity), action: p.get('action') || '', tool: p.get('tool') || '', q: p.get('q') || '', calls: p.get('calls') || '' });
    return p.get('view') === 'list' ? list.map(slimEvent) : list;
  }, eventsTag);
  // one full record: from the recent window if it is there, otherwise from the audit file of its day (ts says which)
  add('GET', '/api/event', async ({ url }) => {
    const id = url.searchParams.get('id') || '', e = store.events.byId(id) || await store.audit.byId(id, url.searchParams.get('ts'));
    if (!e) throw new HttpError(404, 'not found');
    return e;
  }, eventsTag);

  // The audit trail, newest first, for a time range (from / to are timestamps in ms; only the days they touch are read). Paged by number.
  add('GET', '/api/audit', ({ url }) => {
    const p = url.searchParams, num = (k, d) => (p.get(k) !== null && p.get(k) !== '' && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : d);
    return store.audit.query({ from: num('from', 0), to: num('to', Infinity), page: num('page', 1), size: num('size', 50), action: p.get('action') || '', tool: p.get('tool') || '', q: p.get('q') || '', calls: p.get('calls') || '' });
  }, ({ url }) => `${store.audit.version}|${url.search}`);
  add('GET', '/api/audit/days', () => {
    const days = store.audit.days();
    return { days, bytes: days.reduce((n, d) => n + d.bytes, 0), retentionDays: store.audit.retentionDays };
  }, () => `${store.audit.version}`);


  // ---- content rules (what you SEND) ----
  collection('/api/rules', store.rules, {
    validate: async (l) => validRules(l) || unsafeRegex(l.filter((r) => r.type === 'regex' && r.enabled !== false)),
  });
  const parseSource = async (body) => {
    const { source, text, minConfidence, url } = body;
    if (!SOURCES[source]) throw new HttpError(400, 'unknown source');
    const content = await loadSource(source, text, url);
    const format = source === 'url' ? detectFormat(content) : source; // a pasted link can hold any supported format
    const lib = SOURCES[format];
    const parsed = lib.parse(content, { minConfidence: minConfidence === 'all' ? 'all' : 'high' });
    // patterns that could stall the gateway are left out, with the reason shown in the skipped list
    const regexes = parsed.rules.filter((r) => r.type === 'regex'), bad = await vetPatterns(regexes.map((r) => ({ pattern: r.pattern, flags: r.flags })));
    if (bad.size) {
      const drop = new Set([...bad].map((i) => regexes[i]));
      for (const r of drop) parsed.skipped.push({ id: r.id, reason: 'pattern can take extremely long on some inputs (catastrophic backtracking)' });
      parsed.rules = parsed.rules.filter((r) => !drop.has(r));
    }
    return { source, format, lib, parsed };
  };
  add('POST', '/api/rules/preview', async ({ req }) => {
    const { source, format, lib, parsed } = await parseSource(await readJson(req));
    const have = new Set(store.rules.value.map((r) => r.id)), groups = Object.create(null);
    for (const r of parsed.rules) { const g = (groups[r.group] ||= { total: 0, fresh: 0 }); g.total++; if (!have.has(r.id)) g.fresh++; }
    return {
      source, format, label: lib.label, total: parsed.rules.length, fresh: parsed.rules.filter((r) => !have.has(r.id)).length,
      approx: parsed.rules.filter((r) => r.approx).length, groups, skipped: parsed.skipped.slice(0, 200), skippedCount: parsed.skipped.length,
      storesSecrets: format === 'list' || format === 'env', // exact values are saved in plain text (owner-readable file)
    };
  });
  add('POST', '/api/rules/import', async ({ req }) => {
    const body = await readJson(req);
    if (!['log', 'mask', 'block'].includes(body.mode)) throw new HttpError(400, 'mode must be log, mask or block');
    const { parsed } = await parseSource(body);
    const wanted = Array.isArray(body.groups) ? new Set(body.groups) : null;
    const rules = store.rules.value, byId = new Map(rules.map((r) => [r.id, r]));
    let added = 0, updated = 0;
    for (const nr of parsed.rules) {
      if (wanted && !wanted.has(nr.group)) continue;
      const ex = byId.get(nr.id);
      if (ex) { // re-import: refresh the library's fields, keep the user's own mode / on-off choice
        for (const k of ['name', 'desc', 'pattern', 'type', 'group', 'source', 'secret', 'flags', 'keywords', 'entropy', 'secretGroup', 'approx']) { if (k in nr) ex[k] = nr[k]; else delete ex[k]; }
        updated++;
      } else { const r = { ...nr, mode: body.mode, enabled: true }; rules.push(r); byId.set(r.id, r); added++; }
    }
    store.rules.save();
    return { added, updated, skipped: parsed.skipped.length, total: rules.length };
  });
  add('POST', '/api/test', async ({ req }) => {
    const { text = '' } = await readJson(req);
    try { // same worker pool as live traffic, so a slow rule cannot freeze the dashboard either
      const r = await pool.scan({ raw: Buffer.from(JSON.stringify(String(text))), rules: store.rules.value, version: store.rules.version, wantValue: true });
      return { hits: r.hits, blocked: r.blocked, output: r.value };
    } catch (e) { if (e instanceof ScanError) throw new HttpError(e.kind === 'busy' ? 503 : 400, e.kind === 'timeout' ? 'the scan took too long: one of your rules is too slow for this text' : e.message); throw e; }
  });

  // ---- command rules (what the MODEL asks your tools to run) ----
  add('GET', '/api/toolrules', () => ({ rules: store.toolRules.value, counts: toolRuleCounts(store.events.list), inspectToolCalls: store.settings.value.inspectToolCalls }), () => `${store.events.version}|${store.toolRules.version}|${store.settings.version}`);
  add('PUT', '/api/toolrules', async ({ req }) => {
    const next = await readJson(req);
    const bad = validToolRules(next) || await unsafeRegex(next.filter((r) => r.match === 'regex' && r.enabled !== false).map((r) => ({ name: r.name || r.id, pattern: splitFlags(r.pattern).source, flags: splitFlags(r.pattern).flags })));
    if (bad) throw new HttpError(400, bad);
    return store.toolRules.set(next.map((r) => ({ id: r.id, name: String(r.name || r.id), tool: r.tool.trim(), match: r.match, pattern: r.pattern, action: r.action, enabled: r.enabled !== false, ...(r.note ? { note: String(r.note).slice(0, 200) } : {}) })));
  });

  // ---- command rules: bulk import (built-in library, a link, or pasted text) ----
  const parseCommands = async (body) => {
    const { source, text, url } = body;
    let content;
    if (source === 'builtin') content = fs.readFileSync(path.join(config.root, 'lib', 'sensitive-commands.yml'), 'utf8');
    else if (source === 'url') content = await loadSource('url', null, url);
    else if (source === 'text') {
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'paste some text first');
      if (text.length > 2_000_000) throw new HttpError(413, 'text too large (2 MB max)');
      content = text;
    } else throw new HttpError(400, 'unknown source');
    if (source !== 'builtin' && !looksLikeCommandRules(content)) throw new HttpError(400, 'this does not look like a command-rules file (expected "rules:" with pattern / match / action fields; see lib/sensitive-commands.yml)');
    let parsed;
    try { parsed = parseCommandRules(content); } catch (e) { throw new HttpError(400, e.message); }
    const regexes = parsed.rules.filter((r) => r.match === 'regex'), bad = await vetPatterns(regexes.map((r) => ({ pattern: splitFlags(r.pattern).source, flags: splitFlags(r.pattern).flags })));
    if (bad.size) {
      const drop = new Set([...bad].map((i) => regexes[i]));
      for (const r of drop) parsed.skipped.push({ id: r.name, reason: 'pattern can take extremely long on some inputs (catastrophic backtracking)' });
      parsed.rules = parsed.rules.filter((r) => !drop.has(r));
    }
    return parsed;
  };
  add('POST', '/api/toolrules/preview', async ({ req }) => {
    const parsed = await parseCommands(await readJson(req));
    const have = new Set(store.toolRules.value.map((r) => r.id)), groups = Object.create(null);
    for (const r of parsed.rules) { const g = (groups[r.group] ||= { total: 0, fresh: 0 }); g.total++; if (!have.has(r.id)) g.fresh++; }
    return { total: parsed.rules.length, fresh: parsed.rules.filter((r) => !have.has(r.id)).length, blocking: parsed.rules.filter((r) => r.action === 'block').length, groups, skipped: parsed.skipped.slice(0, 200), skippedCount: parsed.skipped.length };
  });
  add('POST', '/api/toolrules/import', async ({ req }) => {
    const body = await readJson(req);
    if (!['flag', 'block', 'file'].includes(body.action)) throw new HttpError(400, 'action must be flag, block or file');
    const parsed = await parseCommands(body), wanted = Array.isArray(body.groups) ? new Set(body.groups) : null;
    const rules = store.toolRules.value.map((r) => ({ ...r })), byId = new Map(rules.map((r) => [r.id, r]));
    let added = 0, updated = 0;
    for (const nr of parsed.rules) {
      if (wanted && !wanted.has(nr.group)) continue;
      const { group, ...rule } = nr, ex = byId.get(rule.id);
      if (ex) { Object.assign(ex, { name: rule.name, ...(rule.note ? { note: rule.note } : {}) }); updated++; } // re-import keeps your action and on/off choice
      else { const r = { ...rule, action: body.action === 'file' ? rule.action : body.action, enabled: true }; rules.push(r); byId.set(r.id, r); added++; }
    }
    store.toolRules.set(rules);
    return { added, updated, skipped: parsed.skipped.length, total: rules.length };
  });

  // ---- upstreams, clients ----
  collection('/api/upstreams', store.upstreams, {
    validate: (l) => (validUpstreams(l) ? null : 'invalid upstreams: prefix must be [a-z0-9-], unique, url must be http(s)'),
    normalize: (l) => l.map((u) => ({ id: u.prefix, label: String(u.label || u.prefix), prefix: u.prefix, url: u.url.replace(/\/+$/, ''), env: String(u.env || ''), suffix: String(u.suffix || ''), format: ['anthropic', 'gemini'].includes(u.format) ? u.format : 'openai' })),
  });
  collection('/api/clients', store.clients, {
    validate: async (l) => (validClients(l) ? unsafeRegex(l.filter((r) => r.enabled !== false).map((r) => ({ name: r.name, pattern: r.pattern, flags: 'i' }))) : 'invalid client rules: need name, header (letters/digits/-) and a valid regex pattern'),
    normalize: (l) => l.map((r) => ({ name: String(r.name).trim(), header: r.header.toLowerCase(), pattern: r.pattern, enabled: r.enabled !== false })),
  });

  // user-agents seen recently, for the Clients page (computed here so the page does not download the whole log)
  add('GET', '/api/clients/seen', () => {
    const seen = new Map();
    for (const e of store.events.list) { const ua = e.headers?.['user-agent'] || '(none)', v = seen.get(ua) || { ua, tool: e.tool, n: 0 }; v.n++; seen.set(ua, v); }
    return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  }, eventsTag);

  // ---- settings ----
  add('GET', '/api/settings', () => store.settings.value);
  add('PUT', '/api/settings', async ({ req }) => {
    const next = await readJson(req);
    const keys = SETTING_KEYS.filter((k) => k in next);
    if (!keys.length) throw new HttpError(400, 'nothing to update');
    for (const k of keys) if (!asBool(next[k])) throw new HttpError(400, `${k} must be boolean`);
    return store.settings.set({ ...store.settings.value, ...Object.fromEntries(keys.map((k) => [k, next[k]])) });
  });
  add('POST', '/api/settings/purge', () => ({ purged: store.events.purgeMatchedText() }));

  return async function api(req, res, url) {
    try {
      if (!localHost(req)) throw new HttpError(403, 'forbidden');
      if (req.method !== 'GET' && badOrigin(req)) throw new HttpError(403, 'bad origin');
      const route = routes.get(`${req.method} ${url.pathname}`);
      if (!route) throw new HttpError(404, 'not found');
      let headers = {};
      if (route.etag) {
        const tag = `W/"${route.etag({ url })}"`; headers = { etag: tag, 'cache-control': 'no-cache' };
        if (req.headers['if-none-match'] === tag) { res.writeHead(304, headers); return res.end(); }
      }
      json(res, 200, await route.handler({ req, url }), headers);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      json(res, 500, { error: 'internal error' });
    }
  };
}
