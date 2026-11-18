// Tool-call inspection: audit what the model asks the client to run, and optionally replace calls before the client sees them.
// Pure logic (no I/O). Supports Anthropic Messages and OpenAI Chat Completions, both plain JSON and SSE streams.
// Design rule: anything unexpected is passed through untouched (fail open) so PromptHole can never break a working tool.

// ---------- what a call "says" ----------
export function toolText(name, input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (typeof input.command === 'string') return input.command; // Bash-like tools
    if (typeof input.cmd === 'string') return input.cmd;
  }
  return JSON.stringify(input ?? {});
}
export const normalize = (s) => String(s).replace(/\s+/g, ' ').trim();

// ---------- rules ----------
export const MATCHES = ['exact', 'prefix', 'contains', 'regex'];
export const ACTIONS = ['flag', 'block'];
const reCache = new Map();
// A regex pattern that starts with (?i) ignores upper/lower case (JavaScript has no inline flags, so this is our own convention).
export const splitFlags = (p) => (p.startsWith('(?i)') ? { source: p.slice(4), flags: 'i' } : { source: p, flags: '' });
const rx = (p) => { if (!reCache.has(p)) { let r = null; try { const f = splitFlags(p); r = new RegExp(f.source, f.flags); } catch { r = null; } reCache.set(p, r); } return reCache.get(p); };

export function matchesRule(rule, name, text) {
  if (rule.enabled === false) return false;
  if (rule.tool && rule.tool !== '*' && rule.tool.toLowerCase() !== String(name).toLowerCase()) return false;
  const t = normalize(text), p = normalize(rule.pattern);
  switch (rule.match) {
    case 'exact': return t === p;
    case 'prefix': return t.startsWith(p);
    case 'contains': return t.includes(p);
    case 'regex': { const r = rx(rule.pattern); return !!r && r.test(text); }
    default: return false;
  }
}
// a blocking rule always wins over a flagging one
export function bestRule(rules, name, text) {
  let flag = null;
  for (const r of rules) {
    if (!matchesRule(r, name, text)) continue;
    if (r.action === 'block') return r;
    flag ||= r;
  }
  return flag;
}

export function validToolRules(list) {
  if (!Array.isArray(list)) return 'rules must be a list';
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object') return 'each rule must be an object';
    const n = r.name || r.id;
    if (typeof r.id !== 'string' || !r.id) return 'every rule needs an id';
    if (seen.has(r.id)) return `duplicate rule id: ${r.id}`;
    seen.add(r.id);
    if (typeof r.tool !== 'string' || !r.tool.trim()) return `${n}: tool must be a name or *`;
    if (!MATCHES.includes(r.match)) return `${n}: match must be one of ${MATCHES.join(', ')}`;
    if (!ACTIONS.includes(r.action)) return `${n}: action must be flag or block`;
    if (typeof r.pattern !== 'string' || !r.pattern.trim()) return `${n}: pattern is empty`;
    if (r.match === 'regex') { try { const f = splitFlags(r.pattern); new RegExp(f.source, f.flags); } catch (e) { return `${n}: invalid regex (${String(e.message).replace(/^Invalid regular expression: /, '').slice(0, 100)})`; } }
  }
  return null;
}

// Built-in rules only FLAG (show in red in the audit view). The user turns one into a block with a click.
export const DEFAULT_TOOL_RULES = [
  { id: 'tr-rm-r', name: 'Recursive delete (rm -r)', tool: '*', match: 'regex', pattern: '\\brm\\s+-[a-zA-Z]*[rR]', action: 'flag', enabled: true },
  { id: 'tr-pipe-sh', name: 'Download and run (curl | sh)', tool: '*', match: 'regex', pattern: '\\b(curl|wget)\\b[^|\\n]*\\|\\s*(sudo\\s+)?(ba|z)?sh\\b', action: 'flag', enabled: true },
  { id: 'tr-force-push', name: 'Force push', tool: '*', match: 'regex', pattern: '\\bgit\\s+push\\b[^\\n]*(\\s--force\\b|\\s-f\\b|--force-with-lease)', action: 'flag', enabled: true },
  { id: 'tr-sudo', name: 'Runs as root (sudo)', tool: '*', match: 'regex', pattern: '\\bsudo\\b', action: 'flag', enabled: true },
  { id: 'tr-cred-files', name: 'Reads credential files', tool: '*', match: 'regex', pattern: '\\b(cat|less|more|head|tail|cp|scp|rsync|base64)\\b[^\\n]*(\\.env\\b|\\.ssh/|id_rsa|id_ed25519|\\.aws/credentials|\\.netrc)', action: 'flag', enabled: true },
  { id: 'tr-upload-file', name: 'Uploads a local file (curl)', tool: '*', match: 'regex', pattern: '\\bcurl\\b[^\\n]*(\\s-d\\s*@|--data[a-z-]*[ =]@|\\s-F\\s|\\s-T\\s|--upload-file)', action: 'flag', enabled: true },
];

// ---------- deciding ----------
export const blockMessage = (rule, text) =>
  `⛔ PromptHole blocked this tool call (rule: ${rule.name}). It was NOT executed: ${normalize(text).slice(0, 160)}${normalize(text).length > 160 ? '…' : ''}\n` +
  'Do not retry it or look for a way around it; tell the user it was blocked.';

// decide({id,name,input}) -> { action:'allow'|'flag'|'block', message, record }
export function makeDecider(rules, mask = (s) => s) {
  const active = rules.filter((r) => r.enabled !== false);
  return (call) => {
    const text = mask(toolText(call.name, call.input));
    const hit = bestRule(active, call.name, text);
    const action = hit ? hit.action : 'allow';
    return {
      action, message: action === 'block' ? blockMessage(hit, text) : null,
      record: { id: call.id, name: call.name, text: text.slice(0, 400), action: action === 'allow' ? 'allowed' : action === 'flag' ? 'flagged' : 'blocked', rule: hit ? hit.id : null },
    };
  };
}

// ---------- plain JSON responses ----------
export function rewriteAnthropicJson(obj, decide) {
  const calls = []; let blocked = 0, kept = 0;
  if (!obj || !Array.isArray(obj.content)) return { obj, calls, blocked };
  const content = obj.content.map((b) => {
    if (b?.type !== 'tool_use') return b;
    const d = decide({ id: b.id, name: b.name, input: b.input });
    calls.push(d.record);
    if (d.action === 'block') { blocked++; return { type: 'text', text: d.message }; }
    kept++; return b;
  });
  if (!blocked) return { obj, calls, blocked };
  const out = { ...obj, content };
  if (!kept && obj.stop_reason === 'tool_use') out.stop_reason = 'end_turn';
  return { obj: out, calls, blocked };
}

export function rewriteOpenAIJson(obj, decide) {
  const calls = []; let blocked = 0;
  const choice = obj?.choices?.[0], msg = choice?.message;
  if (!Array.isArray(msg?.tool_calls) || !msg.tool_calls.length) return { obj, calls, blocked };
  const keep = [], notes = [];
  for (const c of msg.tool_calls) {
    let input; try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = c.function?.arguments ?? ''; }
    const d = decide({ id: c.id, name: c.function?.name, input });
    calls.push(d.record);
    if (d.action === 'block') { blocked++; notes.push(d.message); } else keep.push(c);
  }
  if (!blocked) return { obj, calls, blocked };
  const out = structuredClone(obj), m = out.choices[0].message;
  if (keep.length) m.tool_calls = keep; else delete m.tool_calls;
  m.content = (m.content ? m.content + '\n\n' : '') + notes.join('\n');
  if (!keep.length && out.choices[0].finish_reason === 'tool_calls') out.choices[0].finish_reason = 'stop';
  return { obj: out, calls, blocked };
}

// ---------- SSE streams ----------
const EVENT_END = /\r?\n\r?\n/;
const MAX_PENDING = 8 * 1024 * 1024; // an SSE event or a held tool call larger than this is passed through untouched (fail open)
function splitEvents(state, str) { // returns complete events (terminator included); keeps the tail in state.buf
  state.buf += str; const out = [];
  if (state.buf.length > MAX_PENDING && !EVENT_END.test(state.buf)) { out.push(state.buf); state.buf = ''; return out; }
  for (let m; (m = EVENT_END.exec(state.buf));) { const end = m.index + m[0].length; out.push(state.buf.slice(0, end)); state.buf = state.buf.slice(end); }
  return out;
}
const dataOf = (raw) => { const l = raw.split(/\r?\n/).find((x) => x.startsWith('data:')); return l ? l.slice(5).trim() : null; };
const sse = (name, obj) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;

// Anthropic: hold a tool_use block (start + input_json_delta fragments + stop) until it is complete, then pass or replace it.
export function createAnthropicSseFilter(decide) {
  const st = { buf: '' }, held = new Map(), calls = []; let kept = 0, blocked = 0;
  const resolve = (idx, h) => {
    let input; try { input = h.json ? JSON.parse(h.json) : {}; } catch { input = h.json; }
    let d; try { d = decide({ id: h.id, name: h.name, input }); } catch { kept++; return h.events.join(''); } // fail open: send the call untouched
    calls.push(d.record);
    if (d.action !== 'block') { kept++; return h.events.join(''); }
    blocked++;
    return sse('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })
      + sse('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: d.message } })
      + sse('content_block_stop', { type: 'content_block_stop', index: idx });
  };
  const handle = (raw) => {
    const body = dataOf(raw);
    // cheap pre-check so ordinary text deltas are never JSON-parsed
    if (!body || !(body.includes('"tool_use"') || body.includes('"input_json_delta"') || body.includes('"content_block_stop"') || body.includes('"message_delta"'))) return raw;
    let d; try { d = JSON.parse(body); } catch { return raw; }
    if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') { held.set(d.index, { events: [raw], id: d.content_block.id, name: d.content_block.name, json: '' }); return ''; }
    if (d.type === 'content_block_delta' && held.has(d.index)) { const h = held.get(d.index); if (d.delta?.type === 'input_json_delta') h.json += d.delta.partial_json ?? ''; h.events.push(raw); if (h.json.length > MAX_PENDING) { held.delete(d.index); kept++; return h.events.join(''); } return ''; }
    if (d.type === 'content_block_stop' && held.has(d.index)) { const h = held.get(d.index); held.delete(d.index); h.events.push(raw); return resolve(d.index, h); }
    if (d.type === 'message_delta' && blocked && !kept && d.delta?.stop_reason === 'tool_use') { d.delta.stop_reason = 'end_turn'; return sse('message_delta', d); }
    return raw;
  };
  return {
    calls, get blocked() { return blocked; },
    write(str) { let out = ''; for (const ev of splitEvents(st, str)) { try { out += handle(ev); } catch { out += ev; } } return out; },
    flush() { let out = ''; for (const h of held.values()) out += h.events.join(''); held.clear(); out += st.buf; st.buf = ''; return out; }, // truncated stream: release everything unchanged
  };
}

// OpenAI Chat Completions: tool_calls arrive as per-index argument fragments; hold them until finish_reason, then pass or drop each call.
export function createOpenAISseFilter(decide) {
  const st = { buf: '' }, held = [], byIndex = new Map(), calls = []; const meta = {}; let blocked = 0;
  const resolve = () => {
    const verdict = new Map(); let kept = 0, nb = 0; const notes = [];
    for (const [idx, c] of byIndex) {
      let input; try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = c.args; }
      let d; try { d = decide({ id: c.id, name: c.name, input }); } catch { kept++; continue; } // fail open
      calls.push(d.record); verdict.set(idx, d);
      if (d.action === 'block') { nb++; notes.push(d.message); } else kept++;
    }
    blocked += nb;
    let out = nb ? sse(null, { id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model, choices: [{ index: 0, delta: { content: notes.join('\n') }, finish_reason: null }] }) : '';
    for (const { raw, o } of held) {
      const ch = o.choices[0]; let changed = false;
      if (Array.isArray(ch.delta?.tool_calls)) {
        const keep = ch.delta.tool_calls.filter((t) => verdict.get(t.index)?.action !== 'block');
        if (keep.length !== ch.delta.tool_calls.length) { changed = true; if (keep.length) ch.delta.tool_calls = keep; else delete ch.delta.tool_calls; }
      }
      if (ch.finish_reason === 'tool_calls' && nb && !kept) { ch.finish_reason = 'stop'; changed = true; }
      if (changed && !Object.keys(ch.delta || {}).length && !ch.finish_reason) continue; // the chunk only carried a blocked call
      out += changed ? sse(null, o) : raw;
    }
    held.length = 0; byIndex.clear();
    return out;
  };
  const handle = (raw) => {
    const body = dataOf(raw);
    if (body === null) return raw;
    if (body === '[DONE]') return (held.length ? resolve() : '') + raw;
    let o; try { o = JSON.parse(body); } catch { return raw; }
    const ch = o.choices?.[0], tc = ch?.delta?.tool_calls;
    if (Array.isArray(tc) && tc.length) {
      for (const t of tc) {
        const c = byIndex.get(t.index) || { id: '', name: '', args: '' };
        if (t.id) c.id = t.id; if (t.function?.name) c.name = t.function.name; if (t.function?.arguments) c.args += t.function.arguments;
        byIndex.set(t.index, c);
      }
      Object.assign(meta, { id: o.id, created: o.created, model: o.model });
      held.push({ raw, o });
      return ch.finish_reason ? resolve() : '';
    }
    if (ch?.finish_reason && held.length) { held.push({ raw, o }); return resolve(); }
    return raw;
  };
  return {
    calls, get blocked() { return blocked; },
    write(str) { let out = ''; for (const ev of splitEvents(st, str)) { try { out += handle(ev); } catch { out += ev; } } return out; },
    flush() { let out = ''; for (const h of held) out += h.raw; held.length = 0; byIndex.clear(); out += st.buf; st.buf = ''; return out; },
  };
}
