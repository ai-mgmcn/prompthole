// "Import from a link": download, safety limits, format detection, end to end.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchText, isPrivateAddress, UrlError } from '../src/fetch-url.mjs';
import { detectFormat } from '../lib/rulelib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITLEAKS = fs.readFileSync(path.join(ROOT, 'test/fixtures/gitleaks.sample.toml'), 'utf8');
const SECRETSDB = 'patterns:\n  - pattern:\n      name: AWS API Key\n      regex: AKIA[0-9A-Z]{16}\n      confidence: high\n';
const LIST = '# my words\nProject Falcon\nre:internal-[a-z]{4}-\\d+\n';

let files, port;
before(async () => {
  files = http.createServer((req, res) => {
    const routes = {
      '/gitleaks.toml': () => res.end(GITLEAKS), '/db.yml': () => res.end(SECRETSDB), '/words.txt': () => res.end(LIST), '/empty': () => res.end('  \n'),
      '/redirect': () => { res.writeHead(302, { location: '/words.txt' }); res.end(); },
      '/loop': () => { res.writeHead(302, { location: '/loop' }); res.end(); },
      '/to-file': () => { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); },
      '/big': () => res.end('x'.repeat(3000)),
      '/slow': () => { /* never answers */ },
      '/drip': () => { res.writeHead(200); const iv = setInterval(() => res.write('x'), 40); res.on('close', () => clearInterval(iv)); }, // never finishes, but never goes quiet either
    };
    if (routes[req.url]) return routes[req.url]();
    res.writeHead(404); res.end();
  });
  await new Promise((r) => files.listen(0, '127.0.0.1', r)); port = files.address().port;
});
after(() => files?.close());
const url = (p) => `http://127.0.0.1:${port}${p}`;

describe('addresses', () => {
  test('private, loopback and link-local addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
      '198.18.0.1', '198.19.255.255', '192.0.0.8', '240.0.0.1', '255.255.255.255']) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ['8.8.8.8', '140.82.112.3', '172.32.0.1', '172.15.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '198.17.0.1', '198.20.0.1', '192.0.1.1', '2001:4860:4860::8888']) assert.ok(!isPrivateAddress(ip), ip);
  });
  test('IPv4 hidden inside IPv6 is unwrapped, however it is written (the URL parser rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1)', () => {
    for (const ip of ['::ffff:7f00:1', '::ffff:7F00:0001', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe', '::7f00:1', '::127.0.0.1',
      '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:101::1', '2002:a9fe:a9fe::']) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::']) assert.ok(!isPrivateAddress(ip), ip + ' carries a public address');
  });
  test('other IPv6 ranges that are not public, zone ids, and things that are not addresses', () => {
    for (const ip of ['fec0::1', 'fe80::1%en0', 'fc00::1', 'ff02::1', 'ff0e::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', 'garbage', '', '1:2:3:4:5:6:7:8:9', '1::2::3', 'gggg::1', '12345::1']) assert.ok(isPrivateAddress(ip), JSON.stringify(ip));
    assert.ok(!isPrivateAddress('2a00:1450:4001:81b::200e') && !isPrivateAddress('2606:4700:4700::1111') && !isPrivateAddress('1:2:3:4:5:6:7:8'));
  });
});

describe('fetchText', () => {
  test('refuses private addresses by default, including by hostname', async () => {
    await assert.rejects(fetchText(url('/words.txt')), /private network/);
    await assert.rejects(fetchText(`http://localhost:${port}/words.txt`), /private network/);
    await assert.rejects(fetchText('http://169.254.169.254/latest/meta-data/'), /private network/);
    await assert.rejects(fetchText('http://[::1]:1/x'), /private network/);
  });
  test('refuses every way of writing the loopback address, and really does not connect', async () => {
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::127.0.0.1]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]', '2130706433', '0x7f.1', '0177.0.0.1', '127.1', '0', '[::]'])
      await assert.rejects(fetchText(`http://${host}:${port}/words.txt`), /private network|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|invalid|ENOTFOUND/, host);
    for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '2130706433', '0x7f.1', '127.1']) await assert.rejects(fetchText(`http://${host}:${port}/words.txt`), /private network/, host + ' is refused before any connection');
  });
  test('a redirect to a private address is refused too, including the hex-mapped form', async () => {
    const hop = http.createServer((q, r) => { r.writeHead(302, { location: `http://[::ffff:7f00:1]:${port}/words.txt` }); r.end(); });
    await new Promise((r) => hop.listen(0, '127.0.0.1', r));
    try { await assert.rejects(fetchText(`http://127.0.0.1:${hop.address().port}/`, { allowPrivate: false }), /private network/); }
    finally { hop.close(); }
  });
  test('downloads when private addresses are allowed (an internal file server)', async () => {
    assert.equal(await fetchText(url('/words.txt'), { allowPrivate: true }), LIST);
  });
  test('follows redirects, but not forever and not to other schemes', async () => {
    assert.equal(await fetchText(url('/redirect'), { allowPrivate: true }), LIST);
    await assert.rejects(fetchText(url('/loop'), { allowPrivate: true }), /too many redirects/);
    await assert.rejects(fetchText(url('/to-file'), { allowPrivate: true }), /only http\(s\)/);
  });
  test('reports bad links, bad status, oversize files and timeouts clearly', async () => {
    await assert.rejects(fetchText('not a link'), (e) => e instanceof UrlError && /valid link/.test(e.message));
    await assert.rejects(fetchText('ftp://example.com/x'), /only http\(s\)/);
    await assert.rejects(fetchText(url('/missing'), { allowPrivate: true }), /HTTP 404/);
    await assert.rejects(fetchText(url('/big'), { allowPrivate: true, maxBytes: 1000 }), /larger than/);
    await assert.rejects(fetchText(url('/slow'), { allowPrivate: true, timeoutMs: 150 }), /timed out/);
  });
  test('a server that trickles bytes forever is cut off by the overall deadline, not only the silence timeout', async () => {
    const t0 = Date.now();
    await assert.rejects(fetchText(url('/drip'), { allowPrivate: true, timeoutMs: 5000, totalMs: 300 }), /took too long/);
    assert.ok(Date.now() - t0 < 2000, 'stopped within about the deadline');
  });
  test('a download that finishes in time is not affected by the deadline', async () => {
    assert.equal(await fetchText(url('/words.txt'), { allowPrivate: true, totalMs: 5000 }), LIST);
  });
});

describe('format detection', () => {
  test('recognises each supported format', () => {
    assert.equal(detectFormat(GITLEAKS), 'gitleaks');
    assert.equal(detectFormat(SECRETSDB), 'secrets-db');
    assert.equal(detectFormat(LIST), 'list');
    assert.equal(detectFormat('just some words'), 'list');
  });
});

describe('server: import from a link', () => {
  let open, closed;
  const start = async (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-url-'));
    const p = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); });
    const c = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(p), PROMPTHOLE_DATA: dir, ...env }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    await fetch(base + '/api/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '[]' }); // start from a clean slate
    return { base, stop: () => { c.once('exit', () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })); c.kill(); } };
  };
  const call = (s, p, body) => fetch(s.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  before(async () => { open = await start({ PROMPTHOLE_ALLOW_PRIVATE_URLS: '1' }); closed = await start({}); });
  after(() => { open?.stop(); closed?.stop(); });

  test('preview detects the format; import adds the rules as log-only unless told otherwise', async () => {
    const pv = await (await call(open, '/api/rules/preview', { source: 'url', url: url('/gitleaks.toml') })).json();
    assert.equal(pv.format, 'gitleaks'); assert.equal(pv.label, 'Gitleaks'); assert.ok(pv.total >= 1); assert.equal(pv.storesSecrets, false);
    const done = await (await call(open, '/api/rules/import', { source: 'url', url: url('/gitleaks.toml'), mode: 'log' })).json();
    assert.equal(done.added, pv.total);
    const rules = await (await fetch(open.base + '/api/rules')).json();
    assert.ok(rules.every((r) => r.mode === 'log' && r.enabled));
  });
  test('a pasted list and a Secrets DB file work through the same box', async () => {
    const list = await (await call(open, '/api/rules/preview', { source: 'url', url: url('/words.txt') })).json();
    assert.equal(list.format, 'list'); assert.equal(list.total, 2); assert.equal(list.storesSecrets, true, 'exact words are stored in plain text, so the warning is shown');
    const db = await (await call(open, '/api/rules/preview', { source: 'url', url: url('/db.yml') })).json();
    assert.equal(db.format, 'secrets-db'); assert.equal(db.total, 1);
  });
  test('redirects work end to end', async () => {
    assert.equal((await (await call(open, '/api/rules/preview', { source: 'url', url: url('/redirect') })).json()).total, 2);
  });
  test('errors come back as readable messages', async () => {
    for (const [body, status, re] of [[{ source: 'url' }, 400, /paste a link/], [{ source: 'url', url: url('/empty') }, 400, /empty/], [{ source: 'url', url: url('/missing') }, 502, /HTTP 404/], [{ source: 'url', url: 'ftp://x/y' }, 400, /http\(s\)/]]) {
      const r = await call(open, '/api/rules/preview', body); assert.equal(r.status, status, JSON.stringify(body)); assert.match((await r.json()).error, re);
    }
  });
  test('by default an internal address cannot be fetched', async () => {
    const r = await call(closed, '/api/rules/preview', { source: 'url', url: url('/gitleaks.toml') });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /private network/);
  });
});
