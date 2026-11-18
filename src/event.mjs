// What a request log entry looks like to the list views, and how searches match it. Shared by the in-memory window and the audit files.

// the heavy parts (headers, matched text) are left out; fetch them per event
export const slimEvent = (e) => ({
  id: e.id, ts: e.ts, tool: e.tool, provider: e.provider, path: e.path, model: e.model, action: e.action, status: e.status, ms: e.ms, bytes: e.bytes,
  tokens: e.tokens, blockedCalls: e.blockedCalls, error: e.error, calls: e.calls,
  hits: (e.hits || []).map((h) => ({ name: h.name, mode: h.mode, count: h.count })),
});

// the text a search box looks in (lower case)
export const searchText = (e) => `${e.tool} ${e.model || ''} ${e.path} ${e.provider} ${(e.hits || []).map((h) => h.name).join(' ')} ${(e.calls || []).map((c) => c.text).join(' ')}`.toLowerCase();

// does this event pass the filters? `text` can be passed when it was worked out already
export function matchesFilters(e, { action = '', tool = '', calls = '', needle = '' } = {}, text) {
  if (action && e.action !== action) return false;
  if (tool && e.tool !== tool) return false;
  if (calls === 'risky' && !(e.calls || []).some((c) => c.action !== 'allowed')) return false; // the model asked for something flagged or blocked
  if (needle && !(text ?? searchText(e)).includes(needle)) return false;
  return true;
}
