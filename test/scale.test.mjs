// Scale and safety: worker-thread scanning, runaway regexes, paging, lifetime statistics, limits and timeouts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createScanPool, ScanError } from '../src/scan-pool.mjs';
import { vetPatterns } from '../src/vet.mjs';
import { EventLog, countEvent, createStore, slimEvent } from '../src/store.mjs';
import { scanValue } from '../lib/core.mjs';
import { DEFAULT_TOOL_RULES } from '../lib/toolcalls.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rule = (o) => ({ id: 'r', name: 'R', type: 'regex', pattern: 'x', mode: 'log', enabled: true, ...o });
const raw = (o) => Buffer.from(JSON.stringify(o));
const EVIL = rule({ id: 'evil', name: 'evil', pattern: '(a+)+$' });
const HOSTILE = { messages: [{ role: 'user', content: 'a'.repeat(34) + '!' }] }; // exponential: minutes of CPU if it ever ran on the main thread

describe('scan pool', () => {
  test('scans in a worker and returns hits, model and the masked body', async () => {
    const pool = createScanPool({ size: 1, timeoutMs: 2000 });
    const r = await pool.scan({ raw: raw({ model: 'm1', messages: [{ content: 'key AKIAABCDEFGHIJKLMNOP' }] }), rules: [rule({ id: 'aws', pattern: 'AKIA[0-9A-Z]{16}', mode: 'mask' })], version: 1 });
    assert.equal(r.model, 'm1'); assert.equal(r.hits[0].id, 'aws'); assert.match(JSON.parse(r.body).messages[0].content, /PROMPTHOLE_AWS_/);
    const clean = await pool.scan({ raw: raw({ a: 'nothing' }), rules: [], version: 2 });
    assert.equal(clean.body, undefined); assert.equal(clean.hits.length, 0);
    assert.equal((await pool.scan({ raw: Buffer.from('not json'), rules: [], version: 2 })).unparseable, true);
    await pool.close();
  });
  test('rules are sent to a worker only when they change', async () => {
    const pool = createScanPool({ size: 1 });
    const a = await pool.scan({ raw: raw({ t: 'foo' }), rules: [rule({ id: 'one', pattern: 'foo' })], version: 1 });
    const b = await pool.scan({ raw: raw({ t: 'foo' }), rules: [rule({ id: 'two', pattern: 'foo' })], version: 1 }); // same version: worker keeps the old rules
    const c = await pool.scan({ raw: raw({ t: 'foo' }), rules: [rule({ id: 'two', pattern: 'foo' })], version: 2 });
    assert.deepEqual([a.hits[0].id, b.hits[0].id, c.hits[0].id], ['one', 'one', 'two']);
    await pool.close();
  });
  test('a runaway regex is stopped at the time limit and the worker is replaced', async () => {
    const pool = createScanPool({ size: 1, timeoutMs: 300 });
    const t = Date.now();
    await assert.rejects(pool.scan({ raw: raw(HOSTILE), rules: [EVIL], version: 1 }), (e) => e instanceof ScanError && e.kind === 'timeout');
    assert.ok(Date.now() - t < 2000, 'returned at the limit, not after the regex finished');
    const ok = await pool.scan({ raw: raw({ t: 'fine' }), rules: [rule({ pattern: 'fine' })], version: 2 }); // the pool is healthy again
    assert.equal(ok.hits.length, 1);
    await pool.close();
  });
  test('other scans keep flowing while one worker is stuck', async () => {
    const pool = createScanPool({ size: 2, timeoutMs: 1500 });
    const stuck = pool.scan({ raw: raw(HOSTILE), rules: [EVIL], version: 1 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    const t = Date.now(); await pool.scan({ raw: raw({ t: 'hello' }), rules: [rule({ pattern: 'hello' })], version: 2 });
    assert.ok(Date.now() - t < 500);
    assert.ok((await stuck) instanceof ScanError);
    await pool.close();
  });
  test('a full queue says busy; a closed pool refuses work', async () => {
    const pool = createScanPool({ size: 1, timeoutMs: 400, maxQueue: 1 });
    const a = pool.scan({ raw: raw(HOSTILE), rules: [EVIL], version: 1 }).catch((e) => e);
    const b = pool.scan({ raw: raw({ t: 1 }), rules: [], version: 1 }).catch((e) => e);
    await assert.rejects(pool.scan({ raw: raw({}), rules: [], version: 1 }), (e) => e.kind === 'busy');
    await Promise.all([a, b]);
    assert.ok(pool.stats().size === 1);
    await pool.close();
    await assert.rejects(pool.scan({ raw: raw({}), rules: [], version: 1 }), (e) => e.kind === 'closed');
  });
});

describe('regex vetting', () => {
  test('flags catastrophic patterns and passes ordinary ones', async () => {
    const bad = await vetPatterns([{ pattern: '(a+)+$' }, { pattern: 'AKIA[0-9A-Z]{16}' }, { pattern: '(.*a){20}' }, { pattern: '\\bsudo\\b' }, { pattern: '[' }]);
    assert.deepEqual([...bad].sort(), [0, 2]);
  });
  test('verdicts are cached (a second pass does no work)', async () => {
    await vetPatterns([{ pattern: 'cache-me-\\d+' }]);
    const t = Date.now(); await vetPatterns([{ pattern: 'cache-me-\\d+' }, { pattern: '(a+)+$' }]);
    assert.ok(Date.now() - t < 50);
  });
});

describe('clean-text cache', () => {
  test('long text found clean is skipped next time; changed text is scanned again', () => {
    const rules = [rule({ id: 'k', type: 'keyword', pattern: 'secret', mode: 'mask' })], cache = new Set(), long = 'hello world '.repeat(200);
    assert.equal(scanValue(rules, { m: long }, { cleanCache: cache }).hits.length, 0); assert.equal(cache.size, 1);
    assert.equal(scanValue(rules, { m: long }, { cleanCache: cache }).value.m, long);
    const r = scanValue(rules, { m: long + ' secret' }, { cleanCache: cache });
    assert.equal(r.hits.length, 1); assert.equal(cache.size, 1, 'text with a hit is never remembered as clean');
    assert.equal(scanValue(rules, { m: 'short secret' }, { cleanCache: cache }).hits.length, 1);
  });
  test('the cache is bounded', () => {
    const cache = new Set();
    for (let i = 0; i < 20100; i++) scanValue([], { m: `${i} `.padEnd(1100, 'x') }, { cleanCache: cache });
    assert.ok(cache.size <= 20000);
  });
});

describe('store', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ph-scale-'));
  const ev = (i, o = {}) => ({ id: 'e' + i, ts: 1000 + i, tool: i % 2 ? 'Claude Code' : 'Codex CLI', provider: 'm', path: '/v1/x', model: 'mod' + (i % 3), action: 'allowed', hits: [{ name: 'Rule ' + i, mode: 'mask', count: 1, matches: [{ text: 't' }] }], headers: { 'user-agent': 'ua' }, bytes: 1, status: 200, ms: 1, ...o });
  test('query pages, filters and slims', () => {
    const dir = tmp(), log = new EventLog(path.join(dir, 'e.jsonl'), 100);
    for (let i = 0; i < 30; i++) log.record(ev(i, { action: i % 5 === 0 ? 'blocked' : 'allowed', calls: i === 7 ? [{ id: 'c', name: 'Bash', text: 'rm -rf build', action: 'flagged', rule: 'x' }] : undefined }));
    assert.equal(log.query({ limit: 10 }).length, 10);
    assert.deepEqual(log.query({ limit: 3, before: 1020 }).map((e) => e.id), ['e20', 'e19', 'e18']);
    assert.ok(log.query({ action: 'blocked', limit: 100 }).every((e) => e.action === 'blocked'));
    assert.equal(log.query({ tool: 'Codex CLI', limit: 100 }).length, 15);
    assert.equal(log.query({ q: 'rm -rf', limit: 100 })[0].id, 'e7');
    assert.deepEqual(log.query({ calls: 'risky', limit: 100 }).map((e) => e.id), ['e7'], 'only requests where the model asked for something flagged or blocked');
    assert.equal(log.query({ q: 'rule 12', limit: 100 }).length, 1);
    assert.equal(log.byId('e3').id, 'e3'); assert.equal(log.byId('nope'), null);
    const s = slimEvent(log.byId('e3')); assert.equal(s.headers, undefined); assert.equal(s.hits[0].matches, undefined); assert.equal(s.hits[0].name, 'Rule 3');
    fs.rmSync(dir, { recursive: true });
  });
  test('lifetime counters are seeded from existing events, survive trimming and are saved', async () => {
    const dir = tmp(); fs.writeFileSync(path.join(dir, 'events.jsonl'), [ev(1, { tokens: { in: 10, out: 5, cacheRead: 2, cacheWrite: 0, reasoning: 0 }, calls: [{ action: 'blocked' }, { action: 'flagged' }] }), ev(2, { action: 'blocked' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const config = { dataDir: dir, root: ROOT, maxEvents: 2 };
    const store = createStore(config);
    assert.equal(store.counters.value.requests, 2); assert.equal(store.counters.value.tokens.in, 10); assert.equal(store.counters.value.calls.blocked, 1); assert.equal(store.counters.value.since, 1001);
    for (let i = 3; i < 10; i++) store.events.record(ev(i, { tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }));
    assert.equal(store.events.list.length, 2, 'log keeps only the latest');
    assert.equal(store.counters.value.requests, 9, 'totals keep counting');
    store.flush();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'counters.json'), 'utf8')).requests, 9);
    assert.equal(createStore(config).counters.value.requests, 9, 'and survive a restart');
    fs.rmSync(dir, { recursive: true });
  });
  test('countEvent tolerates events without tokens or calls', () => {
    const c = { requests: 0, actions: {}, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }, calls: { total: 0, flagged: 0, blocked: 0 } };
    countEvent(c, ev(1)); assert.equal(c.requests, 1); assert.equal(c.tokens.requests, 0);
  });
  test('new built-in rules reach existing installs once; deleted ones stay deleted', () => {
    const dir = tmp(), config = { dataDir: dir, root: ROOT, maxEvents: 10 };
    let store = createStore(config);
    store.toolRules.set(store.toolRules.value.filter((r) => r.id !== 'tr-sudo')); // the user deletes one built-in
    store = createStore(config);
    assert.ok(!store.toolRules.value.some((r) => r.id === 'tr-sudo'), 'not resurrected');
    const seen = store.settings.value.seenDefaults; seen.toolRules = seen.toolRules.filter((id) => id !== 'tr-rm-r'); store.settings.save(); // as if this version had not shipped it yet
    store.toolRules.set(store.toolRules.value.filter((r) => r.id !== 'tr-rm-r'));
    store = createStore(config);
    assert.ok(store.toolRules.value.some((r) => r.id === 'tr-rm-r'), 'newly shipped rule is added');
    assert.equal(DEFAULT_TOOL_RULES.length - 1, store.toolRules.value.length);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---- a real server, with a configurable mock upstream ----
let mock, base, tmp, child, port;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
async function start(env, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-srv-'));
  fs.writeFileSync(path.join(dir, 'upstreams.json'), JSON.stringify([{ id: 'm', label: 'M', prefix: 'm', url: `http://127.0.0.1:${mock.address().port}`, env: '', suffix: '', format: 'openai' }]));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), typeof v === 'string' ? v : JSON.stringify(v));
  const p = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); });
  const c = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(p), PROMPTHOLE_DATA: dir, ...env }, stdio: 'ignore' });
  const b = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(b + '/api/stats')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  // clean up only after the server has exited (it saves its counters on the way out)
  return { base: b, dir, stop: () => { c.once('exit', () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })); c.kill(); } };
}
const chat = (b, body, extra = {}) => fetch(b + '/m/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });
const putJson = (b, p, body) => fetch(b + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.includes('stall')) return; // never answers
      if (req.url.includes('slow')) { res.writeHead(200, { 'content-type': 'application/json' }); return setTimeout(() => res.end('{"ok":true}'), 700); }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
      res.end('{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}');
    });
  });
  await listen(mock);
});
after(() => mock?.close());

describe('server: runaway rules cannot freeze the gateway', () => {
  let s;
  before(async () => { s = await start({ PROMPTHOLE_SCAN_TIMEOUT_MS: '600' }, { 'rules.json': [EVIL] }); });
  after(() => s.stop());
  test('the hostile request is rejected at the limit while other requests stay fast', async () => {
    const slow = chat(s.base, HOSTILE);
    await new Promise((r) => setTimeout(r, 100));
    const t = Date.now(); assert.equal((await fetch(s.base + '/api/settings')).status, 200); assert.ok(Date.now() - t < 300, 'dashboard answers immediately');
    assert.equal((await chat(s.base, { messages: [{ content: 'short' }] })).status, 200, 'other traffic is unaffected');
    const r = await slow; assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /could not finish checking/);
    const ev = (await (await fetch(s.base + '/api/events?limit=5')).json()).find((e) => e.error === 'scan_timeout');
    assert.equal(ev.action, 'blocked');
  });
  test('rules that can hang are refused when saved through the API', async () => {
    const r = await putJson(s.base, '/api/rules', [EVIL]); assert.equal(r.status, 400); assert.match((await r.json()).error, /catastrophic backtracking/);
    assert.equal((await putJson(s.base, '/api/rules', [rule({ pattern: 'fine\\d+' })])).status, 200);
    assert.equal((await putJson(s.base, '/api/clients', [{ name: 'x', header: 'user-agent', pattern: '(a+)+$', enabled: true }])).status, 400);
    const tr = await putJson(s.base, '/api/toolrules', [{ id: 't', name: 't', tool: '*', match: 'regex', pattern: '(a+)+$', action: 'flag', enabled: true }]);
    assert.equal(tr.status, 400);
  });
  test('the rule tester is protected too', async () => {
    await fs.promises.writeFile(path.join(s.dir, 'rules.json'), JSON.stringify([EVIL])); // bypass the API: simulates an old config
    const stop = await start({ PROMPTHOLE_SCAN_TIMEOUT_MS: '500' }, { 'rules.json': [EVIL] });
    const r = await fetch(stop.base + '/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: HOSTILE.messages[0].content }) });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /too slow/); stop.stop();
  });
});

describe('server: fail-open option', () => {
  test('PROMPTHOLE_ON_SCAN_TIMEOUT=allow forwards the request when a scan times out', async () => {
    const s = await start({ PROMPTHOLE_SCAN_TIMEOUT_MS: '300', PROMPTHOLE_ON_SCAN_TIMEOUT: 'allow' }, { 'rules.json': [EVIL] });
    assert.equal((await chat(s.base, HOSTILE)).status, 200); s.stop();
  });
});

describe('server: limits and timeouts', () => {
  test('oversized request bodies are refused with 413', async () => {
    const s = await start({ PROMPTHOLE_MAX_BODY_MB: '0.001' });
    const r = await chat(s.base, { messages: [{ content: 'x'.repeat(5000) }] });
    assert.equal(r.status, 413); s.stop();
  });
  test('an upstream that never answers is given up on; a slow but alive one is not', async () => {
    const s = await start({ PROMPTHOLE_UPSTREAM_IDLE_SECONDS: '0.4' });
    const dead = await fetch(s.base + '/m/stall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(dead.status, 502); assert.match((await dead.json()).error.message, /nothing for/);
    s.stop();
    const s2 = await start({ PROMPTHOLE_UPSTREAM_IDLE_SECONDS: '5' });
    const ok = await fetch(s2.base + '/m/slow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 200); s2.stop();
  });
  test('multiple set-cookie headers survive the proxy', async () => {
    const s = await start({});
    const r = await chat(s.base, { messages: [{ content: 'hi' }] });
    assert.deepEqual(r.headers.getSetCookie(), ['a=1', 'b=2']); s.stop();
  });
});

describe('server: paging, filters, lifetime stats, caching', () => {
  let s;
  before(async () => {
    s = await start({});
    for (let i = 0; i < 12; i++) await chat(s.base, { model: i % 2 ? 'alpha' : 'beta', messages: [{ content: i === 3 ? 'key AKIAABCDEFGHIJKLMNOP' : 'hi ' + i }] });
    await new Promise((r) => setTimeout(r, 200));
  });
  after(() => s.stop());
  const get = async (p) => (await fetch(s.base + p)).json();
  test('list view is slim, detail view is full', async () => {
    const list = await get('/api/events?view=list&limit=3');
    assert.equal(list.length, 3); assert.equal(list[0].headers, undefined);
    const full = await get('/api/event?id=' + list[0].id); assert.ok(full.headers);
    assert.equal((await fetch(s.base + '/api/event?id=nope')).status, 404);
  });
  test('paging with before, and filtering', async () => {
    const page1 = await get('/api/events?view=list&limit=5'), page2 = await get(`/api/events?view=list&limit=5&before=${page1.at(-1).ts}`);
    const ids = new Set(page1.map((e) => e.id)); assert.ok(page2.some((e) => !ids.has(e.id)));
    assert.equal((await get('/api/events?view=list&action=masked')).length, 1);
    assert.equal((await get('/api/events?view=list&q=alpha')).length, 6);
  });
  test('lifetime totals and the window size are reported', async () => {
    const st = await get('/api/stats'); assert.equal(st.lifetime.requests, 12); assert.equal(st.lifetime.actions.masked, 1); assert.equal(st.lifetime.tokens.in, 60); assert.ok(st.window >= 100);
  });
  test('polling is cheap: unchanged data answers 304, new data answers 200', async () => {
    const first = await fetch(s.base + '/api/events?view=list&limit=5'), tag = first.headers.get('etag'); await first.arrayBuffer();
    assert.ok(tag);
    assert.equal((await fetch(s.base + '/api/events?view=list&limit=5', { headers: { 'if-none-match': tag } })).status, 304);
    await chat(s.base, { messages: [{ content: 'new' }] }); await new Promise((r) => setTimeout(r, 150));
    assert.equal((await fetch(s.base + '/api/events?view=list&limit=5', { headers: { 'if-none-match': tag } })).status, 200);
  });
  test('/api/clients/seen', async () => {
    const seen = await get('/api/clients/seen'); assert.ok(seen[0].n >= 12); assert.ok(seen[0].ua);
  });
  test('importing a library skips patterns that could hang', async () => {
    const r = await fetch(s.base + '/api/rules/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'list', text: 're:(a+)+$\nre:AKIA[0-9A-Z]{16}\nproject falcon', mode: 'log' }) });
    const j = await r.json(); assert.equal(j.added, 2); assert.equal(j.skipped, 1);
  });
});
