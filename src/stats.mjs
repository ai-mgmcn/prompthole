// Aggregations for the dashboard. Pure functions over the event list.
// Names come from the network (model, tool, rule names), so these are objects without a prototype: a model called "constructor" is just a name.
const dict = () => Object.create(null);
const tally = (events, key) => { const m = dict(); for (const e of events) { const k = key(e); if (k) m[k] = (m[k] || 0) + 1; } return m; };

export function stats(events) {
  const rules = dict();
  for (const e of events) for (const h of e.hits) rules[h.name] = (rules[h.name] || 0) + h.count;

  const now = Date.now();
  const series = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 60000, total: 0, flagged: 0 }));
  for (const e of events) {
    const i = 59 - Math.floor((now - e.ts) / 60000);
    if (i >= 0 && i < 60) { series[i].total++; if (e.action !== 'allowed') series[i].flagged++; }
  }

  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }, tokensByModel = dict(), tokensByTool = dict();
  for (const e of events) {
    if (!e.tokens) continue;
    tokens.requests++; tokens.in += e.tokens.in; tokens.out += e.tokens.out; tokens.cacheRead += e.tokens.cacheRead;
    tokens.cacheWrite += e.tokens.cacheWrite || 0; tokens.reasoning += e.tokens.reasoning;
    const n = e.tokens.in + e.tokens.out;
    if (e.model) tokensByModel[e.model] = (tokensByModel[e.model] || 0) + n;
    tokensByTool[e.tool] = (tokensByTool[e.tool] || 0) + n;
  }

  const calls = { total: 0, flagged: 0, blocked: 0 };
  for (const e of events) for (const c of e.calls || []) { calls.total++; if (c.action === 'flagged') calls.flagged++; else if (c.action === 'blocked') calls.blocked++; }

  return {
    total: events.length, actions: tally(events, (e) => e.action), tools: tally(events, (e) => e.tool), providers: tally(events, (e) => e.provider),
    models: tally(events, (e) => e.model), rules, series, tokens, tokensByModel, tokensByTool, calls,
  };
}

// how often each command rule fired, for the Commands page
export function toolRuleCounts(events) {
  const counts = dict();
  for (const e of events) for (const c of e.calls || []) {
    if (!c.rule) continue;
    const k = (counts[c.rule] ||= { blocked: 0, flagged: 0 });
    if (c.action === 'blocked') k.blocked++; else if (c.action === 'flagged') k.flagged++;
  }
  return counts;
}
