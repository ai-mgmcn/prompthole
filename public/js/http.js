// JSON over fetch. `api` returns the parsed body; `put`/`post` return { ok, j } so callers can show validation errors.
const send = (method, path, body) => fetch(path, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, j: await r.json() }));

// throws on HTTP errors so a failed refresh is noticed instead of being rendered as data
export const api = async (path, opts) => { const r = await fetch(path, opts), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
export const put = (path, body) => send('PUT', path, body);
export const post = (path, body) => send('POST', path, body);
