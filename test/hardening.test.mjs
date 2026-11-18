// Small limits found in review: caches that must stay bounded, counts that must be right, files that must not bring in unlimited rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vetPatterns, verdictCount } from '../src/vet.mjs';
import { createStore } from '../src/store.mjs';
import { parseCommandRules, MAX_RULES } from '../lib/cmdlib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the regex safety cache stays bounded, and unsafe patterns are still found after it is emptied', async () => {
  for (let batch = 0; batch < 11; batch++) {
    const patterns = Array.from({ length: 2000 }, (_, i) => ({ pattern: `one-off-${batch}-${i}` }));
    assert.equal((await vetPatterns(patterns)).size, 0);
    assert.ok(verdictCount() <= 20_000, `cache holds ${verdictCount()} verdicts`);
  }
  assert.ok(verdictCount() < 20_000, 'it was emptied once it reached the limit');
  const bad = await vetPatterns([{ pattern: 'fine' }, { pattern: '(a+)+$' }]);
  assert.deepEqual([...bad], [1]);
  assert.deepEqual([...await vetPatterns([{ pattern: 'fine' }, { pattern: '(a+)+$' }])], [1], 'the same answer when it comes from the cache');
});

test('purging matched text reports each event once, not once for the recent window and once for the audit file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-hard-')), store = createStore({ dataDir: dir, root: ROOT, maxEvents: 100 }); store.stop();
  const m = (t) => ({ name: 'k', mode: 'mask', count: 1, sample: 's', matches: [{ text: t }] });
  for (let i = 0; i < 3; i++) store.events.record({ id: `p${i}`, ts: Date.now() + i, tool: 't', provider: 'p', path: '/x', model: 'm', action: 'masked', status: 200, ms: 1, bytes: 1, hits: [m('secret' + i)] });
  assert.equal(store.events.purgeMatchedText(), 3);
  assert.equal(store.events.purgeMatchedText(), 0);
  assert.ok(!JSON.stringify(store.events.list).includes('secret')); assert.ok(!fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('secret'));
  for (const f of fs.readdirSync(path.join(dir, 'audit'))) assert.ok(!fs.readFileSync(path.join(dir, 'audit', f), 'utf8').includes('secret'));
});

test('if the audit files cannot be purged, the recent window is still cleaned and its count is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-hard-')), store = createStore({ dataDir: dir, root: ROOT, maxEvents: 100 }); store.stop();
  store.events.record({ id: 'q', ts: Date.now(), tool: 't', provider: 'p', path: '/x', model: 'm', action: 'masked', status: 200, ms: 1, bytes: 1, hits: [{ name: 'k', mode: 'mask', count: 1, sample: 's', matches: [{ text: 'secret' }] }] });
  store.audit.purgeMatchedText = () => { throw new Error('read-only disk'); };
  assert.equal(store.events.purgeMatchedText(), 1);
  assert.ok(!JSON.stringify(store.events.list).includes('secret'));
});

test('one command-rules file never brings in more than the limit, and says so', () => {
  const many = Array.from({ length: MAX_RULES + 500 }, (_, i) => ({ name: `r${i}`, match: 'exact', pattern: `cmd-${i}` }));
  const r = parseCommandRules(JSON.stringify(many));
  assert.equal(r.rules.length, MAX_RULES); assert.equal(r.skipped.length, 1); assert.match(r.skipped[0].reason, new RegExp(`first ${MAX_RULES}`));
  const exact = parseCommandRules(JSON.stringify(many.slice(0, MAX_RULES))); assert.equal(exact.rules.length, MAX_RULES); assert.equal(exact.skipped.length, 0, 'a file of exactly the limit is complete');
  const yaml = parseCommandRules('rules:\n' + many.map((x) => `  - name: ${x.name}\n    match: exact\n    pattern: ${x.pattern}\n`).join(''));
  assert.equal(yaml.rules.length, MAX_RULES);
});
