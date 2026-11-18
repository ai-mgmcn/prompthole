// Logos next to names: the rules point at real files, the files are real small PNGs, and the server can serve them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { RULES, iconFor, icon, withIcon, letterIcon, onIconError } from '../public/js/icons.js';
import { createStatic } from '../src/static.mjs';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const dir = path.join(pub, 'icons');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4));
const targets = (name) => RULES.flatMap(([, t]) => (typeof t === 'string' ? [t] : ['claude', 'anthropic']));

test('every rule points at an icon file, and every icon file is used by a rule', () => {
  const used = new Set(targets());
  assert.deepEqual([...used].filter((t) => !files.includes(t)), [], 'rules that point at a missing file');
  assert.deepEqual(files.filter((f) => !used.has(f)), [], 'icon files no rule uses (add a rule or delete the file)');
});

test('icon files are real PNGs, 64 px, and small', () => {
  for (const f of files) {
    const b = fs.readFileSync(path.join(dir, f + '.png'));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', f);
    assert.equal(b.readUInt32BE(16), b.readUInt32BE(20), `${f} is square`);
    assert.ok(b.readUInt32BE(16) <= 64, `${f} is at most 64 px`);
    assert.ok(b.length < 20_000, `${f} is ${b.length} bytes`);
  }
});

test('common tools, providers and models get the right logo', () => {
  const cases = {
    'Claude Code': 'claudecode', 'Codex CLI': 'codex', 'Gemini CLI': 'geminicli', 'Cline / Roo': 'cline', 'cursor': 'cursor', 'Windsurf': 'windsurf', 'OpenAI SDK': 'openai', 'Anthropic SDK': 'anthropic', 'Google GenAI SDK': 'google',
    anthropic: 'anthropic', openai: 'openai', gemini: 'gemini', lmstudio: 'lmstudio', 'LM Studio (local)': 'lmstudio', openrouter: 'openrouter', ollama: 'ollama',
    'claude-sonnet-4-5': 'claude', 'claude-3-haiku-20240307': 'claude', 'gpt-4o': 'openai', 'gpt-5': 'openai', 'o3-mini': 'openai', 'o1': 'openai', 'dall-e-3': 'dalle', 'gemini-2.5-pro': 'gemini', 'gemma-2-9b': 'gemma',
    'llama-3.1-70b': 'meta', 'meta-llama/Llama-3': 'meta', 'mistral-large': 'mistral', 'mixtral-8x7b': 'mistral', 'grok-3': 'grok', 'command-r-plus': 'cohere', 'sonar-pro': 'perplexity', 'phi-4': 'microsoft', 'nvidia/nemotron': 'nvidia', 'amazon.nova-pro': 'nova',
    'qwen2.5-coder-32b': 'qwen', 'qwq-32b': 'qwen', 'deepseek-chat': 'deepseek', 'deepseek-r1': 'deepseek', 'kimi-k2': 'kimi', 'moonshot-v1': 'moonshot', 'glm-4.5': 'zhipu', 'glm-4.5v': 'glmv', 'doubao-seed-1.6': 'doubao', 'MiniMax-M2': 'minimax',
    'yi-large': 'yi', 'baichuan4': 'baichuan', 'hunyuan-turbo': 'hunyuan', 'ernie-4.0': 'wenxin', 'step-1v': 'stepfun', 'internlm3': 'internlm',
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(iconFor(name), want, name);
});

test('look-alike words do not pick up a logo by accident', () => {
  for (const n of ['python-requests', 'curl', 'node', 'Mozilla', 'my-tool', 'example', 'hello-world', 'sky', 'stepper', 'amplifier', 'v01']) assert.equal(iconFor(n), null, n);
  for (const n of ['', null, undefined, 'unknown', '—']) assert.equal(iconFor(n), null);
});

test('names without a logo get a coloured letter, always the same colour', () => {
  const a = icon('my-script'), b = icon('my-script'), c = icon('other-thing');
  assert.equal(a, b); assert.notEqual(a, c);
  assert.match(a, /class="ico mono"[^>]*>M</);
  assert.match(icon('千问-自研'), />千</);
  assert.match(icon('unknown'), />\?</); assert.match(icon(''), />\?</); assert.match(icon('---'), />\?</);
});

test('a logo that fails to load is swapped for the default icon', () => {
  const img = { tagName: 'IMG', classList: { contains: (c) => c === 'ico' }, dataset: { n: 'deepseek-chat' }, outerHTML: icon('deepseek-chat') };
  onIconError({ target: img });
  assert.equal(img.outerHTML, letterIcon('deepseek-chat')); assert.match(img.outerHTML, /class="ico mono"[^>]*>D</);
  const noName = { tagName: 'IMG', classList: { contains: () => true }, outerHTML: 'x' }; onIconError({ target: noName });
  assert.match(noName.outerHTML, />\?</, 'no remembered name: a question mark, never a broken image');
  const other = { tagName: 'IMG', classList: { contains: () => false }, outerHTML: 'keep' }; onIconError({ target: other }); assert.equal(other.outerHTML, 'keep', 'other images are left alone');
  const span = { tagName: 'SPAN', classList: { contains: () => true }, outerHTML: 'keep' }; onIconError({ target: span }); assert.equal(span.outerHTML, 'keep');
  onIconError({ target: null }); onIconError({ target: {} });
  assert.match(icon('claude-3'), /data-n="claude-3"/);
});

test('names are escaped, and logos are local images', () => {
  assert.match(icon('claude-3'), /<img class="ico" src="\/icons\/claude\.png"/);
  assert.ok(!icon('claude-3').includes('http'));
  const html = withIcon('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img src=x'), html);
  assert.match(html, /&lt;img/);
  assert.match(withIcon('gpt-4o', 'custom label'), /^<span class="ic"><img [^>]*><span>custom label<\/span><\/span>$/, 'icon and text share one flex row, so they line up');
});

test('the server serves icons as images, not reserved for upstream names', async () => {
  const serve = createStatic(pub);
  const srv = http.createServer((req, res) => { if (!serve(req, res, new URL(req.url, 'http://x').pathname)) { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const r = await fetch(base + '/icons/claude.png');
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.match(r.headers.get('cache-control'), /max-age/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await r.arrayBuffer()).byteLength, fs.statSync(path.join(dir, 'claude.png')).size);
    assert.equal((await fetch(base + '/icons/nope.png')).status, 404);
    assert.equal((await fetch(base + '/icons/..%2f..%2fserver.mjs')).status, 404);
  } finally { srv.close(); }
});
