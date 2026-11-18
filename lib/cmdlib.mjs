// "Command rules" file format: what to flag or block when a model asks a tool to run something.
// There is no standard for this, so PromptHole defines a small one (see lib/sensitive-commands.yml, which is also the built-in library):
//
//   rules:
//     - name: Recursive delete        # required
//       match: regex                  # exact | prefix | contains | regex   (default: regex)
//       pattern: '\brm\s+-[a-zA-Z]*[rR]'   # required; a regex starting with (?i) ignores upper/lower case
//       tool: "*"                     # tool name, or * for any (default: *)
//       action: flag                  # flag | block                        (default: flag)
//       group: Files                  # shown as a filter when importing    (default: Other)
//       note: why this is risky       # optional
//
// A JSON file with the same fields ({ "rules": [...] } or a bare list) is accepted too.
// Only the small YAML subset above is understood (a list of flat key: value items), so no YAML library is needed.
import crypto from 'node:crypto';
import { MATCHES, ACTIONS, splitFlags } from './toolcalls.mjs';

const h8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
export const MAX_RULES = 2000; // one file never brings in more than this many rules
const FIELDS = new Set(['id', 'name', 'match', 'pattern', 'tool', 'action', 'group', 'note']);

function scalar(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, v.lastIndexOf('"')); } }
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'")).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, ''); // a trailing comment (only outside quotes)
}

function parseYaml(text) {
  const items = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const dash = raw.match(/^\s*-\s+([A-Za-z_]+)\s*:\s*(.*)$/);
    if (dash) { cur = {}; items.push(cur); if (FIELDS.has(dash[1])) cur[dash[1]] = scalar(dash[2]); continue; }
    const kv = raw.match(/^\s+([A-Za-z_]+)\s*:\s*(.*)$/);
    if (kv && cur && FIELDS.has(kv[1])) cur[kv[1]] = scalar(kv[2]);
  }
  return items;
}

export function looksLikeCommandRules(text) {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return /"(pattern|match)"/.test(t);
  return /^\s*rules\s*:/m.test(text) && /^\s*-?\s*pattern\s*:/m.test(text) && /^\s*-?\s*(match|action|tool)\s*:/m.test(text);
}

export function parseCommandRules(text) {
  let items;
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { const j = JSON.parse(t); items = Array.isArray(j) ? j : j.rules; } catch (e) { throw new Error('not valid JSON: ' + String(e.message).slice(0, 80)); }
    if (!Array.isArray(items)) throw new Error('expected a list of rules');
  } else items = parseYaml(text);

  const rules = [], skipped = [], seen = new Set();
  for (const e of items) {
    if (!e || typeof e !== 'object') continue;
    if (rules.length >= MAX_RULES) { skipped.push({ id: '(rest of the file)', reason: `only the first ${MAX_RULES} rules of a file are read` }); break; }
    const name = String(e.name || e.pattern || 'unnamed').slice(0, 80);
    const match = e.match || 'regex', action = e.action || 'flag', tool = String(e.tool || '*').trim() || '*';
    if (typeof e.pattern !== 'string' || !e.pattern.trim()) { skipped.push({ id: name, reason: 'no pattern' }); continue; }
    if (!MATCHES.includes(match)) { skipped.push({ id: name, reason: `match must be one of ${MATCHES.join(', ')}` }); continue; }
    if (!ACTIONS.includes(action)) { skipped.push({ id: name, reason: 'action must be flag or block' }); continue; }
    if (match === 'regex') { try { const f = splitFlags(e.pattern); new RegExp(f.source, f.flags); } catch (x) { skipped.push({ id: name, reason: 'invalid regex: ' + String(x.message).replace(/^Invalid regular expression: /, '').slice(0, 80) }); continue; } }
    const id = 'cr:' + h8(`${tool}|${match}|${e.pattern}`);
    if (seen.has(id)) continue; seen.add(id);
    rules.push({ id, name, tool, match, pattern: e.pattern, action, group: String(e.group || 'Other').slice(0, 40), ...(e.note ? { note: String(e.note).slice(0, 200) } : {}) });
  }
  return { rules, skipped };
}
