// Bulk rule import, end to end: real PromptHole process, a local stand-in for the rule-library hosts, a mock model upstream.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stopAndRemove } from './stop.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GL = fs.readFileSync(path.join(ROOT, 'test/fixtures/gitleaks.sample.toml'), 'utf8');
const SPDB = `patterns:
  - pattern:
      name: Acme Token
      regex: acme_[a-z0-9]{12}
      confidence: high
  - pattern:
      name: Noisy
      regex: noisy-[0-9]{3}
      confidence: low
`;
const body = (n) => Array.from({ length: n }, (_, i) => 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ-_xR2cF4hJ6lN8pS0uW2yA4'[i % 49]).join('');
const ANTHROPIC = 'sk-ant-api03-' + body(93) + 'AA';
const AWS = 'AKIAIOSFODNN7EXAMPLE';

let libs, libPort, mock, mockPort, prompthole, port, tmp, child, upstreamCalls = [];
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const rd = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });

before(async () => {
  libs = http.createServer((req, res) => {
    if (req.url === '/gitleaks.toml') { res.writeHead(200); return res.end(GL); }
    if (req.url === '/spdb.yml') { res.writeHead(200); return res.end(SPDB); }
    res.writeHead(404); res.end('nope');
  });
  libPort = await listen(libs);
  mock = http.createServer(async (req, res) => {
    const raw = await rd(req); upstreamCalls.push(raw);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  mockPort = await listen(mock);
  const probe = http.createServer(); port = await listen(probe); await new Promise((r) => probe.close(r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-imp-'));
  fs.writeFileSync(path.join(tmp, 'upstreams.json'), JSON.stringify([{ id: 'mock', label: 'm', prefix: 'mock', url: `http://127.0.0.1:${mockPort}`, env: '', suffix: '', format: 'openai' }]));
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ storeMatchedText: false }));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { stdio: 'ignore', env: { ...process.env, PROMPTHOLE_PORT: String(port), PROMPTHOLE_DATA: tmp,
    PROMPTHOLE_PRESET_GITLEAKS_URL: `http://127.0.0.1:${libPort}/gitleaks.toml`, PROMPTHOLE_PRESET_SECRETSDB_URL: `http://127.0.0.1:${libPort}/spdb.yml` } });
  prompthole = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(prompthole + '/api/stats')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('prompthole did not start');
});
after(async () => { libs?.close(); mock?.close(); await stopAndRemove(child, tmp); });

const post = (p, o, h = {}) => fetch(prompthole + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(o) });
const getRules = async () => (await fetch(prompthole + '/api/rules')).json();
const putRules = (r) => fetch(prompthole + '/api/rules', { method: 'PUT', body: JSON.stringify(r) });
const chat = (content) => ({ model: 'm', messages: [{ role: 'user', content }] });
const send = async (content) => { upstreamCalls = []; const r = await post('/mock/v1/chat', chat(content)); return { status: r.status, sent: upstreamCalls[0] || '' }; };

describe('preview', () => {
  test('summarises a library without changing any rules', async () => {
    const before = JSON.stringify(await getRules());
    const p = await (await post('/api/rules/preview', { source: 'gitleaks' })).json();
    assert.equal(p.total, 7); assert.equal(p.fresh, 7);
    assert.equal(p.skippedCount, 1); assert.match(p.skipped[0].reason, /path/);
    assert.ok(p.groups['AI & ML'].total >= 2);
    assert.ok(p.approx >= 1, 'adapted rules are counted');
    assert.equal(JSON.stringify(await getRules()), before);
  });
  test('secrets-db: high confidence by default, low on request', async () => {
    assert.equal((await (await post('/api/rules/preview', { source: 'secrets-db' })).json()).total, 1);
    assert.equal((await (await post('/api/rules/preview', { source: 'secrets-db', minConfidence: 'all' })).json()).total, 2);
  });
  test('pasted sources need text and warn that they store secrets', async () => {
    assert.equal((await post('/api/rules/preview', { source: 'list', text: '  ' })).status, 400);
    const p = await (await post('/api/rules/preview', { source: 'list', text: 'Project Falcon' })).json();
    assert.equal(p.storesSecrets, true);
    assert.equal((await (await post('/api/rules/preview', { source: 'gitleaks' })).json()).storesSecrets, false);
  });
  test('unknown source and oversized text are rejected', async () => {
    assert.equal((await post('/api/rules/preview', { source: 'nope' })).status, 400);
    assert.equal((await post('/api/rules/preview', { source: 'list', text: 'x'.repeat(2_000_001) })).status, 413);
    assert.equal((await fetch(prompthole + '/api/rules/preview', { method: 'POST', body: 'not json' })).status, 400);
  });
});

describe('import', () => {
  test('rejects a bad mode and foreign origins', async () => {
    assert.equal((await post('/api/rules/import', { source: 'gitleaks', mode: 'nuke' })).status, 400);
    assert.equal((await post('/api/rules/import', { source: 'gitleaks', mode: 'log' }, { origin: 'https://evil.example.com' })).status, 403);
  });
  test('adds the library with the chosen mode, keeps existing rules', async () => {
    assert.equal((await putRules([])).status, 200); // clean slate: the built-in default rules would otherwise also act on these keys
    const had = (await getRules()).length;
    const r = await (await post('/api/rules/import', { source: 'gitleaks', mode: 'log' })).json();
    assert.equal(r.added, 7); assert.equal(r.updated, 0); assert.equal(r.skipped, 1); assert.equal(r.total, had + 7);
    const gl = (await getRules()).filter((x) => x.id.startsWith('gl:'));
    assert.equal(gl.length, 7);
    assert.ok(gl.every((x) => x.mode === 'log' && x.enabled === true && x.source === 'gitleaks'));
  });
  test('imported rules really act on traffic: log passes, mask rewrites, block rejects', async () => {
    let r = await send(`k=${AWS}`);
    assert.equal(r.status, 200); assert.ok(r.sent.includes(AWS), 'log mode forwards unchanged');
    const rules = await getRules();
    rules.find((x) => x.id === 'gl:aws-access-token').mode = 'mask';
    rules.find((x) => x.id === 'gl:anthropic-api-key').mode = 'block';
    assert.equal((await putRules(rules)).status, 200);
    r = await send(`k=${AWS}`);
    assert.ok(!r.sent.includes(AWS) && /\[PROMPTHOLE_GLAWSACCESSTOKEN_[0-9a-f]{6}\]/.test(r.sent));
    r = await send(`k=${ANTHROPIC}`);
    assert.equal(r.status, 400); assert.equal(r.sent, '', 'blocked locally, upstream not contacted');
  });
  test('re-import refreshes the library but keeps the user\'s own mode and on/off choices', async () => {
    const rules = await getRules();
    const mine = rules.find((x) => x.id === 'gl:aws-access-token'); mine.pattern = 'tampered'; mine.enabled = false;
    await putRules(rules);
    const r = await (await post('/api/rules/import', { source: 'gitleaks', mode: 'block' })).json();
    assert.equal(r.added, 0); assert.equal(r.updated, 7);
    const after = (await getRules()).find((x) => x.id === 'gl:aws-access-token');
    assert.notEqual(after.pattern, 'tampered', 'library fields are refreshed');
    assert.equal(after.mode, 'mask', 'user mode kept (not reset to the new import mode)');
    assert.equal(after.enabled, false, 'user on/off kept');
  });
  test('only the selected groups are imported', async () => {
    const keep = (await getRules()).filter((x) => !x.id.startsWith('gl:'));
    await putRules(keep);
    const r = await (await post('/api/rules/import', { source: 'gitleaks', mode: 'log', groups: ['AI & ML'] })).json();
    assert.ok(r.added >= 2 && r.added < 7);
    assert.ok((await getRules()).filter((x) => x.id.startsWith('gl:')).every((x) => x.group === 'AI & ML'));
  });
  test('secrets-db import', async () => {
    const r = await (await post('/api/rules/import', { source: 'secrets-db', mode: 'mask' })).json();
    assert.equal(r.added, 1);
    assert.equal((await send('x acme_abcdef123456 y')).sent.includes('acme_abcdef123456'), false);
  });
  test('a download failure is a clear 502, not a crash', async () => {
    const c2 = await new Promise((resolve) => {
      const probe = http.createServer(); probe.listen(0, '127.0.0.1', async () => {
        const p = probe.address().port; probe.close();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-imp2-'));
        const ch = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { stdio: 'ignore', env: { ...process.env, PROMPTHOLE_PORT: String(p), PROMPTHOLE_DATA: dir, PROMPTHOLE_PRESET_GITLEAKS_URL: `http://127.0.0.1:${libPort}/missing.toml` } });
        for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${p}/api/stats`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
        const r = await fetch(`http://127.0.0.1:${p}/api/rules/preview`, { method: 'POST', body: JSON.stringify({ source: 'gitleaks' }) });
        const j = await r.json(); await stopAndRemove(ch, dir); resolve({ status: r.status, j });
      });
    });
    assert.equal(c2.status, 502); assert.match(c2.j.error, /could not download Gitleaks.*404/);
  });
});

describe('pasted lists and .env files', () => {
  test('keyword list: masks on traffic, flagged secret, stored owner-only', async () => {
    const r = await (await post('/api/rules/import', { source: 'list', text: '# internal\nProject Falcon\nre:internal-[a-z]{4}-\\d+', mode: 'mask' })).json();
    assert.equal(r.added, 2);
    const out = await send('Project FALCON ships with internal-abcd-42');
    assert.ok(!/falcon|internal-abcd/i.test(out.sent));
    const rule = (await getRules()).find((x) => x.pattern === 'Project Falcon');
    assert.equal(rule.secret, true); assert.equal(rule.group, 'Custom lists');
    assert.equal(fs.statSync(path.join(tmp, 'rules.json')).mode & 0o777, 0o600);
  });
  test('.env: only secret-looking values become rules, and they are matched exactly', async () => {
    const env = 'PORT=3000\nDB_PASSWORD=Tr0ub4dor&3-xkcd\nNODE_ENV=production\nTOKEN=abcd1234efgh5678';
    const r = await (await post('/api/rules/import', { source: 'env', text: env, mode: 'mask' })).json();
    assert.equal(r.added, 2); assert.equal(r.skipped, 2);
    assert.ok(!(await send('pw=Tr0ub4dor&3-xkcd')).sent.includes('Tr0ub4dor'));
    // exact match, not whole-word: a longer string that contains the secret still has it masked
    assert.ok(!(await send('pw=Tr0ub4dor&3-xkcdX')).sent.includes('Tr0ub4dor&3-xkcd'));
    // a different value is untouched
    assert.ok((await send('pw=SomethingElse123')).sent.includes('SomethingElse123'));
  });
  test('events record the rule name, never the .env value', async () => {
    await send('pw=Tr0ub4dor&3-xkcd');
    const dump = JSON.stringify(await (await fetch(prompthole + '/api/events?limit=200')).json()) + fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8');
    assert.match(dump, /\.env DB_PASSWORD/);
    assert.ok(!dump.includes('Tr0ub4dor'));
  });
});

describe('saving rules', () => {
  test('invalid regex, duplicate ids and bad modes are rejected with a message and change nothing', async () => {
    const before = JSON.stringify(await getRules());
    const base = { id: 'zz', name: 'Z', type: 'regex', pattern: 'x', mode: 'log', enabled: true };
    const cases = [
      [[{ ...base, pattern: '([' }], /invalid regex/],
      [[base, base], /duplicate/],
      [[{ ...base, mode: 'nuke' }], /mode/],
    ];
    for (const [rules, re] of cases) {
      const r = await putRules(rules);
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, re);
    }
    assert.equal(JSON.stringify(await getRules()), before);
  });
});
