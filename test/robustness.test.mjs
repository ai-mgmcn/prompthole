// Failure modes: the gateway must survive broken upstreams, vanished clients and runaway input.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBody, HttpError } from '../src/http.mjs';
import { EventLog } from '../src/store.mjs';
import { createAnthropicSseFilter, makeDecider } from '../lib/toolcalls.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let mock, prompthole, tmp, child, closedByClient = 0;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  mock = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/die') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"x":1}\n\n'); setTimeout(() => res.socket.destroy(), 30); return; }
    if (req.url === '/die-json') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' }); res.write('{"choices":'); setTimeout(() => res.socket.destroy(), 30); return; }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/event-stream' }); const t = setInterval(() => res.write('data: {}\n\n'), 20); res.on('close', () => { clearInterval(t); closedByClient++; }); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const mp = await listen(mock);
  const probe = http.createServer(), port = await listen(probe); await new Promise((r) => probe.close(r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-rb-'));
  fs.writeFileSync(path.join(tmp, 'upstreams.json'), JSON.stringify([{ id: 'm', label: 'M', prefix: 'm', url: `http://127.0.0.1:${mp}`, env: '', suffix: '', format: 'openai' }]));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(port), PROMPTHOLE_DATA: tmp }, stdio: 'ignore' });
  prompthole = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(prompthole + '/api/stats')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('prompthole did not start');
});
after(() => { child?.kill(); mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const alive = async () => assert.equal((await fetch(prompthole + '/api/stats')).status, 200);

describe('upstream failures', () => {
  test('upstream dying mid-stream does not crash PromptHole', async () => {
    await fetch(prompthole + '/m/die', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => r.text()).catch(() => {});
    await alive();
  });
  test('upstream dying mid-JSON (rewrite path) does not crash PromptHole', async () => {
    await fetch(prompthole + '/m/v1/chat/completions/die-json', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => r.text()).catch(() => {});
    await alive();
  });
  test('client disconnecting stops the upstream read', async () => {
    const port = new URL(prompthole).port;
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('POST /m/slow HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\ncontent-type: application/json\r\n\r\n{}'));
      s.once('data', () => { s.destroy(); resolve(); });
    });
    for (let i = 0; i < 50 && !closedByClient; i++) await new Promise((r) => setTimeout(r, 40));
    assert.equal(closedByClient, 1, 'upstream connection was released');
    await alive();
  });
});

describe('runaway input', () => {
  test('readBody enforces its limit', async () => {
    await assert.rejects(readBody(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15), (e) => e instanceof HttpError && e.status === 413);
    assert.equal((await readBody(Readable.from([Buffer.alloc(5)]), 15)).length, 5);
  });
  test('a held tool call larger than the cap is released untouched', () => {
    const f = createAnthropicSseFilter(makeDecider([{ id: 'b', name: 'b', tool: '*', match: 'contains', pattern: 'x', action: 'block', enabled: true }]));
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
    let out = f.write(ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } }));
    assert.equal(out, '');
    const chunk = ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'x'.repeat(2_000_000) } });
    for (let i = 0; i < 5; i++) out += f.write(chunk);
    out += f.write(ev({ type: 'content_block_stop', index: 0 })) + f.flush();
    assert.ok(out.includes('"tool_use"') && out.includes('content_block_stop'), 'forwarded, not buffered forever');
    assert.equal(f.blocked, 0);
  });
  test('an SSE stream with no event terminator is forwarded, not buffered forever', () => {
    const f = createAnthropicSseFilter(() => ({ action: 'allow', record: {} }));
    let out = ''; for (let i = 0; i < 10; i++) out += f.write('x'.repeat(1_000_000));
    assert.ok(out.length >= 8_000_000);
  });
});

describe('event log', () => {
  test('file is compacted so it cannot grow without bound; corrupt lines are skipped', () => {
    const file = path.join(tmp, 'ev.jsonl');
    fs.writeFileSync(file, '{"id":1,"hits":[]}\nnot json\n{"id":2,"hits":[]}\n');
    const log = new EventLog(file, 3);
    assert.deepEqual(log.list.map((e) => e.id), [1, 2]);
    for (let i = 3; i < 20; i++) log.record({ id: i, hits: [] });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length <= 7, `file has ${lines.length} lines`);
    assert.equal(JSON.parse(lines.at(-1)).id, 19);
    assert.deepEqual(log.list.map((e) => e.id), [17, 18, 19]);
  });
  test('recording never throws when the disk is unwritable', () => {
    const log = new EventLog(path.join(tmp, 'no-such-dir', 'x.jsonl'), 3);
    assert.doesNotThrow(() => log.record({ id: 1, hits: [] }));
  });
});

describe('review fixes', () => {
  const put = (p, b) => fetch(prompthole + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const up = (prefix) => ({ id: prefix, label: prefix, prefix, url: 'http://127.0.0.1:9', env: '', suffix: '', format: 'openai' });
  test('upstream prefixes that would shadow the dashboard are rejected', async () => {
    for (const p of ['api', 'js', 'css', 'icons']) assert.equal((await put('/api/upstreams', [up(p)])).status, 400, p);
  });
  test('malformed URLs are a 404, not a 500', async () => {
    assert.equal((await fetch(prompthole + '/%')).status, 404);
    assert.equal((await fetch(prompthole + '/js/%E0%A4%A')).status, 404);
  });
  test('chunked uploads (transfer-encoding) are proxied', async () => {
    const r = await fetch(prompthole + '/m/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Readable.from(['{"messages":', '[]}']), duplex: 'half' });
    assert.equal(r.status, 200);
  });
  test('a corrupt data file gives a clear startup error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-bad-'));
    fs.writeFileSync(path.join(dir, 'rules.json'), '{oops');
    const { createStore } = await import('../src/store.mjs');
    assert.throws(() => createStore({ dataDir: dir, root: ROOT }), /cannot read .*rules\.json/);
    fs.rmSync(dir, { recursive: true });
  });
});
