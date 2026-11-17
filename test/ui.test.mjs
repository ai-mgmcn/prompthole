// Static checks on the dashboard: modules must compile and reference only elements that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(path.join(pub, 'js')).filter((f) => f.endsWith('.js'));
const sources = files.map((f) => [path.relative(pub, f), fs.readFileSync(f, 'utf8')]);

test('every dashboard module parses as an ES module', () => {
  assert.ok(sources.length >= 10);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); // package.json "type": "module"
    assert.equal(r.status, 0, `${path.relative(pub, f)}: ${r.stderr}`);
  }
});

test('every static $("#id") lookup has a matching element', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, src] of sources) for (const m of src.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) ids.add(m[1]); // rendered by a page
  const used = sources.flatMap(([, src]) => [...src.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(used)].filter((i) => !ids.has(i)), []);
});

test('imports resolve to existing files', () => {
  for (const [name, src] of sources) {
    for (const m of src.matchAll(/from '(\.[^']+)'/g)) {
      assert.ok(fs.existsSync(path.resolve(pub, path.dirname(name), m[1])), `${name} → ${m[1]}`);
    }
  }
});

test('every nav tab has a section and a page module', () => {
  const tabs = new Set([...html.matchAll(/data-t="(\w+)"/g)].map((m) => m[1]));
  assert.ok(tabs.has('commands'));
  for (const t of tabs) {
    assert.ok(html.includes(`<section id="${t}"`), `section ${t}`);
    assert.ok(sources.some(([, s]) => s.includes(`id: '${t}'`)), `page ${t}`);
  }
});

test('the page loads one module script and one stylesheet, no inline code', () => {
  assert.match(html, /<script type="module" src="\/js\/main\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/);
  assert.doesNotMatch(html, /<script>/);
});

test('no remote assets (works offline, nothing leaves the machine)', () => {
  assert.doesNotMatch(html, /(src|href)=["']https?:/i);
  for (const [name, src] of sources) assert.doesNotMatch(src, /import[^\n]*from 'https?:/, name);
});
