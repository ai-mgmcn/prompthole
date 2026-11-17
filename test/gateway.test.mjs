// Integration: real PromptHole process + mock upstream. No network, no LM Studio needed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = 'AKIAABCDEFGHIJKLMNOP';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop';

let mock, mockPort, prompthole, promptholePort, tmp, child;
let upstreamCalls = [];

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });

before(async () => {
  mock = http.createServer(async (req, res) => {
    const raw = await body(req);
    upstreamCalls.push({ url: req.url, headers: req.headers, raw });
    if (req.url === '/err') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"slow down"}'); }
    if (req.url === '/usage-anthropic') { // real numbers from a Claude Code run: 4 uncached + 1751 written to cache
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'message', usage: { input_tokens: 4, output_tokens: 85, cache_read_input_tokens: 0, cache_creation_input_tokens: 1751 } }));
    }
    let text = raw; try { text = JSON.parse(raw).messages[0].content; } catch {}
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const payload = `data: ${JSON.stringify({ text })}\n\ndata: ${JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`;
      for (let i = 0; i < payload.length; i += 5) { res.write(payload.slice(i, i + 5)); await new Promise((r) => setTimeout(r, 2)); }
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: text, usage: { prompt_tokens: 7, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } }));
  });
  mockPort = await listen(mock);

  // pick a free port for prompthole
  const probe = http.createServer(); promptholePort = await listen(probe); await new Promise((r) => probe.close(r));

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-test-'));
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ storeMatchedText: false })); // default is ON; most tests assert the privacy-preserving mode
  fs.writeFileSync(path.join(tmp, 'upstreams.json'), JSON.stringify([
    { id: 'mock', label: 'Mock', prefix: 'mock', url: `http://127.0.0.1:${mockPort}`, env: '', suffix: '', format: 'openai' },
    { id: 'mocka', label: 'MockA', prefix: 'mocka', url: `http://127.0.0.1:${mockPort}`, env: '', suffix: '', format: 'anthropic' },
    { id: 'dead', label: 'Dead', prefix: 'dead', url: 'http://127.0.0.1:1', env: '', suffix: '', format: 'openai' },
  ]));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(promptholePort), PROMPTHOLE_DATA: tmp }, stdio: 'ignore' });
  prompthole = `http://127.0.0.1:${promptholePort}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(prompthole + '/api/stats')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('prompthole did not start');
});
after(async () => { child?.kill(); mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (p, obj, headers = {}) => fetch(prompthole + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const chat = (content, extra = {}) => ({ model: 'm1', messages: [{ role: 'user', content }], ...extra });
const lastEvent = async () => (await (await fetch(prompthole + '/api/events?limit=1')).json())[0];

describe('gateway', () => {
  test('clean request passes through untouched with credentials and is recorded as allowed', async () => {
    upstreamCalls = [];
    const r = await post('/mock/v1/chat', chat('hello'), { authorization: 'Bearer sk-user-own-key', 'user-agent': 'claude-cli/2.0' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).echo, 'hello');
    assert.equal(upstreamCalls[0].url, '/v1/chat');
    assert.equal(upstreamCalls[0].headers.authorization, 'Bearer sk-user-own-key');
    const ev = await lastEvent();
    assert.equal(ev.action, 'allowed'); assert.equal(ev.tool, 'Claude Code'); assert.equal(ev.model, 'm1'); assert.equal(ev.provider, 'mock');
  });

  test('block: private key is rejected locally, upstream never contacted (openai format)', async () => {
    upstreamCalls = [];
    const r = await post('/mock/v1/chat', chat(PEM));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'prompthole_blocked');
    assert.equal(upstreamCalls.length, 0);
    assert.equal((await lastEvent()).action, 'blocked');
  });

  test('block: anthropic-style error for anthropic upstreams', async () => {
    const r = await post('/mocka/v1/messages', chat(PEM));
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.type, 'error'); assert.equal(j.error.type, 'invalid_request_error');
  });

  test('block: secret hidden in a nested tool_result structure is still caught', async () => {
    upstreamCalls = [];
    const r = await post('/mock/v1/chat', { model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: PEM }] }] }] });
    assert.equal(r.status, 400);
    assert.equal(upstreamCalls.length, 0);
  });

  test('mask: upstream only ever sees a placeholder (one-way, nothing is restored)', async () => {
    upstreamCalls = [];
    const r = await post('/mock/v1/chat', chat(`key=${AWS}`));
    const echo = (await r.json()).echo;
    assert.match(echo, /^key=\[PROMPTHOLE_AWSKEY_[0-9a-f]{6}\]$/, 'reply is passed through as-is, placeholder included');
    assert.ok(!upstreamCalls[0].raw.includes(AWS), 'secret must not reach upstream');
    assert.match(upstreamCalls[0].raw, /\[PROMPTHOLE_AWSKEY_[0-9a-f]{6}\]/);
    assert.equal((await lastEvent()).action, 'masked');
  });

  test('mask: streamed responses pass through untouched and the secret never reaches upstream', async () => {
    upstreamCalls = [];
    const r = await post('/mock/sse', chat(`key=${AWS} and "quoted"\nline2`));
    const txt = await r.text();
    assert.match(JSON.parse(txt.split('\n')[0].replace(/^data: /, '')).text, /^key=\[PROMPTHOLE_AWSKEY_[0-9a-f]{6}\] and "quoted"\nline2$/);
    assert.ok(!upstreamCalls[0].raw.includes(AWS));
  });

  test('custom keyword rules added via API take effect immediately', async () => {
    const rules = await (await fetch(prompthole + '/api/rules')).json();
    rules.push({ id: 'kw1', name: 'Codename', type: 'keyword', pattern: 'Project Falcon', mode: 'mask', enabled: true });
    assert.equal((await fetch(prompthole + '/api/rules', { method: 'PUT', body: JSON.stringify(rules) })).status, 200);
    upstreamCalls = [];
    const r = await post('/mock/v1/chat', chat('about project falcon launch'));
    assert.match((await r.json()).echo, /^about \[PROMPTHOLE_KW1_[0-9a-f]{6}\] launch$/);
    assert.ok(!/falcon/i.test(upstreamCalls[0].raw));
  });

  test('log: JWT is forwarded unchanged but recorded', async () => {
    upstreamCalls = [];
    await post('/mock/v1/chat', chat(`t ${JWT}`));
    assert.ok(upstreamCalls[0].raw.includes(JWT));
    const ev = await lastEvent();
    assert.equal(ev.action, 'logged'); assert.equal(ev.hits[0].name, 'JWT');
  });

  test('with "keep matched text" off, stored events and stats never contain the raw secret', async () => {
    const dump = JSON.stringify(await (await fetch(prompthole + '/api/events?limit=500')).json()) + fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8');
    for (const s of [AWS, 'MIIfake', JWT, 'sk-user-own-key']) assert.ok(!dump.includes(s), `leaked ${s.slice(0, 8)}`);
  });

  test('non-JSON bodies pass through untouched', async () => {
    upstreamCalls = [];
    await fetch(prompthole + '/mock/raw', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `plain ${AWS}` });
    assert.equal(upstreamCalls[0].raw, `plain ${AWS}`);
  });

  test('malformed JSON is forwarded rather than crashing the gateway', async () => {
    const r = await post('/mock/x', '{not json');
    assert.equal(r.status, 200);
  });

  test('upstream error status and body are passed through', async () => {
    const r = await post('/mock/err', chat('x'));
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, 'slow down');
    assert.equal((await lastEvent()).status, 429);
  });

  test('unreachable upstream yields 502 and is recorded', async () => {
    const r = await post('/dead/v1/chat', chat('x'));
    assert.equal(r.status, 502);
    assert.equal((await lastEvent()).status, 502);
  });

  test('unknown prefix is 404', async () => {
    assert.equal((await post('/nope/v1', chat('x'))).status, 404);
  });
});

describe('client identification', () => {
  test('stored event keeps safe headers but not credentials', async () => {
    await post('/mock/v1/chat', chat('hdr'), { authorization: 'Bearer sk-user-own-key', 'x-api-key': 'k123', 'anthropic-beta': 'b1', 'user-agent': 'claude-cli/2.0' });
    const ev = await lastEvent();
    assert.equal(ev.headers['anthropic-beta'], 'b1');
    assert.equal(ev.headers['user-agent'], 'claude-cli/2.0');
    assert.ok(!('authorization' in ev.headers) && !('x-api-key' in ev.headers));
  });
  test('custom client rule (any header) is applied immediately', async () => {
    const cur = await (await fetch(prompthole + '/api/clients')).json();
    const put = await fetch(prompthole + '/api/clients', { method: 'PUT', body: JSON.stringify([{ name: 'My Script', header: 'x-app', pattern: '^myscript$', enabled: true }, ...cur]) });
    assert.equal(put.status, 200);
    await post('/mock/v1/chat', chat('who'), { 'x-app': 'myscript', 'user-agent': 'claude-cli/2.0' });
    assert.equal((await lastEvent()).tool, 'My Script');
  });
  test('invalid client rules are rejected', async () => {
    assert.equal((await fetch(prompthole + '/api/clients', { method: 'PUT', body: JSON.stringify([{ name: 'x', header: 'user-agent', pattern: '([' }]) })).status, 400);
    assert.equal((await fetch(prompthole + '/api/clients', { method: 'PUT', headers: { origin: 'https://evil.example.com' }, body: '[]' })).status, 403);
  });
});

describe('dashboard api', () => {
  test('stats aggregates actions, tools and rules', async () => {
    const s = await (await fetch(prompthole + '/api/stats')).json();
    assert.ok(s.total >= 5);
    assert.ok(s.actions.blocked >= 1 && s.actions.masked >= 1);
    assert.ok(s.rules['Private key'] >= 1);
    assert.equal(s.series.length, 60);
  });

  test('rule tester endpoint reports hits without sending anything', async () => {
    upstreamCalls = [];
    const r = await (await post('/api/test', { text: `x ${AWS}` })).json();
    assert.equal(r.hits[0].id, 'aws-key');
    assert.ok(!r.output.includes(AWS));
    assert.equal(upstreamCalls.length, 0);
  });

  test('rejects requests whose Host header is not loopback (DNS-rebinding guard)', async () => {
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: promptholePort, path: '/api/stats', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(status, 403);
  });

  test('rejects rule changes from a foreign Origin', async () => {
    const r = await fetch(prompthole + '/api/rules', { method: 'PUT', headers: { origin: 'https://evil.example.com' }, body: '[]' });
    assert.equal(r.status, 403);
  });

  test('rejects malformed rules payloads and keeps existing rules', async () => {
    const before = await (await fetch(prompthole + '/api/rules')).json();
    assert.equal((await fetch(prompthole + '/api/rules', { method: 'PUT', body: '{"a":1}' })).status, 400);
    assert.deepEqual(await (await fetch(prompthole + '/api/rules')).json(), before);
  });

  test('upstreams: invalid config is rejected and the old one stays active', async () => {
    const bad = await fetch(prompthole + '/api/upstreams', { method: 'PUT', body: JSON.stringify([{ prefix: 'A/B', url: 'https://e.com' }]) });
    assert.equal(bad.status, 400);
    assert.equal((await post('/mock/v1/chat', chat('still works'))).status, 200);
  });

  test('upstreams: a newly added upstream is routable immediately and persisted', async () => {
    const cur = await (await fetch(prompthole + '/api/upstreams')).json();
    cur.push({ label: 'New', prefix: 'fresh', url: `http://127.0.0.1:${mockPort}/`, env: 'FRESH_URL', suffix: '/v1', format: 'openai' });
    const put = await fetch(prompthole + '/api/upstreams', { method: 'PUT', body: JSON.stringify(cur) });
    assert.equal(put.status, 200);
    assert.equal((await (await post('/fresh/v1/chat', chat('hi'))).json()).echo, 'hi');
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'upstreams.json'), 'utf8'));
    assert.ok(saved.some((u) => u.prefix === 'fresh' && u.url === `http://127.0.0.1:${mockPort}`), 'trailing slash trimmed');
  });

  test('upstreams: removing one makes its route 404', async () => {
    const cur = (await (await fetch(prompthole + '/api/upstreams')).json()).filter((u) => u.prefix !== 'fresh');
    await fetch(prompthole + '/api/upstreams', { method: 'PUT', body: JSON.stringify(cur) });
    assert.equal((await post('/fresh/v1/chat', chat('hi'))).status, 404);
  });
});

describe('dashboard page and unknown routes', () => {
  test('serves the dashboard html on loopback', async () => {
    const r = await fetch(prompthole + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(await r.text(), /<title>PromptHole<\/title>/);
  });
  test('does not serve the dashboard to a non-loopback Host header', async () => {
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: promptholePort, path: '/', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(status, 404);
  });
  test('unknown /api path is 404 json', async () => {
    const r = await fetch(prompthole + '/api/nope');
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'not found');
  });
});

describe('persistence', () => {
  test('history survives a restart, and corrupt lines are skipped instead of crashing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-persist-'));
    const ev = (id) => JSON.stringify({ id, ts: Date.now(), tool: 'T', provider: 'p', path: '/x', model: null, action: 'allowed', hits: [], bytes: 1, status: 200, ms: 1 });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [ev('a'), '{broken json', ev('b'), ''].join('\n'));
    const probe = http.createServer(); const port = await listen(probe); await new Promise((r) => probe.close(r));
    const c = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(port), PROMPTHOLE_DATA: dir }, stdio: 'ignore' });
    try {
      let list;
      for (let i = 0; i < 50 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/api/events?limit=10`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
      assert.deepEqual(list.map((e) => e.id).sort(), ['a', 'b']);
      // defaults are written on first start
      for (const f of ['rules.json', 'upstreams.json', 'clients.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    } finally { c.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('matched text logging (opt-in)', () => {
  const setKeep = (v) => fetch(prompthole + '/api/settings', { method: 'PUT', body: JSON.stringify({ storeMatchedText: v }) });
  const hitsOf = async () => (await lastEvent()).hits;

  test('settings: defaults to what the file says, rejects bad payloads and foreign origins', async () => {
    assert.equal((await (await fetch(prompthole + '/api/settings')).json()).storeMatchedText, false);
    assert.equal((await fetch(prompthole + '/api/settings', { method: 'PUT', body: '{"storeMatchedText":"yes"}' })).status, 400);
    assert.equal((await fetch(prompthole + '/api/settings', { method: 'PUT', body: 'nope' })).status, 400);
    assert.equal((await fetch(prompthole + '/api/settings', { method: 'PUT', headers: { origin: 'https://evil.example.com' }, body: '{"storeMatchedText":true}' })).status, 403);
    assert.equal((await fetch(prompthole + '/api/settings/purge', { method: 'POST', headers: { origin: 'https://evil.example.com' } })).status, 403);
  });

  test('off: new events carry only the masked sample', async () => {
    await post('/mock/v1/chat', chat(`off ${AWS}`));
    const [h] = await hitsOf();
    assert.equal(h.matches, undefined);
    assert.ok(!JSON.stringify(h).includes(AWS));
  });

  test('on: the exact matched text and its context are logged, upstream still never sees it', async () => {
    const put = await setKeep(true);
    assert.equal(put.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')).storeMatchedText, true);
    upstreamCalls = [];
    await post('/mock/v1/chat', chat(`before the leak ${AWS} after the leak`));
    const [h] = await hitsOf();
    assert.equal(h.matches[0].text, AWS);
    assert.match(h.matches[0].context, /the leak ⟦AKIAABCDEFGHIJKLMNOP⟧ after the/);
    assert.ok(!h.sample.includes(AWS), 'the table sample stays masked');
    assert.ok(!upstreamCalls[0].raw.includes(AWS), 'secret still never reaches the upstream');
    assert.ok(fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8').includes(AWS), 'persisted to the local log');
  });

  test('on: blocked requests keep the offending text too', async () => {
    await post('/mock/v1/chat', chat(PEM));
    const [h] = await hitsOf();
    assert.ok(h.matches[0].text.includes('MIIfake'));
  });

  test('on: duplicate matches are stored once, and the list is capped', async () => {
    await post('/mock/v1/chat', chat(`${AWS} ${AWS}`));
    assert.equal((await hitsOf())[0].matches.length, 1);
    assert.equal((await hitsOf())[0].count, 2);
    const many = Array.from({ length: 15 }, (_, i) => `AKIA${String(i).padStart(16, 'A')}`).join(' ');
    await post('/mock/v1/chat', chat(many));
    const [h] = await hitsOf();
    assert.equal(h.count, 15);
    assert.equal(h.matches.length, 10);
  });

  test('on: the log file is owner-readable only', () => {
    assert.equal(fs.statSync(path.join(tmp, 'events.jsonl')).mode & 0o777, 0o600);
  });

  test('purge removes stored text from memory and disk but keeps the counts', async () => {
    const before = await (await fetch(prompthole + '/api/stats')).json();
    const r = await (await fetch(prompthole + '/api/settings/purge', { method: 'POST' })).json();
    assert.ok(r.purged >= 4);
    const all = JSON.stringify(await (await fetch(prompthole + '/api/events?limit=500')).json());
    assert.ok(!all.includes(AWS) && !all.includes('MIIfake'));
    assert.ok(!fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8').includes(AWS));
    const after = await (await fetch(prompthole + '/api/stats')).json();
    assert.deepEqual(after.actions, before.actions);
    assert.deepEqual(after.rules, before.rules);
  });

  test('turning it off again stops storing text for new requests', async () => {
    await setKeep(false);
    await post('/mock/v1/chat', chat(`again ${AWS}`));
    assert.equal((await hitsOf())[0].matches, undefined);
  });
});

describe('token statistics', () => {
  test('non-streaming: tokens come from the provider response and are stored on the event', async () => {
    await post('/mock/v1/chat', chat('count me'), { 'user-agent': 'claude-cli/2.0' });
    const ev = await lastEvent();
    assert.deepEqual(ev.tokens, { in: 7, out: 3, cacheRead: 0, cacheWrite: 0, reasoning: 2 });
  });
  test('streaming: usage in the last SSE event is captured while the client still gets every byte', async () => {
    const r = await post('/mock/sse', chat('stream me'));
    const txt = await r.text();
    assert.match(txt, /data: \[DONE\]/);
    const ev = await lastEvent();
    assert.equal(ev.tokens.in, 11); assert.equal(ev.tokens.out, 4);
  });
  test('requests that never reach a model (blocked) or fail upstream have no tokens', async () => {
    await post('/mock/v1/chat', chat(PEM));
    assert.equal((await lastEvent()).tokens, undefined);
    await post('/mock/err', chat('x'));
    assert.equal((await lastEvent()).tokens, undefined);
  });
  test('stats aggregate tokens overall, by model and by tool', async () => {
    const before = (await (await fetch(prompthole + '/api/stats')).json()).tokens;
    await post('/mock/v1/chat', chat('a'), { 'user-agent': 'codex_cli_rs/1' });
    const s = await (await fetch(prompthole + '/api/stats')).json();
    assert.equal(s.tokens.in - before.in, 7);
    assert.equal(s.tokens.out - before.out, 3);
    assert.equal(s.tokens.reasoning - before.reasoning, 2);
    assert.ok(s.tokensByModel.m1 >= 20);
    assert.ok(s.tokensByTool['Codex CLI'] >= 10);
  });
});

describe('token statistics with prompt caching', () => {
  test('stats sum the full input and the cached parts separately', async () => {
    const before = (await (await fetch(prompthole + '/api/stats')).json()).tokens;
    // the mock echoes this usage block back (see the /usage route in the upstream mock)
    await post('/mock/usage-anthropic', chat('cache me'));
    const ev = await lastEvent();
    assert.deepEqual(ev.tokens, { in: 1755, out: 85, cacheRead: 0, cacheWrite: 1751, reasoning: 0 });
    const after = (await (await fetch(prompthole + '/api/stats')).json()).tokens;
    assert.equal(after.in - before.in, 1755);
    assert.equal(after.cacheWrite - before.cacheWrite, 1751);
  });
});
