// Parsers that turn third-party rule libraries / user lists into PromptHole rules. Pure functions, no I/O.
//   gitleaks   : gitleaks.toml  (MIT)            https://github.com/gitleaks/gitleaks
//   secrets-db : rules-stable.yml (CC-BY-SA-4.0) https://github.com/mazen160/secrets-patterns-db
//   list / env : text the user pastes
import crypto from 'node:crypto';
import { shannon } from './core.mjs';

const h8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

// ---------- grouping (used by the UI to fold hundreds of rules into a few sections) ----------
const GROUPS = [
  ['AI & ML', /anthropic|openai|huggingface|cohere|perplexity|groq|replicate|mistral|gemini|deepseek|xai|langsmith|langfuse|openrouter|together|wandb|weights/i],
  ['Cloud & infra', /aws|amazon|azure|gcp|google|alibaba|digitalocean|heroku|cloudflare|fastly|linode|ibm|oracle|scaleway|vultr|tencent|hetzner|netlify|vercel|supabase|planetscale|doppler|vault|terraform|pulumi|kubernetes|k8s|docker|artifactory|jfrog|fly|render|firebase|cloud/i],
  ['Source & CI', /github|gitlab|bitbucket|gitea|gitee|sourcegraph|circleci|travis|jenkins|buildkite|codecov|sonar|snyk|npm|pypi|rubygems|nuget|maven|sentry|datadog|newrelic|grafana|pagerduty|launchdarkly|postman/i],
  ['Payments', /stripe|paypal|square|braintree|adyen|shopify|plaid|coinbase|razorpay|flutterwave|checkout|paddle|klarna|payment|bank|credit|card/i],
  ['Messaging & SaaS', /slack|discord|twilio|telegram|sendgrid|mailchimp|mailgun|postmark|zendesk|intercom|hubspot|salesforce|notion|airtable|asana|atlassian|jira|confluence|trello|linear|figma|dropbox|zoom|okta|auth0|twitter|facebook|linkedin|instagram|youtube|twitch|pinterest|reddit/i],
  ['Keys & credentials', /private[-_ ]?key|pgp|ssh|rsa|jwt|bearer|password|passwd|secret|token|credential|certificate|pkcs|age-|basic[-_ ]?auth|api[-_ ]?key|generic/i],
];
export const groupFor = (idOrName) => (GROUPS.find(([, re]) => re.test(idOrName)) || ['Other'])[0];

const titleFromId = (id) => { const t = id.replace(/[-_]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

// ---------- Go (RE2) regex -> JavaScript ----------
// Handles the differences that actually occur in the Gitleaks file: leading inline flags, (?P<name>, \z, \A.
// JavaScript (Node 22) has no scoped flags, so (?i) / (?-i:..) / (?i:..) in the middle of a pattern cannot be expressed.
// We unwrap them and apply the flag to the whole pattern instead. That can only make a rule slightly broader
// (e.g. a prefix that was case-sensitive now also matches lower case); `converted` lets the UI say so.
export function goToJs(src) {
  let p = src, flags = '', converted = false;
  const add = (f) => { for (const c of f) if ('ims'.includes(c) && !flags.includes(c)) flags += c; };
  const lead = p.match(/^\(\?([imsU]+)\)/);
  if (lead) { p = p.slice(lead[0].length); add(lead[1]); }
  p = p.replace(/\(\?s:\.\)/g, () => { converted = true; return '[\\s\\S]'; }); // "any char incl. newline"
  p = p.replace(/\(\?([imsU-]+)(:|\))/g, (m, f, end) => { converted = true; add(f.split('-')[0]); return end === ':' ? '(?:' : ''; });
  p = p.replace(/\(\?P</g, '(?<').replace(/\\z/g, '$').replace(/\\A/g, '^');
  return { pattern: p, flags, converted };
}
// returns {re} or {error}
export function tryCompile(pattern, flags = '') {
  try {
    const re = new RegExp(pattern, 'g' + flags);
    if (new RegExp(pattern, flags).test('')) return { error: 'matches the empty string' }; // would flag everything
    return { re };
  } catch (e) { return { error: String(e.message).replace(/^Invalid regular expression: /, '').slice(0, 120) }; }
}

// ---------- Gitleaks TOML (just the subset gitleaks.toml uses) ----------
function readValue(lines, i, raw) {
  const v = raw.trim();
  if (v.startsWith("'''") || v.startsWith('"""')) {
    const q = v.slice(0, 3); let body = v.slice(3);
    if (body.includes(q)) return { value: body.slice(0, body.indexOf(q)), next: i };
    const parts = [body];
    while (++i < lines.length) { const l = lines[i]; if (l.includes(q)) { parts.push(l.slice(0, l.indexOf(q))); break; } parts.push(l); }
    return { value: parts.join('\n'), next: i };
  }
  if (v.startsWith('[')) {
    let acc = v;
    while (!/\]\s*(#.*)?$/.test(acc) && ++i < lines.length) acc += '\n' + lines[i];
    return { value: [...acc.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((x) => (x[1] ?? x[2])), next: i };
  }
  if (v.startsWith('"')) { try { return { value: JSON.parse(v.replace(/\s+#.*$/, '')), next: i }; } catch { return { value: v.slice(1, v.lastIndexOf('"')), next: i }; } }
  if (v.startsWith("'")) return { value: v.slice(1, v.lastIndexOf("'")), next: i };
  const n = Number(v.replace(/\s+#.*$/, '')); return { value: Number.isNaN(n) ? v : n, next: i };
}

export function parseGitleaks(text) {
  const lines = text.split(/\r?\n/), blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^\[\[rules\]\]\s*$/.test(line)) { cur = {}; blocks.push(cur); continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; } // [[rules.allowlists]], [allowlist], ... : false-positive filters, not applied
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
    if (!kv || !cur) continue;
    const { value, next } = readValue(lines, i, kv[2]); i = next;
    cur[kv[1]] = value;
  }
  const rules = [], skipped = [];
  for (const b of blocks) {
    const id = b.id;
    if (!id) continue;
    if (!b.regex) { skipped.push({ id, reason: 'matches file paths only (no content regex)' }); continue; }
    const { pattern, flags, converted } = goToJs(b.regex);
    const c = tryCompile(pattern, flags);
    if (c.error) { skipped.push({ id, reason: c.error }); continue; }
    const rule = { id: 'gl:' + id, name: titleFromId(id), desc: b.description || '', type: 'regex', pattern, group: groupFor(id), source: 'gitleaks' };
    if (flags) rule.flags = flags;
    if (converted) rule.approx = true;
    if (Array.isArray(b.keywords) && b.keywords.length) rule.keywords = [...new Set(b.keywords.map((k) => k.toLowerCase()))];
    if (typeof b.entropy === 'number' && b.entropy > 0) rule.entropy = b.entropy;
    if (typeof b.secretGroup === 'number') rule.secretGroup = b.secretGroup;
    rules.push(rule);
  }
  return { rules, skipped };
}

// ---------- secrets-patterns-db YAML (flat structure: patterns -> pattern -> name/regex/confidence) ----------
function yamlScalar(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, v.lastIndexOf('"')); } }
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'")).replace(/''/g, "'");
  return v;
}
export function parseSecretsDb(text, { minConfidence = 'high' } = {}) {
  const entries = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-\s*pattern:\s*$/.test(line)) { cur = {}; entries.push(cur); continue; }
    const kv = line.match(/^\s+(name|regex|confidence):\s*(.*)$/);
    if (kv && cur) cur[kv[1]] = yamlScalar(kv[2]);
  }
  const rules = [], skipped = [], seen = new Map();
  for (const e of entries) {
    const name = e.name || 'unnamed';
    if (!e.regex) { skipped.push({ id: name, reason: 'no regex' }); continue; }
    if (minConfidence === 'high' && e.confidence !== 'high') continue; // filtered by choice, not an error
    const c = tryCompile(e.regex);
    if (c.error) { skipped.push({ id: name, reason: c.error }); continue; }
    const n = (seen.get(name) || 0) + 1; seen.set(name, n);
    rules.push({ id: `sp:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}${n > 1 ? '-' + n : ''}`, name, type: 'regex', pattern: e.regex, group: groupFor(name), source: 'secrets-db' });
  }
  return { rules, skipped };
}

// ---------- user text ----------
// one item per line; "re:" prefix = regex, anything else is a literal (case-insensitive) keyword; "#" starts a comment line
export function parseList(text) {
  const rules = [], skipped = [], seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const isRe = line.startsWith('re:'), pat = isRe ? line.slice(3).trim() : line;
    if (!pat) continue;
    if (isRe) { const c = tryCompile(pat); if (c.error) { skipped.push({ id: pat.slice(0, 40), reason: c.error }); continue; } }
    const id = 'li:' + h8(pat);
    if (seen.has(id)) continue; seen.add(id);
    rules.push({ id, name: isRe ? 'Custom regex' : 'Custom keyword', type: isRe ? 'regex' : 'keyword', pattern: pat, group: 'Custom lists', source: 'list', secret: !isRe });
  }
  return { rules, skipped };
}

// .env file: the VALUES become exact-match keywords (the most precise rules there are).
const SECRETISH_KEY = /key|secret|token|pass|pwd|credential|auth|private|dsn|conn|cert|signature|salt/i;
const BORING = /^(true|false|null|none|undefined|localhost|production|development|staging|test|info|debug|warn|error|utf-?8)$/i;
export function parseEnv(text) {
  const rules = [], skipped = [], seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith('#')) continue;
    let [, key, val] = m;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '');
    if (val.length < 8) { skipped.push({ id: key, reason: 'value too short to be a safe exact-match rule' }); continue; }
    if (BORING.test(val) || /^\d+$/.test(val) || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(val)) { skipped.push({ id: key, reason: 'not secret-like' }); continue; }
    // Natural-language sentences have high entropy too, so the entropy fallback only applies to space-free values.
    if (!SECRETISH_KEY.test(key) && !(val.length >= 16 && !/\s/.test(val) && shannon(val) >= 3.5)) { skipped.push({ id: key, reason: 'name and value do not look secret' }); continue; }
    const id = 'env:' + h8(val); if (seen.has(id)) continue; seen.add(id);
    rules.push({ id, name: `.env ${key}`, type: 'keyword', pattern: val, group: '.env values', source: 'env', secret: true });
  }
  return { rules, skipped };
}

export const SOURCES = {
  gitleaks: { label: 'Gitleaks', parse: (t) => parseGitleaks(t) },
  'secrets-db': { label: 'Secrets Patterns DB', parse: (t, o) => parseSecretsDb(t, o) },
  list: { label: 'Pasted list', parse: (t) => parseList(t) },
  env: { label: '.env file', parse: (t) => parseEnv(t) },
};
