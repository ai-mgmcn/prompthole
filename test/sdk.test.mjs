// Real vendor SDKs -> PromptHole -> mock upstream speaking each vendor's wire format.
// Verifies the SDKs actually work through the gateway (parsing, streaming, errors) and that secrets are handled.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = 'AKIAABCDEFGHIJKLMNOP';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----';

let mock, mockPort, prompthole, promptholePort, tmp, child;
let calls = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// write SSE in tiny pieces so network chunk boundaries land inside events
async function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const payload = events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('');
  for (let i = 0; i < payload.length; i += 6) { res.write(payload.slice(i, i + 6)); await sleep(1); }
  res.end();
}
const userText = (u, b) => {
  if (u.includes('/v1/messages')) { const c = b.messages[0].content; return typeof c === 'string' ? c : c.map((x) => x.text || '').join(''); }
  if (u.includes('/chat/completions')) return b.messages[0].content;
  if (u.includes('/v1/responses')) return b.input;
  return b.contents[0].parts[0].text; // gemini
};

before(async () => {
  mock = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let b = {}; try { b = JSON.parse(raw); } catch {}
    calls.push({ url: req.url, headers: req.headers, raw });
    if (req.headers['x-mock-error']) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' }, })); }
    const text = userText(req.url, b);
    const parts = [text];
    if (req.url.includes('/v1/messages')) {
      if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }
      return sse(res, [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        ...parts.map((t) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } })),
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]);
    }
    if (req.url.includes('/chat/completions')) {
      if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
      const chunk = (delta, fr = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: b.model, choices: [{ index: 0, delta, finish_reason: fr }] });
      return sse(res, [...parts.map((t, i) => ({ data: chunk(i ? { content: t } : { role: 'assistant', content: t }) })), { data: chunk({}, 'stop') }, { data: '[DONE]' }]);
    }
    if (req.url.includes('/v1/responses')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'r1', object: 'response', created_at: 1, status: 'completed', model: b.model, output: [{ id: 'o1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    }
    // gemini
    const cand = (t) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP', index: 0 }] });
    if (req.url.includes(':streamGenerateContent')) return sse(res, parts.map((t) => ({ data: cand(t) })));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(cand(text)));
  });
  mockPort = await listen(mock);
  const probe = http.createServer(); promptholePort = await listen(probe); await new Promise((r) => probe.close(r));

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompthole-sdk-'));
  const up = (prefix, format) => ({ id: prefix, label: prefix, prefix, url: `http://127.0.0.1:${mockPort}`, env: '', suffix: '', format });
  fs.writeFileSync(path.join(tmp, 'upstreams.json'), JSON.stringify([up('anthropic', 'anthropic'), up('openai', 'openai'), up('gemini', 'gemini')]));
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(promptholePort), PROMPTHOLE_DATA: tmp }, stdio: 'ignore' });
  prompthole = `http://127.0.0.1:${promptholePort}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(prompthole + '/api/stats')).ok) return; } catch {} await sleep(100); }
  throw new Error('prompthole did not start');
});
after(async () => { child?.kill('SIGTERM'); await sleep(300); mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// event is recorded when the response closes, which can trail the SDK's resolution slightly
async function lastEvent(provider) {
  for (let i = 0; i < 30; i++) {
    const ev = (await (await fetch(prompthole + '/api/events?limit=20')).json()).find((e) => e.provider === provider);
    if (ev && ev.ts >= lastEvent.since) return ev;
    await sleep(50);
  }
  throw new Error('no event for ' + provider);
}
const begin = () => { calls = []; lastEvent.since = Date.now(); };
const anthropic = () => new Anthropic({ apiKey: 'sk-ant-test-key', baseURL: `${prompthole}/anthropic`, maxRetries: 0 });
const openai = () => new OpenAI({ apiKey: 'sk-openai-test-key', baseURL: `${prompthole}/openai/v1`, maxRetries: 0 });
const gemini = () => new GoogleGenAI({ apiKey: 'AIza-test-key', httpOptions: { baseUrl: `${prompthole}/gemini` } });
const masked = (t) => !t.includes(AWS) && /\[PROMPTHOLE_AWSKEY_[0-9a-f]{6}\]/.test(t);
const sawSecretUpstream = () => calls.some((c) => c.raw.includes(AWS));

describe('Anthropic SDK', () => {
  const msg = (content, extra = {}) => ({ model: 'claude-test', max_tokens: 50, messages: [{ role: 'user', content }], ...extra });

  test('clean request: parsed by the SDK, identified, credentials forwarded', async () => {
    begin();
    const r = await anthropic().messages.create(msg('hello'));
    assert.equal(r.content[0].text, 'hello');
    assert.equal(calls[0].headers.authorization, 'Bearer sk-ant-test-key'); // this SDK version authenticates with a bearer header
    const ev = await lastEvent('anthropic');
    assert.equal(ev.tool, 'Anthropic SDK'); assert.equal(ev.model, 'claude-test'); assert.equal(ev.action, 'allowed');
    assert.equal(ev.tokens.in, 1); assert.equal(ev.tokens.out, 1);
    assert.ok(!JSON.stringify(ev).includes('sk-ant-test-key'), 'api key must not be stored');
  });
  test('mask: upstream never sees the secret; the reply is passed through unmodified', async () => {
    begin();
    const r = await anthropic().messages.create(msg(`key=${AWS}`));
    assert.ok(masked(r.content[0].text));
    assert.ok(!sawSecretUpstream());
    assert.equal((await lastEvent('anthropic')).action, 'masked');
  });
  test('mask: streaming through the SDK works and the secret never reaches upstream', async () => {
    begin();
    let out = '';
    const stream = await anthropic().messages.create(msg(`key=${AWS}`, { stream: true }));
    for await (const e of stream) if (e.type === 'content_block_delta') out += e.delta.text;
    assert.ok(masked(out));
    assert.ok(!sawSecretUpstream());
    const ev = await lastEvent('anthropic'); // input from message_start, cumulative output from message_delta
    assert.equal(ev.tokens.in, 1); assert.equal(ev.tokens.out, 5);
  });
  test('mask: system prompt and nested tool_result blocks are scanned too', async () => {
    begin();
    await anthropic().messages.create({ model: 'claude-test', max_tokens: 50, system: `internal ${AWS}`, messages: [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: `echo ${AWS}` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: `out ${AWS}` }] }] },
    ] });
    assert.ok(!sawSecretUpstream());
  });
  test('block: SDK raises BadRequestError with Anthropic-shaped error, upstream not contacted', async () => {
    begin();
    await assert.rejects(anthropic().messages.create(msg(PEM)), (e) => {
      assert.ok(e instanceof Anthropic.BadRequestError);
      assert.equal(e.status, 400);
      assert.match(e.message, /Blocked by PromptHole/);
      return true;
    });
    assert.equal(calls.length, 0);
    assert.equal((await lastEvent('anthropic')).action, 'blocked');
  });
  test('upstream 429 surfaces as RateLimitError (errors pass through)', async () => {
    begin();
    await assert.rejects(anthropic().messages.create(msg('x'), { headers: { 'x-mock-error': '1' } }), (e) => e instanceof Anthropic.RateLimitError);
  });
});

describe('OpenAI SDK', () => {
  const chat = (content, extra = {}) => ({ model: 'gpt-test', messages: [{ role: 'user', content }], ...extra });

  test('chat: clean request parsed, identified, bearer forwarded', async () => {
    begin();
    const r = await openai().chat.completions.create(chat('hello'));
    assert.equal(r.choices[0].message.content, 'hello');
    assert.equal(calls[0].headers.authorization, 'Bearer sk-openai-test-key');
    assert.equal(calls[0].url, '/v1/chat/completions');
    const ev = await lastEvent('openai');
    assert.equal(ev.tool, 'OpenAI SDK'); assert.equal(ev.model, 'gpt-test');
    assert.equal(ev.tokens.in, 1); assert.equal(ev.tokens.out, 1);
    assert.ok(!JSON.stringify(ev).includes('sk-openai-test-key'));
  });
  test('chat: mask', async () => {
    begin();
    const r = await openai().chat.completions.create(chat(`key=${AWS}`));
    assert.ok(masked(r.choices[0].message.content));
    assert.ok(!sawSecretUpstream());
  });
  test('chat: streaming via SDK works and secret never reaches upstream', async () => {
    begin();
    let out = '';
    const stream = await openai().chat.completions.create(chat(`key=${AWS}`, { stream: true }));
    for await (const c of stream) out += c.choices[0]?.delta?.content ?? '';
    assert.ok(masked(out));
    assert.ok(!sawSecretUpstream());
  });
  test('responses API: mask', async () => {
    begin();
    const r = await openai().responses.create({ model: 'gpt-test', input: `key=${AWS}` });
    assert.ok(masked(r.output_text));
    assert.ok(!sawSecretUpstream());
  });
  test('chat: block raises BadRequestError with prompthole_blocked code', async () => {
    begin();
    await assert.rejects(openai().chat.completions.create(chat(PEM)), (e) => {
      assert.ok(e instanceof OpenAI.BadRequestError);
      assert.equal(e.code, 'prompthole_blocked');
      return true;
    });
    assert.equal(calls.length, 0);
  });
  test('chat: tool-call arguments and multi-part content are scanned', async () => {
    begin();
    await openai().chat.completions.create({ model: 'gpt-test', messages: [
      { role: 'user', content: [{ type: 'text', text: `part ${AWS}` }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: JSON.stringify({ k: AWS }) } }] },
      { role: 'tool', tool_call_id: 't1', content: `result ${AWS}` },
    ] }).catch(() => {}); // mock reads messages[0] only; we only care what was sent
    assert.ok(!sawSecretUpstream());
  });
});

describe('Google GenAI SDK', () => {
  test('generateContent: clean request parsed, identified, key header forwarded but not stored', async () => {
    begin();
    const r = await gemini().models.generateContent({ model: 'gemini-test', contents: 'hello' });
    assert.equal(r.text, 'hello');
    assert.equal(calls[0].headers['x-goog-api-key'], 'AIza-test-key');
    assert.match(calls[0].url, /\/models\/gemini-test:generateContent/);
    const ev = await lastEvent('gemini');
    assert.equal(ev.tool, 'Google GenAI SDK');
    assert.ok(!JSON.stringify(ev).includes('AIza-test-key'));
  });
  test('mask', async () => {
    begin();
    const r = await gemini().models.generateContent({ model: 'gemini-test', contents: `key=${AWS}` });
    assert.ok(masked(r.text));
    assert.ok(!sawSecretUpstream());
  });
  test('streaming: generateContentStream works and secret never reaches upstream', async () => {
    begin();
    let out = '';
    for await (const c of await gemini().models.generateContentStream({ model: 'gemini-test', contents: `key=${AWS}` })) out += c.text ?? '';
    assert.ok(masked(out));
    assert.ok(!sawSecretUpstream());
  });
  test('block: SDK raises ApiError 400 with the PromptHole message', async () => {
    begin();
    await assert.rejects(gemini().models.generateContent({ model: 'gemini-test', contents: PEM }), (e) => {
      assert.equal(e.status, 400);
      assert.match(String(e.message), /Blocked by PromptHole/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});
