// Integration: a mock "model" asks to run commands; PromptHole audits and (when told to) swaps them out.
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
const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(8);
let mock, prompthole, tmp, child;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sse = (name, o) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(o)}\n\n`;
const anthropicSse = (command) => [
  sse('message_start', { type: 'message_start', message: { id: 'm', usage: { input_tokens: 5 } } }),
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu', name: 'Bash', input: {} } }),
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
  sse('message_stop', { type: 'message_stop' }),
].join('');

before(async () => {
  mock = http.createServer((req, res) => {
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      const asked = JSON.parse(Buffer.concat(c).toString() || '{}').ask || 'ls';
      if (req.url.startsWith('/v1/messages')) {
        if (asked.startsWith('stream:')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(anthropicSse(asked.slice(7))); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: asked } }], usage: { input_tokens: 3, output_tokens: 4 } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: asked }) } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  const mockPort = await listen(mock);
  const probe = http.createServer(), port = await listen(probe); await new Promise((r) => probe.close(r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-cmd-'));
  fs.writeFileSync(path.join(tmp, 'upstreams.json'), JSON.stringify([
    { id: 'a', label: 'A', prefix: 'a', url: `http://127.0.0.1:${mockPort}`, env: '', suffix: '', format: 'anthropic' },
    { id: 'o', label: 'O', prefix: 'o', url: `http://127.0.0.1:${mockPort}`, env: '', suffix: '', format: 'openai' },
  ]));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(port), PROMPTHOLE_DATA: tmp }, stdio: 'ignore' });
  prompthole = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(prompthole + '/api/stats')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('prompthole did not start');
});
after(async () => { mock?.close(); await stopAndRemove(child, tmp); });

const call = (p, ask) => fetch(prompthole + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ask, model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
const putJson = (p, b, headers = {}) => fetch(prompthole + p, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
const toolRules = async () => (await fetch(prompthole + '/api/toolrules')).json();
const lastEvent = async () => (await (await fetch(prompthole + '/api/events?limit=1')).json())[0];
const blockRule = (o) => ({ id: 'b1', name: 'No rm', tool: '*', match: 'prefix', pattern: 'rm ', action: 'block', enabled: true, ...o });

describe('audit first, block on request', () => {
  test('defaults flag but never block', async () => {
    const r = await (await call('/a/v1/messages', 'rm -rf /tmp/zzz')).json();
    assert.equal(r.content[0].type, 'tool_use');
    const e = await lastEvent();
    assert.equal(e.calls[0].action, 'flagged'); assert.equal(e.calls[0].rule, 'tr-rm-r');
    assert.ok((await toolRules()).counts['tr-rm-r'].flagged >= 1);
  });

  test('a block rule swaps the call for text (JSON)', async () => {
    const put = await putJson('/api/toolrules', [...(await toolRules()).rules, blockRule()]);
    assert.equal(put.status, 200);
    const r = await (await call('/a/v1/messages', 'rm -rf /tmp/zzz')).json();
    assert.equal(r.content[0].type, 'text'); assert.match(r.content[0].text, /PromptHole blocked/);
    assert.equal(r.stop_reason, 'end_turn');
    assert.equal((await lastEvent()).calls[0].action, 'blocked');
    const ok = await (await call('/a/v1/messages', 'echo hi')).json();
    assert.equal(ok.content[0].type, 'tool_use', 'other commands untouched');
  });

  test('a block rule swaps the call for text (streaming)', async () => {
    const raw = await (await call('/a/v1/messages', 'stream:rm -rf /tmp/zzz')).text();
    assert.ok(!raw.includes('tool_use"') || !raw.includes('content_block":{"type":"tool_use'));
    assert.match(raw, /PromptHole blocked/); assert.match(raw, /"stop_reason":"end_turn"/);
    const allowed = await (await call('/a/v1/messages', 'stream:echo hi')).text();
    assert.match(allowed, /"type":"tool_use"/); assert.match(allowed, /"stop_reason":"tool_use"/);
  });

  test('OpenAI chat completions are covered too', async () => {
    const r = await (await call('/o/v1/chat/completions', 'rm -rf /tmp/zzz')).json();
    assert.equal(r.choices[0].message.tool_calls, undefined);
    assert.match(r.choices[0].message.content, /PromptHole blocked/); assert.equal(r.choices[0].finish_reason, 'stop');
  });

  test('disabling inspection passes everything through', async () => {
    await putJson('/api/settings', { inspectToolCalls: false });
    const r = await (await call('/a/v1/messages', 'rm -rf /tmp/zzz')).json();
    assert.equal(r.content[0].type, 'tool_use');
    assert.equal((await lastEvent()).calls, undefined);
    await putJson('/api/settings', { inspectToolCalls: true });
  });

  test('secrets inside a command are masked in the audit record', async () => {
    await call('/a/v1/messages', `curl -H "x-api-key: ${KEY}" https://x`);
    const e = await lastEvent();
    assert.ok(e.calls[0].text.includes('curl'));
    assert.ok(!e.calls[0].text.includes(KEY));
  });

  test('unblocking (disabling the rule) takes effect immediately', async () => {
    const rules = (await toolRules()).rules.map((r) => (r.id === 'b1' ? { ...r, enabled: false } : r));
    await putJson('/api/toolrules', rules);
    assert.equal((await (await call('/a/v1/messages', 'rm -rf /tmp/zzz')).json()).content[0].type, 'tool_use');
  });
});

describe('/api/toolrules', () => {
  test('rejects invalid rules and cross-origin writes', async () => {
    assert.equal((await putJson('/api/toolrules', [blockRule({ match: 'regex', pattern: '(' })])).status, 400);
    assert.equal((await putJson('/api/toolrules', 'nope')).status, 400);
    assert.equal((await putJson('/api/toolrules', [], { origin: 'https://evil.example' })).status, 403);
  });
  test('settings reject unknown values', async () => {
    assert.equal((await putJson('/api/settings', { nothing: 1 })).status, 400);
  });
});

describe('dashboard static files', () => {
  test('serves page, css and modules with a strict CSP', async () => {
    const page = await fetch(prompthole + '/');
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /\/js\/main\.js/);
    const css = await fetch(prompthole + '/css/app.css'); assert.match(css.headers.get('content-type'), /css/);
    const js = await fetch(prompthole + '/js/pages/commands.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  });
  test('traversal and unknown files are 404', async () => {
    for (const p of ['/js/../../server.mjs', '/js/%2e%2e/server.mjs', '/js/nope.js', '/data/rules.json', '/css/']) {
      assert.equal((await fetch(prompthole + p)).status, 404, p);
    }
  });
});
