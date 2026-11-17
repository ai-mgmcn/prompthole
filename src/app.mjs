// Wires everything together: upstream prefixes -> proxy, /api/* -> dashboard API, everything else -> static files.
import { json, HttpError } from './http.mjs';
import { createProxy } from './proxy.mjs';
import { createApi } from './api.mjs';
import { createStatic } from './static.mjs';

export function createApp({ store, config }) {
  const proxy = createProxy(store), api = createApi({ store, config }), serveStatic = createStatic(config.publicDir);
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      for (const up of store.upstreams.value) {
        const prefix = '/' + up.prefix;
        if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) return await proxy(req, res, prefix, up);
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (serveStatic(req, res, url.pathname)) return;
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) { if (e instanceof HttpError) json(res, e.status, { error: e.message }); else json(res, 500, { error: 'internal error' }); } else res.end();
    }
  };
}
