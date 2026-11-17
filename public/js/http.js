// JSON over fetch. `api` returns the parsed body; `put`/`post` return { ok, j } so callers can show validation errors.
const send = (method, path, body) => fetch(path, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, j: await r.json() }));

export const api = (path, opts) => fetch(path, opts).then((r) => r.json());
export const put = (path, body) => send('PUT', path, body);
export const post = (path, body) => send('POST', path, body);
