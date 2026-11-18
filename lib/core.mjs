// Pure logic for PromptHole (no I/O) — unit-testable.
import crypto from 'node:crypto';

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compiled regexes are cached: with hundreds of imported rules, recompiling per request would dominate the cost.
const reCache = new Map();
export function compile(rule) {
  const key = `${rule.type}\u0000${rule.flags || ''}\u0000${rule.pattern}`;
  if (reCache.has(key)) return reCache.get(key);
  let re = null;
  try {
    re = rule.type === 'keyword'
      ? new RegExp(escapeRe(rule.pattern), 'gi')
      : new RegExp(rule.pattern, 'g' + (rule.flags || '').replace(/[^ims]/g, ''));
  } catch { re = null; }
  if (reCache.size > 5000) reCache.clear();
  reCache.set(key, re);
  return re;
}

// Shannon entropy (bits per character). Random keys score high, ordinary words low.
export function shannon(s) {
  if (!s) return 0;
  const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0; for (const k in f) { const p = f[k] / s.length; h -= p * Math.log2(p); }
  return h;
}

export const preview = (v) => (v.length <= 6 ? '***' : v.slice(0, 3) + '…' + '*'.repeat(3));

export const placeholderFor = (rule, value) =>
  `[PROMPTHOLE_${rule.id.toUpperCase().replace(/[^A-Z0-9]/g, '')}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 6)}]`;

// Walk a JSON value, apply rules to every string. Returns {hits, blocked, value}. Masking is one-way: nothing is ever restored.
export const MAX_MATCHES = 10, MAX_TEXT = 500, CTX = 30;
const CLEAN_MIN = 1024, CLEAN_MAX = 20000; // strings at least this long are remembered (by fingerprint) once found clean
export function scanValue(rules, root, opts = {}) {
  const active = rules.filter((r) => r.enabled).map((r) => ({ r, re: compile(r), kw: Array.isArray(r.keywords) && r.keywords.length ? r.keywords : null })).filter((x) => x.re);
  const anyKw = active.some((x) => x.kw);
  const hits = new Map();
  let blocked = false, noted = 0;
  const note = (rule, value, ctx) => {
    noted++;
    const h = hits.get(rule.id) || { id: rule.id, name: rule.name, mode: rule.mode, count: 0, sample: preview(value) };
    h.count++; hits.set(rule.id, h);
    if (opts.keepText) { // raw matched text: only when the user opted in
      h.matches ||= [];
      const text = value.slice(0, MAX_TEXT);
      if (h.matches.length < MAX_MATCHES && !h.matches.some((x) => x.text === text)) {
        h.matches.push({ text, truncated: value.length > MAX_TEXT, context: ctx });
      }
    }
  };
  // opts.cleanCache (a Set kept by the caller, cleared when the rules change): chat clients resend the whole conversation every turn,
  // so text already known to be clean is skipped instead of being scanned again
  const scanStr = (s) => {
    const cache = opts.cleanCache, remember = cache && s.length >= CLEAN_MIN;
    let key; if (remember) { key = crypto.createHash('sha1').update(s).digest('base64'); if (cache.has(key)) return s; }
    const before = noted;
    const out = scanRules(s);
    if (remember && noted === before) { if (cache.size >= CLEAN_MAX) cache.clear(); cache.add(key); }
    return out;
  };
  const scanRules = (s) => {
    let out = s;
    const lower = anyKw ? s.toLowerCase() : '';
    for (const { r, re, kw } of active) {
      if (kw && !kw.some((k) => lower.includes(k))) continue; // cheap pre-filter: skip the regex unless a keyword is present
      re.lastIndex = 0;
      out = out.replace(re, (...a) => {
        const m = a[0];
        if (r.entropy) { // ignore low-randomness matches (placeholders, words, repeated chars)
          const g = r.secretGroup ? a[r.secretGroup] : m;
          if (typeof g !== 'string' || shannon(g) < r.entropy) return m;
        }
        const i = a.findIndex((x, k) => k > 0 && typeof x === 'number'); // offset follows the capture groups
        const whole = a[i + 1];
        note(r, m, opts.keepText
          ? whole.slice(Math.max(0, a[i] - CTX), a[i]) + '⟦' + m.slice(0, 80) + (m.length > 80 ? '…' : '') + '⟧' + whole.slice(a[i] + m.length, a[i] + m.length + CTX)
          : undefined);
        if (r.mode === 'block') { blocked = true; return m; }
        if (r.mode === 'mask') { return placeholderFor(r, m); }
        return m; // log
      });
    }
    return out;
  };
  const walk = (v) => {
    if (typeof v === 'string') return scanStr(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  const value = walk(root);
  return { hits: [...hits.values()], blocked, value };
}

// Returns an error message, or null if the rule list is acceptable.
export function validRules(list) {
  if (!Array.isArray(list)) return 'rules must be a list';
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object') return 'each rule must be an object';
    const n = r.name || r.id;
    if (typeof r.id !== 'string' || !r.id) return 'every rule needs an id';
    if (seen.has(r.id)) return `duplicate rule id: ${r.id}`;
    seen.add(r.id);
    if (!['keyword', 'regex'].includes(r.type)) return `${n}: type must be keyword or regex`;
    if (typeof r.pattern !== 'string' || !r.pattern) return `${n}: pattern is empty`;
    if (!['mask', 'block', 'log'].includes(r.mode)) return `${n}: mode must be mask, block or log`;
    if (r.type === 'regex') { try { new RegExp(r.pattern, (r.flags || '').replace(/[^ims]/g, '')); } catch (e) { return `${n}: invalid regex (${String(e.message).replace(/^Invalid regular expression: /, '').slice(0, 100)})`; } }
  }
  return null;
}

// ---- token usage, read from the provider's own response (never estimated) ----
// Handles OpenAI chat/responses, Anthropic messages and Gemini, as plain JSON or SSE.
// Streaming usage is cumulative per event, so we take the max of each field.
export function extractUsage(text, contentType = '') {
  const objs = [];
  if (/event-stream/i.test(contentType) || /^\s*(event|data):/.test(text)) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d && d !== '[DONE]') { try { objs.push(JSON.parse(d)); } catch { /* partial line */ } }
    }
  } else {
    try { objs.push(JSON.parse(text)); } catch { return null; }
  }
  const u = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let found = false, anthropicStyle = false;
  const num = (...v) => v.find((x) => typeof x === 'number') ?? 0;
  for (const o of objs) {
    const x = o?.usage || o?.message?.usage || o?.response?.usage || o?.usageMetadata || o?.response?.usageMetadata;
    if (!x || typeof x !== 'object') continue;
    found = true;
    // Anthropic reports cache reads/writes SEPARATELY from input_tokens; OpenAI/Gemini count cached tokens INSIDE the prompt total.
    if ('cache_read_input_tokens' in x || 'cache_creation_input_tokens' in x) anthropicStyle = true;
    const out = num(x.completion_tokens, x.output_tokens, x.candidatesTokenCount) + num(x.thoughtsTokenCount);
    u.in = Math.max(u.in, num(x.prompt_tokens, x.input_tokens, x.promptTokenCount));
    u.out = Math.max(u.out, out);
    u.cacheRead = Math.max(u.cacheRead, num(x.cache_read_input_tokens, x.prompt_tokens_details?.cached_tokens, x.input_tokens_details?.cached_tokens, x.cachedContentTokenCount));
    u.cacheWrite = Math.max(u.cacheWrite, num(x.cache_creation_input_tokens));
    u.reasoning = Math.max(u.reasoning, num(x.completion_tokens_details?.reasoning_tokens, x.output_tokens_details?.reasoning_tokens, x.thoughtsTokenCount));
  }
  if (anthropicStyle) u.in += u.cacheRead + u.cacheWrite; // `in` is always the full prompt size; cacheRead/cacheWrite are the cached parts of it
  return found ? u : null;
}

// Keeps the start and the end of a response body (usage lives at the start or end) without buffering all of it.
export class Capture {
  constructor(head = 64 * 1024, tail = 256 * 1024) { this.H = head; this.T = tail; this.head = []; this.hs = 0; this.tail = []; this.ts = 0; }
  push(b) {
    if (this.hs < this.H) { this.head.push(b); this.hs += b.length; return; }
    this.tail.push(b); this.ts += b.length;
    while (this.ts > this.T && this.tail.length > 1) this.ts -= this.tail.shift().length;
  }
  text() { return Buffer.concat([...this.head, ...this.tail]).toString('utf8'); }
}

// Client identification rules: first enabled match wins. Editable by the user (Clients tab).
export const DEFAULT_CLIENTS = [
  { name: 'Claude Code', header: 'user-agent', pattern: 'claude-cli|claude-code', enabled: true },
  { name: 'Codex CLI', header: 'user-agent', pattern: 'codex', enabled: true },
  { name: 'Gemini CLI', header: 'user-agent', pattern: 'gemini-cli', enabled: true },
  { name: 'Aider', header: 'user-agent', pattern: 'aider', enabled: true },
  { name: 'Cline / Roo', header: 'user-agent', pattern: '\\b(cline|roo-?code)\\b', enabled: true },
  { name: 'Continue', header: 'user-agent', pattern: '\\bcontinue\\b', enabled: true },
  { name: 'Google GenAI SDK', header: 'user-agent', pattern: 'google-genai|google-generativeai', enabled: true },
  { name: 'Anthropic SDK', header: 'user-agent', pattern: 'anthropic', enabled: true },
  { name: 'OpenAI SDK', header: 'user-agent', pattern: 'openai', enabled: true },
];

export function identify(headers = {}, rules = DEFAULT_CLIENTS) {
  for (const r of rules) {
    if (r.enabled === false) continue;
    const v = headers[String(r.header).toLowerCase()];
    if (v == null) continue;
    try { if (new RegExp(r.pattern, 'i').test(String(v).slice(0, 512))) return r.name; } catch { /* bad pattern: skip */ } // headers come from the client: bound the input
  }
  return String(headers['user-agent'] || '').split(/[\s/]/)[0] || 'unknown';
}

export function validClients(list) {
  return Array.isArray(list) && list.every((r) => {
    if (!r || !String(r.name || '').trim() || !/^[a-z0-9-]+$/i.test(r.header || '')) return false;
    try { new RegExp(r.pattern, 'i'); return typeof r.pattern === 'string' && r.pattern.length > 0; } catch { return false; }
  });
}

// Headers safe to store/show: drops anything credential-like, truncates long values.
export function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/auth|key|token|cookie|secret|session|signature/i.test(k)) continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

export function blockedBody(format, hits) {
  return errorBody(format, `Blocked by PromptHole: request contains sensitive data (${hits.filter((h) => h.mode === 'block').map((h) => h.name).join(', ')}). Remove it and retry.`, 'prompthole_blocked');
}

// An error in the shape the client's SDK expects, so it shows a normal error message.
export function errorBody(format, msg, code = 'prompthole_error') {
  if (format === 'gemini') return { error: { code: 400, message: msg, status: 'INVALID_ARGUMENT' } };
  return format === 'anthropic'
    ? { type: 'error', error: { type: 'invalid_request_error', message: msg } }
    : { error: { message: msg, type: 'invalid_request_error', code } };
}

// these paths belong to the dashboard; an upstream with one of these names would lock the user out of the UI
const RESERVED_PREFIXES = new Set(['api', 'js', 'css', 'icons']);
export function validUpstreams(list) {
  if (!Array.isArray(list)) return false;
  const seen = new Set();
  return list.every((u) => {
    if (!u || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(u.prefix || '') || RESERVED_PREFIXES.has(u.prefix) || seen.has(u.prefix)) return false;
    seen.add(u.prefix);
    try { return /^https?:$/.test(new URL(u.url).protocol); } catch { return false; }
  });
}
