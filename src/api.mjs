// The dashboard's JSON API as a route table. Each handler returns a value (sent as JSON) or throws HttpError.
import { scanValue as scan, validRules, validUpstreams, validClients } from '../lib/core.mjs';
import { validToolRules } from '../lib/toolcalls.mjs';
import { SOURCES } from '../lib/rulelib.mjs';
import { HttpError, json, localHost, badOrigin, readJson } from './http.mjs';
import { createSourceLoader } from './presets.mjs';
import { stats, toolRuleCounts } from './stats.mjs';

const SETTING_KEYS = ['storeMatchedText', 'inspectToolCalls'];
const asBool = (v) => v === true || v === false;

export function createApi({ store, config }) {
  const loadSource = createSourceLoader(config.presets);
  const routes = new Map();
  const add = (method, path, handler) => routes.set(`${method} ${path}`, handler);

  // GET returns the document; PUT validates, normalises, saves. Used by every editable list.
  const collection = (path, doc, { validate, normalize = (x) => x }) => {
    add('GET', path, () => doc.value);
    add('PUT', path, async ({ req }) => {
      const next = await readJson(req);
      const bad = validate(next);
      if (bad) throw new HttpError(400, bad);
      return doc.set(normalize(next));
    });
  };

  // ---- overview ----
  add('GET', '/api/stats', () => stats(store.events.list));
  add('GET', '/api/events', ({ url }) => store.events.recent(Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), config.maxEvents)));

  // ---- content rules (what you SEND) ----
  collection('/api/rules', store.rules, { validate: validRules });
  const parseSource = async (body) => {
    const { source, text, minConfidence } = body;
    const lib = SOURCES[source];
    if (!lib) throw new HttpError(400, 'unknown source');
    return { source, lib, parsed: lib.parse(await loadSource(source, text), { minConfidence: minConfidence === 'all' ? 'all' : 'high' }) };
  };
  add('POST', '/api/rules/preview', async ({ req }) => {
    const { source, lib, parsed } = await parseSource(await readJson(req));
    const have = new Set(store.rules.value.map((r) => r.id)), groups = {};
    for (const r of parsed.rules) { const g = (groups[r.group] ||= { total: 0, fresh: 0 }); g.total++; if (!have.has(r.id)) g.fresh++; }
    return {
      source, label: lib.label, total: parsed.rules.length, fresh: parsed.rules.filter((r) => !have.has(r.id)).length,
      approx: parsed.rules.filter((r) => r.approx).length, groups, skipped: parsed.skipped.slice(0, 200), skippedCount: parsed.skipped.length,
      storesSecrets: source === 'list' || source === 'env',
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
    const r = scan(store.rules.value, text);
    return { hits: r.hits, blocked: r.blocked, output: r.value };
  });

  // ---- command rules (what the MODEL asks your tools to run) ----
  add('GET', '/api/toolrules', () => ({ rules: store.toolRules.value, counts: toolRuleCounts(store.events.list), inspectToolCalls: store.settings.value.inspectToolCalls }));
  add('PUT', '/api/toolrules', async ({ req }) => {
    const next = await readJson(req);
    const bad = validToolRules(next);
    if (bad) throw new HttpError(400, bad);
    return store.toolRules.set(next.map((r) => ({ id: r.id, name: String(r.name || r.id), tool: r.tool.trim(), match: r.match, pattern: r.pattern, action: r.action, enabled: r.enabled !== false, ...(r.note ? { note: String(r.note).slice(0, 200) } : {}) })));
  });

  // ---- upstreams, clients ----
  collection('/api/upstreams', store.upstreams, {
    validate: (l) => (validUpstreams(l) ? null : 'invalid upstreams: prefix must be [a-z0-9-], unique, url must be http(s)'),
    normalize: (l) => l.map((u) => ({ id: u.prefix, label: String(u.label || u.prefix), prefix: u.prefix, url: u.url.replace(/\/+$/, ''), env: String(u.env || ''), suffix: String(u.suffix || ''), format: ['anthropic', 'gemini'].includes(u.format) ? u.format : 'openai' })),
  });
  collection('/api/clients', store.clients, {
    validate: (l) => (validClients(l) ? null : 'invalid client rules: need name, header (letters/digits/-) and a valid regex pattern'),
    normalize: (l) => l.map((r) => ({ name: String(r.name).trim(), header: r.header.toLowerCase(), pattern: r.pattern, enabled: r.enabled !== false })),
  });

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
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (!handler) throw new HttpError(404, 'not found');
      json(res, 200, await handler({ req, url }));
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      json(res, 500, { error: 'internal error' });
    }
  };
}
