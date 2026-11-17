import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goToJs, tryCompile, parseGitleaks, parseSecretsDb, parseList, parseEnv, groupFor, SOURCES } from '../lib/rulelib.mjs';
import { scanValue, shannon, compile, validRules } from '../lib/core.mjs';

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/gitleaks.sample.toml'), 'utf8');
const body = (n, seed = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ-_xR2cF4hJ6lN8pS0uW2yA4') => Array.from({ length: n }, (_, i) => seed[i % seed.length]).join('');
const ANTHROPIC = 'sk-ant-api03-' + body(93) + 'AA';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const on = (rules, mode = 'log') => rules.map((r) => ({ ...r, mode, enabled: true }));

describe('goToJs (Go RE2 -> JavaScript)', () => {
  test('leading inline flags become real flags', () => {
    assert.deepEqual(goToJs('(?i)abc'), { pattern: 'abc', flags: 'i', converted: false });
    assert.equal(goToJs('(?is)abc').flags, 'is');
  });
  test('scoped / mid-pattern flags are unwrapped and flagged as converted', () => {
    const a = goToJs('\\b(hf_(?i:[a-z]{34}))');
    assert.equal(a.pattern, '\\b(hf_(?:[a-z]{34}))'); assert.equal(a.flags, 'i'); assert.equal(a.converted, true);
    const b = goToJs('p8e-(?i)[a-z0-9]{32}');
    assert.equal(b.pattern, 'p8e-[a-z0-9]{32}'); assert.equal(b.flags, 'i');
    const c = goToJs('(?i:x)(?-i:ABC)');
    assert.equal(c.pattern, '(?:x)(?:ABC)'); assert.equal(c.converted, true);
  });
  test('(?s:.) becomes an any-char class', () => assert.equal(goToJs('a(?s:.){0,5}b').pattern, 'a[\\s\\S]{0,5}b'));
  test('named groups, \\z and \\A are translated', () => {
    assert.equal(goToJs('(?P<k>a)\\z').pattern, '(?<k>a)$');
    assert.equal(goToJs('\\Aabc').pattern, '^abc');
  });
  test('lookaround and non-capturing groups are left alone', () => {
    const p = '(?:a)(?=b)(?!c)(?<=d)(?<!e)(?<n>f)';
    assert.equal(goToJs(p).pattern, p); assert.equal(goToJs(p).converted, false);
  });
});

describe('tryCompile', () => {
  test('compiles valid patterns', () => assert.ok(tryCompile('a+', 'i').re instanceof RegExp));
  test('reports invalid patterns without throwing', () => assert.match(tryCompile('([').error, /./));
  test('rejects patterns that match the empty string (they would flag everything)', () => assert.match(tryCompile('a*').error, /empty/));
});

describe('parseGitleaks (real excerpt)', () => {
  const { rules, skipped } = parseGitleaks(fixture);
  const by = Object.fromEntries(rules.map((r) => [r.id, r]));
  test('imports every rule that has a content regex, skips the path-only one with a reason', () => {
    assert.equal(rules.length, 7);
    assert.deepEqual(skipped.map((s) => s.id), ['pkcs12-file']);
    assert.match(skipped[0].reason, /path/);
  });
  test('global [allowlist] and [[rules.allowlists]] tables are not mistaken for rules', () => {
    assert.ok(rules.every((r) => r.id.startsWith('gl:')));
    assert.ok(!rules.some((r) => /allow/i.test(r.id)));
  });
  test('carries over entropy, secretGroup, lower-cased keywords (incl. multi-line arrays)', () => {
    assert.equal(by['gl:sonar-api-token'].secretGroup, 2);
    assert.ok(by['gl:generic-api-key'].entropy > 0);
    assert.ok(by['gl:generic-api-key'].keywords.length > 3, 'multi-line keywords array parsed');
    assert.ok(Object.values(by).every((r) => r.keywords.every((k) => k === k.toLowerCase())));
  });
  test('rules that needed adaptation are marked', () => {
    assert.equal(by['gl:huggingface-access-token'].approx, true);
    assert.equal(by['gl:huggingface-access-token'].flags, 'i');
    assert.equal(by['gl:aws-access-token'].approx, undefined);
  });
  test('groups, names and defaults', () => {
    assert.equal(by['gl:anthropic-api-key'].group, 'AI & ML');
    assert.equal(by['gl:aws-access-token'].group, 'Cloud & infra');
    assert.equal(by['gl:aws-access-token'].name, 'Aws access token');
    assert.equal(by['gl:aws-access-token'].source, 'gitleaks');
    assert.equal(by['gl:aws-access-token'].mode, undefined, 'mode is chosen at import time');
  });
  test('detects real-format secrets and ignores ordinary text', () => {
    const r = on(rules);
    assert.equal(scanValue(r, `k=${ANTHROPIC}`).hits[0].id, 'gl:anthropic-api-key');
    assert.equal(scanValue(r, `k=${AWS}`).hits[0].id, 'gl:aws-access-token');
    assert.equal(scanValue(r, 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh').hits[0].id, 'gl:huggingface-access-token');
    assert.equal(scanValue(r, 'The quick brown fox writes a README about tokens and passwords.').hits.length, 0);
  });
  test('a key of the wrong length is not an Anthropic key', () => {
    assert.equal(scanValue(on(rules), 'sk-ant-api03-' + body(60) + 'AA').hits.length, 0);
  });
  test('entropy gate: random value after "api_key" is caught, a repetitive one is not', () => {
    const r = on(rules).filter((x) => x.id === 'gl:generic-api-key');
    assert.equal(scanValue(r, 'api_key = "x9Kd82Lm4Qz7Vb3Nc6Rt1Wy5Hp0Jf2G"').hits.length, 1);
    assert.equal(scanValue(r, 'api_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"').hits.length, 0);
  });
  test('secretGroup entropy: judged on the captured value, not the whole match', () => {
    const r = on(rules).filter((x) => x.id === 'gl:sonar-api-token');
    const tok = 'squ_' + body(40, 'a1b2c3d4e5f6g7h8i9j0kLmNoPqRsTuVwXyZ');
    assert.equal(scanValue(r, `sonar_token = "${tok.slice(0, 44)}"`).hits.length, 1);
  });
});

describe('scanValue: keywords, entropy and flags on rules', () => {
  const R = (o) => ({ id: 'x', name: 'X', type: 'regex', mode: 'log', enabled: true, ...o });
  test('keywords pre-filter: the regex only runs when a keyword is present', () => {
    const r = [R({ pattern: '[A-Z]{5}', keywords: ['zzz'] })];
    assert.equal(scanValue(r, 'ABCDE').hits.length, 0);
    assert.equal(scanValue(r, 'zzz ABCDE').hits.length, 1);
    assert.equal(scanValue(r, 'ZZZ ABCDE').hits.length, 1, 'keywords are case-insensitive');
  });
  test('entropy threshold applies to the match', () => {
    const r = [R({ pattern: '[a-z0-9]{12}', entropy: 3 })];
    assert.equal(scanValue(r, 'aaaaaaaaaaaa').hits.length, 0);
    assert.equal(scanValue(r, 'a1b2c3d4e5f6').hits.length, 1);
  });
  test('low-entropy matches are left untouched in mask mode', () => {
    const r = [R({ pattern: '[a-z0-9]{12}', entropy: 3, mode: 'mask' })];
    assert.equal(scanValue(r, 'x aaaaaaaaaaaa y').value, 'x aaaaaaaaaaaa y');
  });
  test('flags are honoured and sanitised', () => {
    assert.equal(scanValue([R({ pattern: 'abc', flags: 'i' })], 'xxABCxx').hits.length, 1);
    assert.equal(scanValue([R({ pattern: 'abc', flags: 'g;x' })], 'abc').hits.length, 1);
  });
  test('compiled regexes are cached per (type, flags, pattern)', () => {
    const a = compile(R({ pattern: 'cache-me' })), b = compile(R({ id: 'other', pattern: 'cache-me' }));
    assert.equal(a, b);
    assert.notEqual(compile(R({ pattern: 'cache-me', flags: 'i' })), a);
    assert.notEqual(compile(R({ type: 'keyword', pattern: 'cache-me' })), a);
  });
  test('a bad pattern returns null and is cached too', () => { assert.equal(compile(R({ pattern: '([' })), null); assert.equal(compile(R({ pattern: '([' })), null); });
});

describe('shannon', () => {
  test('empty and uniform strings score 0, random-looking strings score high', () => {
    assert.equal(shannon(''), 0);
    assert.equal(shannon('aaaa'), 0);
    assert.ok(shannon('a1B2c3D4e5F6g7H8') > 3.5);
  });
});

describe('parseSecretsDb', () => {
  const yml = `patterns:
  - pattern:
      name: AWS API Key
      regex: AKIA[0-9A-Z]{16}
      confidence: high
  - pattern:
      name: Noisy Host
      regex: "[0-9a-z]+.execute-api.[0-9a-z._-]+.amazonaws.com"
      confidence: low
  - pattern:
      name: Quoted \\d
      regex: "tok_\\\\d{8}"
      confidence: high
  - pattern:
      name: AWS API Key
      regex: 'ASIA[0-9A-Z]{16}'
      confidence: high
  - pattern:
      name: Broken
      regex: "(["
      confidence: high
  - pattern:
      name: Nothing
      confidence: high
`;
  test('keeps only high confidence by default', () => {
    const { rules } = parseSecretsDb(yml);
    assert.deepEqual(rules.map((r) => r.name), ['AWS API Key', 'Quoted \\d', 'AWS API Key']);
  });
  test('"all" includes low confidence', () => assert.equal(parseSecretsDb(yml, { minConfidence: 'all' }).rules.length, 4));
  test('duplicate names get unique ids; ids are prefixed', () => {
    const ids = parseSecretsDb(yml).rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((i) => i.startsWith('sp:')));
    assert.deepEqual(ids.slice(0, 1), ['sp:aws-api-key']);
  });
  test('YAML quoting is decoded; single quotes work', () => {
    const { rules } = parseSecretsDb(yml);
    assert.equal(rules[1].pattern, 'tok_\\d{8}');
    assert.equal(rules[2].pattern, 'ASIA[0-9A-Z]{16}');
  });
  test('broken and regex-less entries are reported, not imported', () => {
    const { skipped } = parseSecretsDb(yml);
    assert.deepEqual(skipped.map((s) => s.id).sort(), ['Broken', 'Nothing']);
  });
  test('imported rules actually detect', () => {
    assert.equal(scanValue(on(parseSecretsDb(yml).rules), `k ${AWS}`).hits.length, 1);
  });
});

describe('parseList', () => {
  const { rules, skipped } = parseList('# comment\n\nProject Falcon\n  Project Falcon  \nre:internal-[a-z]{4}-\\d+\nre:([\nre:\nhunter2');
  test('keywords and regexes, comments/blank/duplicates ignored', () => {
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map((r) => r.type), ['keyword', 'regex', 'keyword']);
  });
  test('invalid regex is reported', () => assert.equal(skipped.length, 1));
  test('keywords are flagged secret so the UI hides them; names never contain the value', () => {
    assert.equal(rules[0].secret, true); assert.equal(rules[1].secret, false);
    assert.ok(rules.every((r) => !r.name.includes('Falcon') && !r.name.includes('hunter2')));
  });
  test('ids are stable for the same text (re-import updates instead of duplicating)', () => {
    assert.equal(parseList('Project Falcon').rules[0].id, rules[0].id);
  });
  test('the keyword rule masks case-insensitively', () => {
    assert.equal(scanValue(on(rules, 'mask'), 'about project FALCON today').hits.length, 1);
  });
});

// built at runtime so no key-shaped literal sits in the repository (secret scanners would flag it)
const FAKE_STRIPE = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');

describe('parseEnv', () => {
  const env = `# app
NODE_ENV=production
PORT=3000
HOST=localhost
DEBUG=true
SHORT_SECRET=abc
export DB_PASSWORD="s3cr3t-Passw0rd!"
STRIPE_KEY='${FAKE_STRIPE}'
API_URL=https://localhost:8080/v1
SOME_RANDOM=Xk29dLq0PzR7vN3mTb8Ws4Yh
INNOCENT_NAME=just a sentence about nothing in particular
TOKEN=abcd1234efgh5678 # inline comment
DUP=abcd1234efgh5678
`;
  const { rules, skipped } = parseEnv(env);
  test('imports secret-looking values only', () => {
    assert.deepEqual(rules.map((r) => r.name).sort(), ['.env DB_PASSWORD', '.env SOME_RANDOM', '.env STRIPE_KEY', '.env TOKEN']);
  });
  test('skips short, boring and non-secret values with a reason', () => {
    const ids = skipped.map((s) => s.id);
    for (const k of ['NODE_ENV', 'PORT', 'HOST', 'DEBUG', 'SHORT_SECRET', 'API_URL', 'INNOCENT_NAME']) assert.ok(ids.includes(k), k);
  });
  test('quotes, export prefix and inline comments are handled', () => {
    const pats = rules.map((r) => r.pattern);
    assert.ok(pats.includes('s3cr3t-Passw0rd!')); assert.ok(pats.includes(FAKE_STRIPE)); assert.ok(pats.includes('abcd1234efgh5678'));
  });
  test('identical values are deduplicated', () => assert.equal(rules.filter((r) => r.pattern === 'abcd1234efgh5678').length, 1));
  test('rules are exact-match keywords marked secret; rule names never include the value', () => {
    assert.ok(rules.every((r) => r.type === 'keyword' && r.secret && r.group === '.env values' && !r.name.includes(r.pattern)));
  });
  test('values with regex metacharacters match literally', () => {
    assert.equal(scanValue(on(rules, 'mask'), 'pw is s3cr3t-Passw0rd! ok').hits.length, 1);
    assert.equal(scanValue(on(rules, 'mask'), 'pw is s3cr3t-Passw0rdX ok').hits.length, 0);
  });
});

describe('groupFor / SOURCES', () => {
  test('groups', () => {
    assert.equal(groupFor('anthropic-api-key'), 'AI & ML');
    assert.equal(groupFor('github-pat'), 'Source & CI');
    assert.equal(groupFor('stripe-access-token'), 'Payments');
    assert.equal(groupFor('slack-bot-token'), 'Messaging & SaaS');
    assert.equal(groupFor('zzz-unknown'), 'Other');
  });
  test('every source has a label and parser', () => {
    for (const s of ['gitleaks', 'secrets-db', 'list', 'env']) { assert.ok(SOURCES[s].label); assert.equal(typeof SOURCES[s].parse, 'function'); }
  });
});

describe('validRules', () => {
  const ok = { id: 'a', name: 'A', type: 'regex', pattern: 'x', mode: 'log', enabled: true };
  test('accepts valid', () => assert.equal(validRules([ok, { ...ok, id: 'b', type: 'keyword', pattern: '(' }]), null));
  test('rejects each kind of problem with a readable message', () => {
    assert.match(validRules({}), /list/);
    assert.match(validRules([null]), /object/);
    assert.match(validRules([{ ...ok, id: '' }]), /id/);
    assert.match(validRules([ok, ok]), /duplicate/);
    assert.match(validRules([{ ...ok, type: 'glob' }]), /type/);
    assert.match(validRules([{ ...ok, pattern: '' }]), /pattern/);
    assert.match(validRules([{ ...ok, mode: 'nuke' }]), /mode/);
    assert.match(validRules([{ ...ok, pattern: '([' }]), /invalid regex/);
  });
});

describe('parseGitleaks: other TOML spellings', () => {
  const toml = `# top comment
[[rules]]
id = "multi-line"
description = "regex spread over lines"   # trailing comment
regex = '''abc_
[0-9]{4}'''
keywords = ["abc_"]  # inline comment

[[rules]]
id = 'single-quoted'
description = 'it''s fine'
regex = """tok_[a-z]{6}"""
entropy = 2.5
keywords = [ 'tok_', "TOK_" ]
secretGroup = 0

[[rules]]
id = "escaped \\"quote\\""
regex = "esc_\\\\d{4}"

[[rules]]
id = "bad"
regex = "(["

[[rules]]
regex = "no-id"
`;
  const { rules, skipped } = parseGitleaks(toml);
  const by = Object.fromEntries(rules.map((r) => [r.id, r]));
  test('multi-line triple-quoted regex values', () => {
    assert.equal(by['gl:multi-line'].pattern, 'abc_\n[0-9]{4}');
  });
  test('single-quoted keys, triple double quotes, numbers and mixed-quote arrays', () => {
    const r = by['gl:single-quoted'];
    assert.equal(r.pattern, 'tok_[a-z]{6}'); assert.equal(r.entropy, 2.5);
    assert.deepEqual(r.keywords, ['tok_']);
  });
  test('basic strings with escapes', () => assert.equal(by['gl:escaped "quote"'].pattern, 'esc_\\d{4}'));
  test('uncompilable rules are reported, rules without an id are ignored', () => {
    assert.deepEqual(skipped.map((s) => s.id), ['bad']);
    assert.equal(rules.length, 3);
  });
  test('an unterminated triple-quoted string does not hang or crash', () => {
    assert.doesNotThrow(() => parseGitleaks("[[rules]]\nid = \"x\"\nregex = '''never closed\nmore"));
  });
});
