import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compile, scanValue, identify, blockedBody, validUpstreams, placeholderFor, DEFAULT_CLIENTS, validClients, safeHeaders } from '../lib/core.mjs';

const R = (o) => ({ id: 'r1', name: 'Rule', type: 'regex', pattern: 'x', mode: 'mask', enabled: true, ...o });
const AWS = 'AKIAABCDEFGHIJKLMNOP';

describe('compile', () => {
  test('keyword is literal and case-insensitive', () => {
    const re = compile(R({ type: 'keyword', pattern: 'a.b(c)' }));
    assert.ok(re.test('xx A.B(C) yy'));
    re.lastIndex = 0;
    assert.ok(!re.test('aXb(c)'), 'dot must not act as wildcard');
  });
  test('invalid regex returns null instead of throwing', () => {
    assert.equal(compile(R({ pattern: '([' })), null);
  });
});

describe('scanValue', () => {
  test('mask replaces secret with a deterministic placeholder', () => {
    const rules = [R({ id: 'aws', pattern: 'AKIA[0-9A-Z]{16}' })];
    const a = scanValue(rules, `k=${AWS}`);
    const b = scanValue(rules, `again ${AWS}`);
    assert.equal(a.blocked, false);
    assert.ok(!a.value.includes(AWS));
    const ph = placeholderFor(rules[0], AWS);
    assert.equal(a.value, `k=${ph}`);
    assert.ok(b.value.includes(ph), 'same secret -> same placeholder (keeps prompt cache stable)');
    assert.ok(!('restore' in a), 'masking is one-way');
  });
  test('different secrets get different placeholders', () => {
    const rules = [R({ id: 'aws', pattern: 'AKIA[0-9A-Z]{16}' })];
    const r = scanValue(rules, `${AWS} AKIAZZZZZZZZZZZZZZZZ`);
    const found = r.value.match(/\[PROMPTHOLE_AWS_[0-9a-f]{6}\]/g);
    assert.equal(new Set(found).size, 2);
  });
  test('block sets blocked and leaves text untouched', () => {
    const r = scanValue([R({ mode: 'block', pattern: 'secret' })], 'my secret');
    assert.equal(r.blocked, true);
    assert.equal(r.value, 'my secret');
  });
  test('log mode records the hit but does not alter or block', () => {
    const r = scanValue([R({ mode: 'log', pattern: 'secret' })], 'my secret');
    assert.equal(r.blocked, false);
    assert.equal(r.value, 'my secret');
    assert.equal(r.hits[0].count, 1);
  });
  test('disabled rules are ignored', () => {
    const r = scanValue([R({ enabled: false, mode: 'block', pattern: 'secret' })], 'secret');
    assert.equal(r.hits.length, 0);
    assert.equal(r.blocked, false);
  });
  test('walks nested objects/arrays, leaves non-strings alone, does not mutate input', () => {
    const input = { n: 5, ok: true, nil: null, msgs: [{ content: 'a secret b' }, { parts: ['secret', 3] }] };
    const snapshot = structuredClone(input);
    const r = scanValue([R({ pattern: 'secret' })], input);
    assert.deepEqual(input, snapshot);
    assert.equal(r.hits[0].count, 2);
    assert.equal(r.value.n, 5);
    assert.equal(r.value.nil, null);
    assert.ok(!JSON.stringify(r.value).includes('secret'));
  });
  test('hit sample never contains the full secret', () => {
    const r = scanValue([R({ id: 'aws', pattern: 'AKIA[0-9A-Z]{16}' })], AWS);
    assert.ok(!r.hits[0].sample.includes(AWS));
    assert.ok(r.hits[0].sample.length < AWS.length);
  });
  test('a broken rule is skipped, others still apply', () => {
    const r = scanValue([R({ id: 'bad', pattern: '([' }), R({ id: 'ok', pattern: 'secret', mode: 'block' })], 'secret');
    assert.equal(r.blocked, true);
  });
  test('block wins even when a mask rule also matches', () => {
    const r = scanValue([R({ id: 'm', pattern: 'abc' }), R({ id: 'b', pattern: 'xyz', mode: 'block' })], 'abc xyz');
    assert.equal(r.blocked, true);
  });
  test('keyword rule matches case-insensitively and counts occurrences', () => {
    const r = scanValue([R({ type: 'keyword', pattern: 'Project Falcon' })], 'project falcon and PROJECT FALCON');
    assert.equal(r.hits[0].count, 2);
  });
});

describe('identify', () => {
  const ua = (v) => ({ 'user-agent': v });
  for (const [u, want] of [
    ['claude-cli/2.0.1 (external, cli)', 'Claude Code'],
    ['codex_cli_rs/0.5', 'Codex CLI'],
    ['OpenAI/JS 4.0', 'OpenAI SDK'],
    ['Anthropic/Python 0.40', 'Anthropic SDK'],
    ['curl/8.4.0', 'curl'],
    ['', 'unknown'],
  ]) test(`${u || '(empty)'} -> ${want}`, () => assert.equal(identify(ua(u)), want));
  test('missing headers', () => assert.equal(identify({}), 'unknown'));
  test('first matching rule wins (order matters)', () => {
    const rules = [{ name: 'A', header: 'user-agent', pattern: 'foo' }, { name: 'B', header: 'user-agent', pattern: 'foo' }];
    assert.equal(identify(ua('foo'), rules), 'A');
  });
  test('rules can match on any header, not just user-agent', () => {
    const rules = [{ name: 'Claude (x-app)', header: 'X-App', pattern: '^cli$' }];
    assert.equal(identify({ 'x-app': 'cli', 'user-agent': 'node' }, rules), 'Claude (x-app)');
  });
  test('disabled rules and broken patterns are skipped', () => {
    const rules = [{ name: 'Off', header: 'user-agent', pattern: 'x', enabled: false }, { name: 'Bad', header: 'user-agent', pattern: '([' }, { name: 'Ok', header: 'user-agent', pattern: 'x' }];
    assert.equal(identify(ua('x'), rules), 'Ok');
  });
  test('"continue" rule does not fire on unrelated agents', () => assert.notEqual(identify(ua('Mozilla/5.0 Groovy'), DEFAULT_CLIENTS), 'Continue'));
});

describe('validClients', () => {
  const ok = { name: 'X', header: 'user-agent', pattern: 'x' };
  test('accepts valid', () => assert.equal(validClients([ok]), true));
  test('rejects bad regex, empty name, bad header, non-array', () => {
    assert.equal(validClients([{ ...ok, pattern: '([' }]), false);
    assert.equal(validClients([{ ...ok, pattern: '' }]), false);
    assert.equal(validClients([{ ...ok, name: ' ' }]), false);
    assert.equal(validClients([{ ...ok, header: 'a b' }]), false);
    assert.equal(validClients({}), false);
  });
});

describe('safeHeaders', () => {
  test('drops credential-like headers and truncates long values', () => {
    const h = safeHeaders({ authorization: 'Bearer x', 'x-api-key': 'k', cookie: 'c', 'x-goog-api-key': 'g', 'user-agent': 'ua', 'anthropic-beta': 'b', long: 'a'.repeat(500) });
    assert.deepEqual(Object.keys(h).sort(), ['anthropic-beta', 'long', 'user-agent']);
    assert.equal(h.long.length, 200);
  });
});

describe('blockedBody', () => {
  const hits = [{ name: 'Private key', mode: 'block' }, { name: 'JWT', mode: 'log' }];
  test('anthropic format', () => {
    const b = blockedBody('anthropic', hits);
    assert.equal(b.type, 'error');
    assert.match(b.error.message, /Private key/);
    assert.doesNotMatch(b.error.message, /JWT/, 'only blocking rules are named');
  });
  test('openai format', () => {
    const b = blockedBody('openai', hits);
    assert.equal(b.error.code, 'prompthole_blocked');
  });
});

describe('validUpstreams', () => {
  const ok = { prefix: 'azure', url: 'https://x.openai.azure.com' };
  test('accepts valid', () => assert.equal(validUpstreams([ok, { prefix: 'local', url: 'http://127.0.0.1:1234' }]), true));
  test('rejects non-array', () => assert.equal(validUpstreams({}), false));
  test('rejects bad prefixes', () => {
    for (const prefix of ['A', 'a/b', '', '-x', 'a b', 'api', '../x']) assert.equal(validUpstreams([{ prefix, url: ok.url }]), false, prefix);
  });
  test('rejects duplicate prefixes', () => assert.equal(validUpstreams([ok, ok]), false));
  test('rejects non-http urls', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x', 'nope', '']) assert.equal(validUpstreams([{ prefix: 'a', url }]), false, url);
  });
  test('rejects null entries', () => assert.equal(validUpstreams([null]), false));
});

describe('blockedBody gemini format', () => {
  test('matches Google API error shape', () => {
    const b = blockedBody('gemini', [{ name: 'Private key', mode: 'block' }]);
    assert.equal(b.error.code, 400);
    assert.equal(b.error.status, 'INVALID_ARGUMENT');
  });
  test('Google GenAI SDK user-agent is recognised', () => {
    assert.equal(identify({ 'user-agent': 'google-genai-sdk/3.4.0 gl-node/v22.0.0' }), 'Google GenAI SDK');
  });
});

describe('scanValue keepText option', () => {
  const rules = [R({ id: 'aws', pattern: 'AKIA[0-9A-Z]{16}' })];
  test('no raw text unless asked for', () => {
    assert.equal(scanValue(rules, `k ${AWS}`).hits[0].matches, undefined);
  });
  test('records the matched text with surrounding context', () => {
    const [h] = scanValue(rules, `aaa ${AWS} bbb`, { keepText: true }).hits;
    assert.equal(h.matches[0].text, AWS);
    assert.equal(h.matches[0].context, `aaa ⟦${AWS}⟧ bbb`);
  });
  test('context is correct when the pattern has capture groups', () => {
    const g = [R({ id: 'g', pattern: '(AKIA)([0-9A-Z]{16})' })];
    assert.equal(scanValue(g, `x ${AWS} y`, { keepText: true }).hits[0].matches[0].context, `x ⟦${AWS}⟧ y`);
  });
  test('context is correct with named capture groups too', () => {
    const g = [R({ id: 'n', pattern: '(?<pre>AKIA)[0-9A-Z]{16}' })];
    assert.equal(scanValue(g, `x ${AWS} y`, { keepText: true }).hits[0].matches[0].context, `x ⟦${AWS}⟧ y`);
  });
  test('context is trimmed to 30 chars each side', () => {
    const pad = 'z'.repeat(100);
    const ctx = scanValue(rules, `${pad}${AWS}${pad}`, { keepText: true }).hits[0].matches[0].context;
    assert.equal(ctx, `${'z'.repeat(30)}⟦${AWS}⟧${'z'.repeat(30)}`);
  });
  test('very long matches are truncated and flagged', () => {
    const long = 'S'.repeat(2000);
    const [h] = scanValue([R({ pattern: 'S+', mode: 'log' })], long, { keepText: true }).hits;
    assert.equal(h.matches[0].text.length, 500);
    assert.equal(h.matches[0].truncated, true);
    assert.ok(h.matches[0].context.length < 200);
  });
  test('works for keyword and multi-line private-key matches', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    const [h] = scanValue([R({ id: 'pk', mode: 'block', pattern: '-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----' })], `k\n${pem}`, { keepText: true }).hits;
    assert.equal(h.matches[0].text, pem);
  });
  test('masking and blocking behaviour is unchanged by the option', () => {
    const a = scanValue(rules, `k ${AWS}`);
    const b = scanValue(rules, `k ${AWS}`, { keepText: true });
    assert.equal(a.value, b.value);
  });
});

import { extractUsage, Capture } from '../lib/core.mjs';

describe('extractUsage', () => {
  const sse = (...objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');
  test('OpenAI chat completion', () => {
    assert.deepEqual(extractUsage(JSON.stringify({ usage: { prompt_tokens: 42, completion_tokens: 439, total_tokens: 481, completion_tokens_details: { reasoning_tokens: 418 }, prompt_tokens_details: { cached_tokens: 10 } } }), 'application/json'),
      { in: 42, out: 439, cacheRead: 10, cacheWrite: 0, reasoning: 418 });
  });
  test('OpenAI streaming: usage arrives in the last chunk, [DONE] is ignored', () => {
    const t = sse({ choices: [{ delta: { content: 'a' } }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } }, '[DONE]');
    assert.deepEqual(extractUsage(t, 'text/event-stream'), { in: 5, out: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });
  test('OpenAI responses API (input/output tokens, nested response.usage in SSE)', () => {
    assert.equal(extractUsage(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } })).out, 4);
    const t = sse({ type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 9, output_tokens_details: { reasoning_tokens: 2 } } } });
    assert.deepEqual(extractUsage(t, 'text/event-stream'), { in: 8, out: 9, cacheRead: 0, cacheWrite: 0, reasoning: 2 });
  });
  test('Anthropic non-streaming incl. cache fields', () => {
    const u = extractUsage(JSON.stringify({ usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } }));
    assert.deepEqual(u, { in: 119, out: 34, cacheRead: 100, cacheWrite: 7, reasoning: 0 });
  });
  test('Anthropic streaming: input from message_start, final cumulative output from message_delta', () => {
    const t = `event: message_start\n` + sse({ type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 5 } } })
      + `event: message_delta\n` + sse({ type: 'message_delta', usage: { output_tokens: 15 } });
    assert.deepEqual(extractUsage(t, 'text/event-stream'), { in: 30, out: 15, cacheRead: 5, cacheWrite: 0, reasoning: 0 });
  });
  test('Gemini: usageMetadata, thinking tokens count as output', () => {
    const u = extractUsage(JSON.stringify({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 4 } }));
    assert.deepEqual(u, { in: 9, out: 50, cacheRead: 4, cacheWrite: 0, reasoning: 30 });
  });
  test('Gemini streaming: cumulative chunks, last one wins (max)', () => {
    const t = sse({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } }, { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 12 } });
    assert.equal(extractUsage(t, 'text/event-stream').out, 12);
  });
  test('SSE is detected from the body even when the content-type is missing', () => {
    assert.equal(extractUsage(sse({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).out, 2);
  });
  test('returns null when there is no usage, or the body is not JSON / is an error', () => {
    assert.equal(extractUsage('{"choices":[]}'), null);
    assert.equal(extractUsage('<html>nope</html>'), null);
    assert.equal(extractUsage(''), null);
    assert.equal(extractUsage('{"error":{"message":"bad"}}'), null);
    assert.equal(extractUsage('null'), null);
    assert.equal(extractUsage('{"usage":"n/a"}'), null);
  });
  test('tolerates partial/garbled SSE lines', () => {
    const t = 'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: {"usage":{"prom';
    assert.equal(extractUsage(t, 'text/event-stream').out, 3);
  });
});

describe('Capture', () => {
  test('keeps everything for small bodies', () => {
    const c = new Capture(); c.push(Buffer.from('hello ')); c.push(Buffer.from('world'));
    assert.equal(c.text(), 'hello world');
  });
  test('for large bodies keeps the start and the end but bounds memory', () => {
    const c = new Capture(10, 20);
    c.push(Buffer.from('START-----')); // fills head
    for (let i = 0; i < 100; i++) c.push(Buffer.from(`mid${i}-`));
    c.push(Buffer.from('END'));
    const t = c.text();
    assert.ok(t.startsWith('START'));
    assert.ok(t.endsWith('END'));
    assert.ok(!t.includes('mid3-'));
    assert.ok(t.length < 80);
  });
});

describe('extractUsage: `in` is always the full prompt size', () => {
  test('real Claude Code numbers: cache reads/writes are added to Anthropic input_tokens', () => {
    // captured from an actual Claude Code run: 2 uncached + 1654 read from cache; and 4 uncached + 1751 written to cache
    const a = extractUsage(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 1654, cache_creation_input_tokens: 0 } }));
    assert.deepEqual(a, { in: 1656, out: 7, cacheRead: 1654, cacheWrite: 0, reasoning: 0 });
    const b = extractUsage(JSON.stringify({ usage: { input_tokens: 4, output_tokens: 85, cache_read_input_tokens: 0, cache_creation_input_tokens: 1751 } }));
    assert.deepEqual(b, { in: 1755, out: 85, cacheRead: 0, cacheWrite: 1751, reasoning: 0 });
  });
  test('Anthropic streaming: cache fields from message_start are added once, not once per event', () => {
    const t = 'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } }) + '\n\n'
      + 'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } }) + '\n\n'
      + 'data: ' + JSON.stringify({ type: 'message_delta', usage: { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }) + '\n\n';
    assert.deepEqual(extractUsage(t, 'text/event-stream'), { in: 114, out: 9, cacheRead: 100, cacheWrite: 10, reasoning: 0 });
  });
  test('OpenAI and Gemini already include cached tokens in the prompt total: nothing is added', () => {
    assert.equal(extractUsage(JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 40 } } })).in, 50);
    assert.equal(extractUsage(JSON.stringify({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1, cachedContentTokenCount: 40 } })).in, 50);
    assert.equal(extractUsage(JSON.stringify({ usage: { input_tokens: 50, output_tokens: 1, input_tokens_details: { cached_tokens: 40 } } })).in, 50, 'OpenAI Responses API');
  });
});
