// The audit trail: one file per day, never compacted; queried by time range with page numbers.
// Covers the file format, paging and filters, incremental reads, cache limits, concurrency, purge, retention, and the HTTP API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuditLog, dayOf, DAY_MS } from '../src/audit.mjs';
import { slimEvent, searchText, matchesFilters } from '../src/event.mjs';
import { createStore } from '../src/store.mjs';
import { stats, toolRuleCounts } from '../src/stats.mjs';
import { S, bounds, params, pageList, createLoader, pagerHtml, countText, emptyText, storageText, when, rowHtml, matched, pillFor, tokenLine, empty } from '../public/js/pages/requests-logic.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ph-audit-'));
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0); // 2026-11-18 12:00 UTC
let n = 0;
const ev = (ts, o = {}) => ({ id: `e${++n}`, ts, tool: 'Claude Code', provider: 'anthropic', path: '/v1/messages', model: 'claude-x', action: 'allowed', status: 200, ms: 5, bytes: 100, hits: [], headers: { 'user-agent': 'x' }, ...o });
const fill = (a, count, ts0, step = 1000, o = {}) => { const out = []; for (let i = 0; i < count; i++) { const e = ev(ts0 + i * step, o); a.append(e); out.push(e); } return out; };

describe('event helpers', () => {
  test('slimEvent drops the heavy parts and tolerates old records without hits', () => {
    const s = slimEvent(ev(T0, { hits: [{ name: 'k', mode: 'mask', count: 2, sample: 's', matches: [{ text: 'secret' }] }] }));
    assert.deepEqual(s.hits, [{ name: 'k', mode: 'mask', count: 2 }]); assert.equal(s.headers, undefined);
    assert.deepEqual(slimEvent({ id: 'x', ts: 1 }).hits, []);
  });
  test('search text and filters', () => {
    const e = ev(T0, { tool: 'Cursor', model: 'GPT-5', hits: [{ name: 'AWS key' }], calls: [{ text: 'rm -rf x', action: 'flagged' }] });
    assert.match(searchText(e), /cursor gpt-5 .*aws key.*rm -rf x/);
    assert.ok(matchesFilters(e, {})); assert.ok(matchesFilters(e, undefined));
    assert.ok(matchesFilters(e, { needle: 'aws' })); assert.ok(!matchesFilters(e, { needle: 'zzz' }));
    assert.ok(matchesFilters(e, { tool: 'Cursor' })); assert.ok(!matchesFilters(e, { tool: 'Other' }));
    assert.ok(matchesFilters(e, { action: 'allowed' })); assert.ok(!matchesFilters(e, { action: 'blocked' }));
    assert.ok(matchesFilters(e, { calls: 'risky' })); assert.ok(!matchesFilters(ev(T0), { calls: 'risky' }));
    assert.ok(!matchesFilters(ev(T0, { calls: [{ action: 'allowed' }] }), { calls: 'risky' }));
    assert.ok(matchesFilters(e, { needle: 'zzz' }, 'has zzz in it'), 'a precomputed text is used when given');
  });
});

describe('files', () => {
  test('one file per UTC day, owner-only, appended in order; never rewritten', () => {
    const dir = tmp(), a = new AuditLog(path.join(dir, 'audit'));
    assert.ok(a.isEmpty()); assert.equal(fs.statSync(path.join(dir, 'audit')).mode & 0o777, 0o700);
    const v0 = a.version;
    fill(a, 3, T0); fill(a, 2, T0 + DAY_MS); a.append(ev(Date.UTC(2026, 10, 18, 23, 59, 59, 999))); a.append(ev(Date.UTC(2026, 10, 19, 0, 0, 0, 0)));
    assert.equal(a.version, v0 + 7);
    assert.deepEqual(a.days().map((d) => [d.date, d.bytes > 0]), [['2026-11-18', true], ['2026-11-19', true]]);
    assert.equal(fs.statSync(a.file('2026-11-18')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(a.file('2026-11-18'), 'utf8').split('\n').filter(Boolean).length, 4);
    assert.equal(fs.readFileSync(a.file('2026-11-19'), 'utf8').split('\n').filter(Boolean).length, 3, 'midnight belongs to the new day');
    assert.ok(!a.isEmpty()); assert.equal(dayOf(0), '1970-01-01');
  });
  test('unrelated files in the folder are ignored', () => {
    const dir = tmp(), a = new AuditLog(dir); fill(a, 1, T0);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'); fs.writeFileSync(path.join(dir, '2026-13-xx.jsonl'), 'x'); fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    assert.deepEqual(a.days().map((d) => d.date), ['2026-11-18']);
  });
  test('a failing write (bad timestamp) throws to the caller, which is expected to catch it', () => {
    const a = new AuditLog(tmp());
    assert.throws(() => a.append({ id: 'x', ts: NaN }), RangeError);
    assert.throws(() => a.append({ id: 'x', ts: 8.7e15 }), RangeError);
    assert.ok(a.isEmpty());
  });
});

describe('crash safety', () => {
  test('a record after a half-written line is kept (it starts on a new line instead of being glued on)', async () => {
    const a = new AuditLog(tmp()); const e1 = ev(T0), e2 = ev(T0 + 1000);
    a.append(e1); fs.appendFileSync(a.file('2026-11-18'), '{"id":"torn","ts":1'); // as if the process died mid-write
    const b = new AuditLog(path.dirname(a.file('2026-11-18'))); // a restart: a fresh object that knows nothing
    b.append(e2);
    assert.deepEqual((await b.query({})).items.map((x) => x.id), [e2.id, e1.id]);
    assert.equal((await b.byId(e2.id, e2.ts)).id, e2.id);
    const e3 = ev(T0 + 2000); b.append(e3); assert.equal((await b.query({})).total, 3, 'normal appends are not given extra blank lines');
    assert.ok(!fs.readFileSync(b.file('2026-11-18'), 'utf8').includes('\n\n'));
  });
  test('after a failed write the next record still starts on a clean line', async () => {
    const a = new AuditLog(tmp()), e1 = ev(T0), e3 = ev(T0 + 2000); a.append(e1);
    const real = fs.appendFileSync; let failed = false;
    fs.appendFileSync = (f, data, o) => { if (!failed) { failed = true; real(f, data.slice(0, 30), o); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } return real(f, data, o); };
    try { assert.throws(() => a.append(ev(T0 + 1000)), /ENOSPC/); } finally { fs.appendFileSync = real; }
    a.append(e3);
    assert.deepEqual((await a.query({})).items.map((x) => x.id), [e3.id, e1.id]);
  });
  test('appending to an empty or brand-new day file works', async () => {
    const a = new AuditLog(tmp()); fs.writeFileSync(a.file('2026-11-18'), '');
    a.append(ev(T0)); a.append(ev(T0 + 1)); assert.equal((await a.query({})).total, 2);
    a.append(ev(T0 + DAY_MS)); assert.equal(a.days().length, 2);
  });
  test('purge replaces each file in one step: no temporary files left, same permissions, and nothing half-done on failure', async () => {
    const a = new AuditLog(tmp()), m = (t) => ({ name: 'k', mode: 'mask', count: 1, sample: 's', matches: [{ text: t }] });
    const d1 = ev(T0 - DAY_MS, { hits: [m('first-day-secret')] }), d2 = ev(T0, { hits: [m('second-day-secret')] }); a.append(d1); a.append(d2);
    assert.equal(a.purgeMatchedText(), 2);
    assert.deepEqual(fs.readdirSync(path.dirname(a.file('2026-11-18'))).sort(), ['2026-11-17.jsonl', '2026-11-18.jsonl']);
    assert.equal(fs.statSync(a.file('2026-11-18')).mode & 0o777, 0o600);
    // a failure while writing the second file
    const e3 = ev(T0 - DAY_MS, { hits: [m('again-1')] }), e4 = ev(T0, { hits: [m('again-2')] }); a.append(e3); a.append(e4);
    const realWrite = fs.writeFileSync; let calls = 0;
    fs.writeFileSync = (f, ...r) => { if (++calls === 2) throw new Error('disk full'); return realWrite(f, ...r); };
    const gen = a.generation;
    try { assert.throws(() => a.purgeMatchedText(), /disk full/); } finally { fs.writeFileSync = realWrite; }
    assert.ok(a.generation > gen, 'cached positions are dropped even though the purge failed halfway');
    assert.ok(!fs.readFileSync(a.file('2026-11-17'), 'utf8').includes('again-1'), 'the first day was purged');
    assert.ok(fs.readFileSync(a.file('2026-11-18'), 'utf8').includes('again-2'), 'the second day is intact, not truncated');
    assert.equal((await a.query({})).total, 4, 'every record is still readable');
    assert.equal(a.purgeMatchedText(), 1, 'running it again finishes the job');
    assert.ok(!fs.readdirSync(path.dirname(a.file('2026-11-18'))).some((n) => n.endsWith('.tmp')), 'no temporary files are left behind');
  });
});

describe('query: ranges, paging, filters', () => {
  let a, all;
  before(() => {
    a = new AuditLog(tmp());
    all = [...fill(a, 40, T0 - 2 * DAY_MS), ...fill(a, 40, T0 - DAY_MS, 1000, { tool: 'Cursor', action: 'blocked', hits: [{ name: 'AWS key', mode: 'block', count: 1, sample: 's' }] }), ...fill(a, 40, T0, 1000, { calls: [{ name: 'Bash', text: 'rm -rf /tmp/x', action: 'flagged' }] })];
  });
  test('newest first across days, with the total and page count', async () => {
    const r = await a.query({ size: 50 });
    assert.equal(r.total, 120); assert.equal(r.pages, 3); assert.equal(r.page, 1); assert.equal(r.size, 50); assert.equal(r.days, 3);
    assert.equal(r.items.length, 50); assert.equal(r.items[0].id, all.at(-1).id);
    assert.ok(r.items.every((x, i) => i === 0 || r.items[i - 1].ts >= x.ts));
    const p3 = await a.query({ size: 50, page: 3 }); assert.equal(p3.items.length, 20); assert.equal(p3.items.at(-1).id, all[0].id);
  });
  test('every record appears on exactly one page', async () => {
    const seen = [];
    for (let p = 1; p <= 4; p++) seen.push(...(await a.query({ size: 30, page: p })).items.map((x) => x.id));
    assert.equal(seen.length, 120); assert.equal(new Set(seen).size, 120);
  });
  test('a page past the end shows the last page; bad numbers fall back to sane ones', async () => {
    assert.equal((await a.query({ size: 50, page: 99 })).page, 3);
    assert.equal((await a.query({ size: 50, page: 0 })).page, 1); assert.equal((await a.query({ size: 50, page: -4 })).page, 1); assert.equal((await a.query({ size: 50, page: 'x' })).page, 1);
    assert.equal((await a.query({ size: 0 })).size, 50); assert.equal((await a.query({ size: 100000 })).size, 500); assert.equal((await a.query({ size: 2.7 })).size, 2);
  });
  test('the time range is exact, and only the days it touches are read', async () => {
    const day2 = await a.query({ from: T0 - DAY_MS, to: T0 - DAY_MS + 39_000, size: 500 });
    assert.equal(day2.total, 40); assert.equal(day2.days, 1);
    assert.equal((await a.query({ from: T0 - DAY_MS + 10_000, to: T0 - DAY_MS + 19_000, size: 500 })).total, 10, 'both ends are inclusive');
    assert.equal((await a.query({ from: T0 + 40_000 })).total, 0);
    assert.equal((await a.query({ to: T0 - 3 * DAY_MS })).total, 0);
    assert.equal((await a.query({ from: T0 })).total, 40);
    const none = await a.query({ from: T0 + 1e9 }); assert.deepEqual([none.items, none.pages, none.page], [[], 1, 1]);
  });
  test('missing, negative or non-numeric bounds mean "no limit"; a reversed range is simply empty', async () => {
    for (const q of [{ from: -5 }, { from: NaN }, { to: NaN }, { from: 'abc' }, { to: 'abc' }, {}]) assert.equal((await a.query({ ...q, size: 500 })).total, 120, JSON.stringify(q));
    assert.equal((await a.query({ from: T0, to: T0 - 1 })).total, 0);
  });
  test('filters combine with the range', async () => {
    assert.equal((await a.query({ action: 'blocked' })).total, 40);
    assert.equal((await a.query({ tool: 'Cursor', action: 'blocked' })).total, 40);
    assert.equal((await a.query({ tool: 'Cursor', action: 'allowed' })).total, 0);
    assert.equal((await a.query({ calls: 'risky' })).total, 40);
    assert.equal((await a.query({ q: ' AWS KEY ' })).total, 40, 'search ignores case and surrounding spaces');
    assert.equal((await a.query({ q: 'rm -rf' })).total, 40);
    assert.equal((await a.query({ q: 'rm -rf', from: T0 - DAY_MS, to: T0 - 1 })).total, 0);
    assert.equal((await a.query({ q: 'nothing like this' })).total, 0);
  });
  test('results are slim: no headers or matched text', async () => {
    const x = (await a.query({ size: 1 })).items[0];
    assert.equal(x.headers, undefined); assert.equal(x.id, all.at(-1).id);
  });
});

describe('incremental reads, corrupt data, big days', () => {
  test('a day that is still being written is read incrementally and never duplicated', async () => {
    const a = new AuditLog(tmp());
    fill(a, 5, T0);
    assert.equal((await a.query({})).total, 5);
    const off = a.cache.get('2026-11-18').offset;
    fill(a, 3, T0 + 10_000);
    const r = await a.query({}); assert.equal(r.total, 8); assert.equal(new Set(r.items.map((x) => x.id)).size, 8);
    assert.ok(a.cache.get('2026-11-18').offset > off);
    assert.equal((await a.query({})).total, 8, 'asking again changes nothing');
  });
  test('a half-written last line is ignored until it is finished', async () => {
    const a = new AuditLog(tmp()); fill(a, 2, T0);
    const e = ev(T0 + 5000), line = JSON.stringify(e) + '\n', file = a.file('2026-11-18');
    fs.appendFileSync(file, line.slice(0, 20));
    assert.equal((await a.query({})).total, 2);
    fs.appendFileSync(file, line.slice(20));
    const r = await a.query({}); assert.equal(r.total, 3); assert.equal(r.items[0].id, e.id);
  });
  test('corrupt lines and blank lines are skipped, everything else still loads', async () => {
    const a = new AuditLog(tmp()), file = a.file('2026-11-18'), good = [ev(T0), ev(T0 + 1000)];
    fs.writeFileSync(file, [JSON.stringify(good[0]), '{broken', '', '   ', 'null', JSON.stringify(good[1])].join('\n') + '\n');
    const r = await a.query({}); assert.deepEqual(r.items.map((x) => x.id), [good[1].id, good[0].id]);
  });
  test('multi-byte text does not break record offsets', async () => {
    const a = new AuditLog(tmp()), es = [ev(T0, { tool: '千问 工具 🚀' }), ev(T0 + 1000, { tool: 'ascii' }), ev(T0 + 2000, { tool: 'ünïcödé' })];
    for (const e of es) a.append(e);
    for (const e of es) assert.equal((await a.byId(e.id, e.ts)).tool, e.tool);
  });
  test('a big day (several yields while parsing) is read completely and every record can be fetched', async () => {
    const a = new AuditLog(tmp()), es = fill(a, 6500, T0, 10);
    const r = await a.query({ size: 500, page: 13 }); assert.equal(r.total, 6500); assert.equal(r.items.length, 500);
    for (const i of [0, 1999, 2000, 3999, 4000, 6499]) assert.equal((await a.byId(es[i].id, es[i].ts)).id, es[i].id);
  });
  test('a missing day file between listing and reading is not an error', async () => {
    const a = new AuditLog(tmp()); fill(a, 2, T0); fill(a, 2, T0 - DAY_MS);
    const orig = a.days.bind(a); a.days = () => [...orig(), { date: '2026-11-01', bytes: 1 }];
    assert.equal((await a.query({})).total, 4);
  });
});

describe('single record lookup', () => {
  test('returns the full record (headers, matched text), with or without the timestamp', async () => {
    const a = new AuditLog(tmp()), keep = ev(T0 - DAY_MS, { hits: [{ name: 'k', mode: 'mask', count: 1, sample: 's', matches: [{ text: 'AKIA…', context: 'ctx' }] }] });
    a.append(ev(T0)); a.append(keep); fill(a, 3, T0 + 5000);
    for (const ts of [keep.ts, undefined, '', 'garbage', 0, -1, 1e300]) { const x = await a.byId(keep.id, ts); assert.equal(x?.id, keep.id, `ts=${ts}`); assert.equal(x.headers['user-agent'], 'x'); assert.equal(x.hits[0].matches[0].text, 'AKIA…'); }
  });
  test('wrong day, unknown id and unsafe ids give null', async () => {
    const a = new AuditLog(tmp()), e = ev(T0); a.append(e);
    assert.equal(await a.byId(e.id, T0 + 3 * DAY_MS), null);
    for (const id of ['nope', '', undefined, null, '../../etc/passwd', 'a"b', 'x'.repeat(65), '{"id":"e1"']) assert.equal(await a.byId(id, T0), null, String(id));
  });
  test('an id that is a prefix of another is not confused with it', async () => {
    const a = new AuditLog(tmp()), x = { ...ev(T0), id: 'abc' }, y = { ...ev(T0 + 1), id: 'abcd' }; a.append(y); a.append(x);
    assert.equal((await a.byId('abc', T0)).id, 'abc'); assert.equal((await a.byId('abcd', T0)).id, 'abcd');
  });
  test('a record whose file was rewritten under us is "not found", not a crash', async () => {
    const a = new AuditLog(tmp()), es = fill(a, 3, T0);
    await a.query({}); fs.writeFileSync(a.file('2026-11-18'), 'x'.repeat(10)); // shorter than the cached offsets
    assert.equal(await a.byId(es[2].id, T0), null);
  });
});

describe('purge, retention, cache limits', () => {
  test('purging saved matched text rewrites every day and keeps the rest', async () => {
    const a = new AuditLog(tmp()), m = (t) => ({ name: 'k', mode: 'mask', count: 1, sample: 's', matches: [{ text: t }] });
    const e1 = ev(T0, { hits: [m('one'), m('two')] }), e2 = ev(T0 - DAY_MS, { hits: [m('three')] }), e3 = ev(T0 + 1, { hits: [{ name: 'k', mode: 'log', count: 1, sample: 's' }] });
    for (const e of [e2, e1, e3]) a.append(e);
    fs.appendFileSync(a.file('2026-11-18'), 'not json but mentions "matches"\n');
    await a.query({}); const gen = a.generation, v = a.version;
    assert.equal(a.purgeMatchedText(), 3);
    assert.ok(a.generation > gen && a.version > v && a.cache.size === 0, 'cached positions are dropped');
    assert.ok(!fs.readFileSync(a.file('2026-11-18'), 'utf8').includes('"matches"') || fs.readFileSync(a.file('2026-11-18'), 'utf8').includes('not json'));
    assert.ok(!JSON.stringify(await a.byId(e1.id, e1.ts)).includes('one')); assert.ok(!JSON.stringify(await a.byId(e2.id, e2.ts)).includes('three'));
    assert.equal((await a.byId(e1.id, e1.ts)).hits.length, 2);
    const r = await a.query({}); assert.equal(r.total, 3, 'the garbage line is still skipped');
    assert.equal(a.purgeMatchedText(), 0, 'nothing left to purge');
  });
  test('purge while a query is reading does not leave stale positions in the cache', async () => {
    const a = new AuditLog(tmp()), es = fill(a, 100, T0);
    const orig = fs.promises.open; let purged = false;
    fs.promises.open = async (...args) => { fs.promises.open = orig; if (!purged) { purged = true; a.purgeMatchedText(); } return orig(...args); };
    try { assert.equal((await a.query({})).total, 100); } finally { fs.promises.open = orig; }
    assert.equal(a.cache.size, 0, 'a read that raced with a rewrite is used once and not kept');
    assert.equal((await a.byId(es[50].id, es[50].ts)).id, es[50].id);
  });
  test('retention deletes whole old days only, and 0 keeps everything', async () => {
    const dir = tmp(), a = new AuditLog(dir, { retentionDays: 2 }), now = T0;
    for (let d = 0; d < 6; d++) fill(a, 2, now - d * DAY_MS);
    await a.query({}); assert.equal(a.days().length, 6);
    assert.equal(a.prune(now), 3);
    assert.deepEqual(a.days().map((d) => d.date), ['2026-11-16', '2026-11-17', '2026-11-18']);
    assert.equal((await a.query({})).total, 6, 'deleted days are gone from queries too');
    assert.equal(a.prune(now), 0);
    const keep = new AuditLog(tmp()); fill(keep, 1, now - 400 * DAY_MS); assert.equal(keep.prune(now), 0); assert.equal(keep.days().length, 1);
  });
  test('the cache never holds more than its limit (the day being read stays), and answers stay correct', async () => {
    const a = new AuditLog(tmp(), { cacheItems: 50 });
    for (let d = 0; d < 6; d++) fill(a, 30, T0 - d * DAY_MS);
    const r = await a.query({ size: 500 }); assert.equal(r.total, 180);
    const held = [...a.cache.values()].reduce((s, e) => s + e.items.length, 0);
    assert.ok(held <= 60 && a.cache.size <= 2, `held ${held} entries in ${a.cache.size} days`);
    assert.equal((await a.query({ size: 500 })).total, 180);
    const big = new AuditLog(tmp(), { cacheItems: 5 }); fill(big, 40, T0); assert.equal((await big.query({})).total, 40); assert.equal(big.cache.size, 1, 'a single day larger than the limit is still served');
  });
});

describe('concurrency', () => {
  test('many queries and appends at the same time: no duplicates, nothing lost, counts only grow', async () => {
    const a = new AuditLog(tmp(), { cacheItems: 100 }), written = [];
    const writer = (async () => { for (let i = 0; i < 300; i++) { const e = ev(T0 + i, { tool: i % 2 ? 'A' : 'B' }); a.append(e); written.push(e); if (i % 7 === 0) await new Promise((r) => setImmediate(r)); } })();
    const results = [];
    const readers = Array.from({ length: 12 }, (_, k) => (async () => { for (let i = 0; i < 12; i++) { results.push(await a.query({ size: 500, tool: k % 3 === 0 ? 'A' : '' })); await new Promise((r) => setImmediate(r)); } })());
    await Promise.all([writer, ...readers]);
    for (const r of results) { const ids = r.items.map((x) => x.id); assert.equal(new Set(ids).size, ids.length, 'no duplicates inside one answer'); assert.equal(r.total, r.items.length); }
    const final = await a.query({ size: 500 }); assert.equal(final.total, 300);
    assert.deepEqual(new Set(final.items.map((x) => x.id)), new Set(written.map((x) => x.id)));
    assert.equal((await a.query({ size: 500, tool: 'A' })).total, 150);
  });
  test('queries run one at a time, and a failing query does not block the ones after it', async () => {
    const a = new AuditLog(tmp()); fill(a, 3, T0);
    const order = [], slow = a.serial(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end'); return 1; });
    const fast = a.serial(async () => { order.push('b'); return 2; });
    assert.deepEqual(await Promise.all([slow, fast]), [1, 2]); assert.deepEqual(order, ['a-start', 'a-end', 'b']);
    await assert.rejects(a.serial(async () => { throw new Error('boom'); }), /boom/);
    assert.equal((await a.query({})).total, 3, 'the queue recovered');
    const orig = a.days; a.days = () => { throw new Error('disk error'); };
    await assert.rejects(a.query({}), /disk error/); a.days = orig;
    assert.equal((await a.query({})).total, 3);
  });
  test('repeated use does not accumulate: bounded cache, no growing promise chain', async () => {
    const a = new AuditLog(tmp(), { cacheItems: 100 });
    for (let round = 0; round < 40; round++) { fill(a, 20, T0 - (round % 5) * DAY_MS + round * 100); await a.query({ size: 10 }); }
    const held = [...a.cache.values()].reduce((s, e) => s + e.items.length, 0);
    assert.ok(held <= 100 + 100 && a.cache.size <= 6, `cache holds ${held} entries`);
    await Promise.all(Array.from({ length: 200 }, () => a.query({ size: 5 })));
    assert.ok(a.queue instanceof Promise);
    assert.equal(await Promise.race([a.queue.then(() => 'settled'), new Promise((r) => setTimeout(() => r('stuck'), 1000))]), 'settled');
  });
});

describe('store wiring', () => {
  const cfg = (dir, o = {}) => ({ dataDir: dir, root: ROOT, maxEvents: 100, ...o });
  test('every recorded request reaches the audit trail, beyond the in-memory window', async () => {
    const dir = tmp(), store = createStore(cfg(dir));
    const first = ev(T0); store.events.record(first);
    for (let i = 1; i < 130; i++) store.events.record(ev(T0 + i));
    store.stop(); store.flush();
    assert.equal(store.events.list.length, 100, 'the dashboard window is capped');
    assert.equal((await store.audit.query({ size: 500 })).total, 130, 'the audit trail is not');
    assert.equal((await store.audit.byId(first.id, undefined)).id, first.id, 'the oldest one is no longer in the window but is on disk');
    assert.ok(!store.events.list.some((e) => e.id === first.id));
  });
  test('history from before the audit trail existed is carried over once', async () => {
    const dir = tmp(); const old = [ev(T0 - DAY_MS), ev(T0)];
    fs.writeFileSync(path.join(dir, 'events.jsonl'), old.map((e) => JSON.stringify(e)).join('\n') + '\n');
    let store = createStore(cfg(dir)); store.stop();
    assert.equal((await store.audit.query({})).total, 2);
    store = createStore(cfg(dir)); store.stop();
    assert.equal((await store.audit.query({})).total, 2, 'not copied again on the next start');
  });
  test('retention from the config is applied at start, and a failing audit write never breaks recording', async () => {
    const dir = tmp(), a = new AuditLog(path.join(dir, 'audit'));
    fill(a, 1, Date.now() - 10 * DAY_MS); fill(a, 1, Date.now());
    const store = createStore(cfg(dir, { auditDays: 3 })); store.stop();
    assert.equal(store.audit.days().length, 1);
    store.audit.append = () => { throw new Error('disk full'); };
    assert.doesNotThrow(() => store.events.record(ev(Date.now()))); assert.equal(store.events.list.at(-1).tool, 'Claude Code');
    store.audit.purgeMatchedText = () => { throw new Error('read-only'); };
    assert.doesNotThrow(() => store.events.purgeMatchedText());
  });
});

describe('HTTP API', () => {
  let child, base, dir, upstream;
  const j = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, tag: r.headers.get('etag'), body: r.status === 304 ? null : await r.json() }; };
  const startServer = async (env = {}) => {
    const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise((r) => probe.close(r));
    child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PROMPTHOLE_PORT: String(port), PROMPTHOLE_DATA: dir, ...env }, stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/stats')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('server did not start');
  };
  const stopServer = () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
  const chat = async (content, ua = 'claude-cli/2') => {
    const r = await fetch(`${base}/up/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content }] }) });
    await r.arrayBuffer(); // read it all, so the gateway sees the request finish
    return r;
  };
  const until = async (fn, ms = 3000) => { for (let t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 25))) { if (await fn()) return true; } return false; };

  before(async () => {
    upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })); }); });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    dir = tmp();
    fs.writeFileSync(path.join(dir, 'upstreams.json'), JSON.stringify([{ id: 'up', label: 'up', prefix: 'up', url: `http://127.0.0.1:${upstream.address().port}`, env: '', suffix: '', format: 'openai' }]));
    // three older days already on disk, as if the gateway had been running for a while
    const old = new AuditLog(path.join(dir, 'audit')), now = Date.now();
    fill(old, 12, now - 3 * DAY_MS, 1000, { tool: 'Old A' }); fill(old, 12, now - 2 * DAY_MS, 1000, { tool: 'Old B' }); fill(old, 12, now - 40 * DAY_MS, 1000, { tool: 'Ancient' });
    await startServer({ PROMPTHOLE_MAX_EVENTS: '100' });
  });
  after(async () => { if (child && child.exitCode === null) await stopServer(); upstream?.close(); });

  test('older days on disk are served, with paging, without ever being in the recent window', async () => {
    const all = await j('/api/audit?size=500');
    assert.equal(all.body.total, 36); assert.equal(all.body.days, 3);
    const win = await j('/api/events?limit=500'); assert.equal(win.body.length, 0, 'the recent window starts empty; the audit trail has the history');
    const p2 = await j('/api/audit?size=10&page=2'); assert.equal(p2.body.items.length, 10); assert.equal(p2.body.pages, 4);
    const range = await j(`/api/audit?size=500&from=${Date.now() - 2.5 * DAY_MS}&to=${Date.now() - 1.5 * DAY_MS}`); assert.equal(range.body.total, 12); assert.ok(range.body.items.every((x) => x.tool === 'Old B'));
  });
  test('requests through the gateway are recorded in both places; a full record can be fetched for any of them', async () => {
    for (let i = 0; i < 130; i++) assert.equal((await chat('hello ' + i)).status, 200);
    assert.ok(await until(async () => (await j('/api/audit?size=1&from=' + (Date.now() - DAY_MS))).body.total >= 130), 'all 130 were recorded');
    const all = await j('/api/audit?size=500&from=' + (Date.now() - DAY_MS));
    assert.equal(all.body.total, 130); assert.equal((await j('/api/events?limit=500')).body.length, 100, 'window capped by PROMPTHOLE_MAX_EVENTS');
    const oldest = all.body.items.at(-1), newest = all.body.items[0];
    const full = await j(`/api/event?id=${oldest.id}&ts=${oldest.ts}`); assert.equal(full.status, 200); assert.equal(full.body.id, oldest.id); assert.ok(full.body.headers, 'headers come with the full record');
    assert.equal((await j(`/api/event?id=${newest.id}`)).status, 200, 'recent ones need no timestamp');
    assert.equal((await j(`/api/event?id=${oldest.id}`)).status, 200, 'and old ones are found without it, just slower');
    assert.equal((await j('/api/event?id=does-not-exist&ts=1')).status, 404);
    assert.equal((await j('/api/event?id=..%2f..%2fx')).status, 404);
  });
  test('filters and search work on the whole history; bad query values are ignored, not errors', async () => {
    assert.equal((await j('/api/audit?tool=Old%20A&size=500')).body.total, 12);
    assert.equal((await j('/api/audit?q=ancient&size=500')).body.total, 12);
    assert.equal((await j('/api/audit?action=blocked')).body.total, 0);
    const odd = await j('/api/audit?from=abc&to=&page=zzz&size=-3'); assert.equal(odd.status, 200); assert.ok(odd.body.total >= 36); assert.equal(odd.body.page, 1);
  });
  test('the list can be polled cheaply: unchanged answers are "not modified", new requests change the tag', async () => {
    const first = await j('/api/audit?size=5'), again = await fetch(base + '/api/audit?size=5', { headers: { 'if-none-match': first.tag } });
    assert.equal(again.status, 304);
    await chat('one more');
    const next = await fetch(base + '/api/audit?size=5', { headers: { 'if-none-match': first.tag } }); assert.equal(next.status, 200);
  });
  test('the storage summary lists days and size', async () => {
    const d = await j('/api/audit/days');
    assert.ok(d.body.days.length >= 4 && d.body.bytes > 0 && d.body.retentionDays === 0); assert.ok(d.body.days.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)));
    assert.equal((await fetch(base + '/api/audit/days', { headers: { 'if-none-match': d.tag } })).status, 304);
  });
  test('saved matched text can be purged from the audit files too', async () => {
    const AWS = 'AKIAIOSFODNN7EXAMPLE';
    await fetch(base + '/api/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'aws', name: 'AWS key', type: 'regex', pattern: 'AKIA[0-9A-Z]{16}', mode: 'mask', enabled: true }]) });
    await chat(`my key is ${AWS}`);
    const file = path.join(dir, 'audit', dayOf(Date.now()) + '.jsonl');
    assert.ok(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(AWS)), 'matched text is stored while that option is on');
    const hit = (await j('/api/audit?q=aws&size=1')).body.items[0];
    assert.ok(JSON.stringify((await j(`/api/event?id=${hit.id}&ts=${hit.ts}`)).body).includes(AWS));
    assert.ok((await j('/api/settings/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).body.purged >= 1);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(AWS), 'gone from the audit file as well');
    assert.ok(!JSON.stringify((await j(`/api/event?id=${hit.id}&ts=${hit.ts}`)).body).includes(AWS));
    assert.equal((await j('/api/audit?q=aws&size=1')).body.total, 1, 'the record itself stays');
  });
  test('a rules file with odd group names previews correctly, and a model called "constructor" shows up in the statistics', async () => {
    const names = ['__proto__', 'constructor', 'toString'];
    const text = 'rules:\n' + names.map((n, i) => `  - name: odd${i}\n    group: ${n}\n    match: exact\n    pattern: odd-pattern-${i}\n`).join('');
    const pv = (await j('/api/toolrules/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'text', text }) })).body;
    assert.equal(pv.total, 3); assert.deepEqual(Object.keys(pv.groups).sort(), [...names].sort()); assert.ok(names.every((n) => pv.groups[n].total === 1 && pv.groups[n].fresh === 1));
    const again = (await j('/api/toolrules/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'text', text: 'rules:\n  - name: x\n    match: exact\n    pattern: some-other\n' }) })).body;
    assert.equal(again.groups.Other.total, 1, 'an earlier preview left nothing behind that changes later answers');
    await fetch(`${base}/up/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'constructor/1' }, body: JSON.stringify({ model: 'constructor', messages: [{ role: 'user', content: 'hi' }] }) }).then((r) => r.arrayBuffer());
    assert.ok(await until(async () => Number((await j('/api/stats')).body.models?.constructor) >= 1));
    const st = (await j('/api/stats')).body; assert.equal(typeof st.models.constructor, 'number'); assert.equal(typeof st.tools.constructor, 'number');
  });
  test('history survives a restart; a retention limit removes old days at start', async () => {
    const before = (await j('/api/audit?size=1')).body.total;
    await stopServer(); await startServer({ PROMPTHOLE_MAX_EVENTS: '100' });
    assert.equal((await j('/api/audit?size=1')).body.total, before);
    await stopServer(); await startServer({ PROMPTHOLE_AUDIT_DAYS: '30' });
    const d = await j('/api/audit/days'); assert.equal(d.body.retentionDays, 30);
    assert.ok(!d.body.days.some((x) => x.date === dayOf(Date.now() - 40 * DAY_MS)), 'the 40-day-old file is gone');
    assert.equal((await j('/api/audit?q=ancient')).body.total, 0);
    assert.equal((await j('/api/audit?q=old%20a&size=500')).body.total, 12, 'newer days are untouched');
  });
});

describe('names that come from the network are only names', () => {
  const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];
  test('statistics count models, tools, rules and tokens under any name, without touching Object.prototype', () => {
    const e = (name) => ({ id: name, ts: Date.now(), tool: name, provider: name, model: name, action: 'allowed', hits: [{ name, count: 2 }], tokens: { in: 5, out: 1 }, calls: [{ action: 'flagged', rule: name }, { action: 'blocked', rule: name }] });
    const events = NAMES.flatMap((n) => [e(n), e(n)]), s = stats(events), c = toolRuleCounts(events);
    for (const n of NAMES) {
      assert.equal(s.models[n], 2, n); assert.equal(s.tools[n], 2, n); assert.equal(s.providers[n], 2, n); assert.equal(s.rules[n], 4, n);
      assert.equal(s.tokensByModel[n], 12, n); assert.equal(s.tokensByTool[n], 12, n); assert.deepEqual(c[n], { blocked: 2, flagged: 2 }, n);
    }
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(s.models))).sort(), [...NAMES].sort(), 'they survive being sent to the dashboard as JSON');
    assert.equal(({}).total, undefined); assert.equal(({}).in, undefined); assert.equal(({}).blocked, undefined);
  });
  test('command files may use any group name', async () => {
    const text = 'rules:\n' + NAMES.map((n, i) => `  - name: r${i}\n    group: ${n}\n    match: exact\n    pattern: p${i}\n`).join('');
    assert.deepEqual((await import('../lib/cmdlib.mjs')).parseCommandRules(text).rules.map((r) => r.group), NAMES);
  });
});

describe('Requests page logic', () => {
  const NOW = new Date(2026, 10, 18, 15, 30, 45).getTime();
  const set = (o) => Object.assign(S, { q: '', action: '', range: '24h', from: '', to: '', page: 1, size: 50 }, o);
  test('presets are relative to now and rounded to the minute (so polling can be answered with "not modified")', () => {
    for (const [r, span] of [['1h', 3600e3], ['24h', 86400e3], ['7d', 7 * 86400e3], ['30d', 30 * 86400e3]]) { set({ range: r }); const b = bounds(NOW); assert.equal(b.to, undefined); assert.equal(b.from % 60000, 0); assert.ok(NOW - span - b.from >= 0 && NOW - span - b.from < 60000, r); }
  });
  test('"today" starts at local midnight, "all" has no bounds', () => {
    set({ range: 'today' }); assert.equal(bounds(NOW).from, new Date(2026, 10, 18).getTime());
    set({ range: 'all' }); assert.deepEqual(bounds(NOW), {});
  });
  test('custom dates cover whole local days, either end optional, and a reversed range is an error', () => {
    set({ range: 'custom', from: '2026-11-10', to: '2026-11-12' });
    assert.deepEqual(bounds(NOW), { from: new Date(2026, 10, 10).getTime(), to: new Date(2026, 10, 12, 23, 59, 59, 999).getTime() });
    set({ range: 'custom', from: '2026-11-10' }); assert.deepEqual(bounds(NOW), { from: new Date(2026, 10, 10).getTime(), to: undefined });
    set({ range: 'custom', to: '2026-11-12' }); assert.equal(bounds(NOW).from, undefined);
    set({ range: 'custom' }); assert.deepEqual(bounds(NOW), { from: undefined, to: undefined });
    set({ range: 'custom', from: '2026-11-12', to: '2026-11-10' }); assert.match(bounds(NOW).error, /after/);
    set({ range: 'custom', from: '2026-11-12', to: '2026-11-12' }); assert.equal(bounds(NOW).error, undefined, 'a single day is fine');
  });
  test('the request URL carries page, size, range and filters', () => {
    set({ page: 3, size: 100, q: 'aws key', action: 'blocked' });
    const q = new URLSearchParams(params({ from: 5, to: 9 })); assert.deepEqual([q.get('page'), q.get('size'), q.get('from'), q.get('to'), q.get('q'), q.get('action'), q.get('calls')], ['3', '100', '5', '9', 'aws key', 'blocked', null]);
    set({ action: 'calls:risky' }); const r = new URLSearchParams(params({})); assert.deepEqual([r.get('calls'), r.get('action'), r.get('from'), r.get('q')], ['risky', null, null, null]);
  });
  test('page buttons: everything for few pages, the ends and the neighbourhood for many', () => {
    assert.deepEqual(pageList(1, 1), [1]); assert.deepEqual(pageList(2, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(pageList(1, 20), [1, 2, 3, '…', 20]); assert.deepEqual(pageList(10, 20), [1, '…', 8, 9, 10, 11, 12, '…', 20]);
    assert.deepEqual(pageList(20, 20), [1, '…', 18, 19, 20]); assert.deepEqual(pageList(4, 20), [1, 2, 3, 4, 5, 6, '…', 20]);
  });
  test('answers that arrive out of order are dropped, so a slow old answer cannot overwrite a newer one', async () => {
    set({}); const waiting = [];
    const api = (url) => new Promise((resolve) => waiting.push({ url, resolve }));
    const load = createLoader(api);
    const first = load(); set({ page: 2 }); const second = load();
    waiting[1].resolve({ items: [], total: 2, page: 2, pages: 2, size: 50 }); waiting[0].resolve({ items: [], total: 1, page: 1, pages: 1, size: 50 });
    assert.equal((await second).data.page, 2); assert.equal(await first, null);
    assert.match(waiting[0].url, /page=1/); assert.match(waiting[1].url, /page=2/);
  });
  test('a failed request shows a message and an empty table, and a stale failure is ignored too', async () => {
    set({}); let fail, calls = 0;
    const load = createLoader(() => (++calls === 1 ? new Promise((_, rej) => { fail = rej; }) : Promise.reject(new Error('HTTP 500'))));
    const old = load(), newer = load();
    fail(new Error('late')); assert.equal(await old, null, 'the late failure of the older request is not shown');
    const r = await newer; assert.match(r.failed, /Could not load requests: HTTP 500/); assert.deepEqual(r.data.items, []); assert.equal(r.data.total, 0);
    assert.equal((await createLoader(async () => ({ items: [1], total: 1, page: 1, pages: 1, size: 50 }))()).failed, '');
  });
  test('a reversed date range is reported without asking the server, and cancels an answer still on its way', async () => {
    set({ range: 'custom', from: '2026-11-12', to: '2026-11-10' }); let called = 0, release;
    const load = createLoader((u) => { called++; return new Promise((r) => { release = r; }); });
    const before = (set({}), load()); set({ range: 'custom', from: '2026-11-12', to: '2026-11-10' });
    const r = await load(); assert.match(r.failed, /after/); assert.equal(called, 1, 'only the first request went out');
    release({ items: [], total: 0, page: 1, pages: 1, size: 50 }); assert.equal(await before, null, 'the slow answer to the older question is not shown');
  });
  test('page buttons: the current page is highlighted, ends are disabled, and every button says where it goes', () => {
    const one = pagerHtml({ page: 1, pages: 5 }); assert.match(one, /data-p="0" disabled/); assert.match(one, /class="btn p" data-p="1"/); assert.doesNotMatch(one, /data-p="6" disabled/); assert.match(one, /data-p="2" >Next|data-p="2" >/);
    const last = pagerHtml({ page: 5, pages: 5 }); assert.match(last, /data-p="6" disabled/); assert.match(last, /class="btn p" data-p="5"/); assert.match(pagerHtml({ page: 10, pages: 20 }), /…/);
  });
  test('count text, empty text and storage summary', () => {
    assert.equal(countText({ items: new Array(50), total: 1234, page: 2, size: 50 }), '51–100 of 1,234'); assert.equal(countText({ items: [], total: 0, page: 1, size: 50 }), '');
    assert.equal(countText({ items: new Array(3), total: 53, page: 2, size: 50 }), '51–53 of 53');
    set({}); assert.match(emptyText(), /widen it/); set({ q: 'x' }); assert.match(emptyText(), /match these filters/); set({ action: 'blocked' }); assert.match(emptyText(), /match these filters/);
    assert.equal(storageText({ days: [], bytes: 0 }), '');
    assert.match(storageText({ days: [{ date: '2026-11-01' }], bytes: 100, retentionDays: 0 }), /1 day \(2026-11-01 to 2026-11-01\), <1 MB\. Nothing is deleted/);
    assert.match(storageText({ days: [{ date: '2026-11-01' }, { date: '2026-11-18' }], bytes: 5 * 1048576, retentionDays: 90 }), /2 days \(2026-11-01 to 2026-11-18\), 5\.0 MB\. Days older than 90 are deleted/);
    assert.match(storageText({ days: [{ date: 'a' }], bytes: 250 * 1048576, retentionDays: 0 }), /250 MB/);
  });
  test('time column: just the time today, the date as well for older rows', () => {
    const now = new Date(2026, 10, 18, 15, 0, 0);
    assert.equal(when(new Date(2026, 10, 18, 9, 5, 7).getTime(), now), new Date(2026, 10, 18, 9, 5, 7).toLocaleTimeString());
    assert.match(when(new Date(2026, 10, 10, 9, 5, 7).getTime(), now), /, /); assert.notEqual(when(new Date(2026, 10, 10, 9, 5, 7).getTime(), now), new Date(2026, 10, 10, 9, 5, 7).toLocaleTimeString());
    assert.ok(when(Date.now()).length > 0);
  });
  test('rows are built safely: names from the network are escaped, missing values show a dash', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = rowHtml({ id: '"><script>', ts: Date.now(), tool: evil, model: evil, action: 'allowed', hits: [{ name: evil, count: 2 }], status: 200, ms: 3, bytes: 2048, tokens: { in: 1500, out: 20 } });
    assert.ok(!html.includes('<script>') && !html.includes('<img src=x'), html); assert.match(html, /&lt;img src=x/);
    assert.match(html, /1\.5k \/ 20/); assert.match(html, /2\.0 KB/); assert.match(html, /s-ok/);
    const bare = rowHtml({ id: 'a', ts: 1, tool: 't', model: null, action: 'blocked', hits: [], status: 0, ms: 1, bytes: 0, blockedCalls: 2 });
    assert.match(bare, />—<\/td>/); assert.match(bare, /cmd ×2/); assert.match(bare, /s-bad">—/); assert.match(bare, /<span class="faint">—<\/span>/);
    assert.equal(rowHtml({ id: 'a', ts: 1, tool: 't', action: 'x', hits: [], status: 200, ms: 1, bytes: 1 }).includes('Claude'), false);
  });
  test('small helpers for the detail drawer', () => {
    assert.deepEqual(['block', 'mask', 'log', 'whatever'].map(pillFor), ['blocked', 'masked', 'logged', 'logged']);
    assert.match(tokenLine(null), /not reported/); assert.equal(tokenLine({ in: 10, out: 5 }), '10 in · 5 out');
    assert.equal(tokenLine({ in: 10, out: 5, cacheRead: 3, cacheWrite: 2, reasoning: 4 }), '10 in (3 read from cache, 2 written to cache) · 5 out (4 reasoning)');
    assert.equal(tokenLine({ in: 10, out: 5, cacheRead: 3 }), '10 in (3 read from cache) · 5 out');
    assert.equal(matched({ hits: [] }), '<span class="faint">—</span>'); assert.match(matched({ hits: [{ name: 'a', count: 1 }, { name: 'b', count: 3 }] }), /a <span class="faint">×1<\/span>, b <span class="faint">×3/);
    assert.deepEqual(empty(), { items: [], total: 0, page: 1, pages: 1, size: S.size });
  });
});
