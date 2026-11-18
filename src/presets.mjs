// Fetches rule libraries on demand (never bundled) and hands pasted text through unchanged.
//   - the two built-in libraries are downloaded from their well-known addresses
//   - "url": any link the user pastes (the format is detected later)
//   - "list" / "env": text the user pasted
import { SOURCES } from '../lib/rulelib.mjs';
import { HttpError } from './http.mjs';
import { fetchText, UrlError } from './fetch-url.mjs';

const TTL = 10 * 60_000;

export function createSourceLoader(presets, { allowPrivateUrls = false } = {}) {
  const cache = new Map(); // address -> { at, text }
  const download = async (key, label, get) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.text;
    let body;
    try { body = await get(); }
    catch (e) { throw new HttpError(e instanceof UrlError ? e.status : 502, `could not download ${label}: ${e.message}`); }
    if (cache.size > 20) cache.clear();
    cache.set(key, { at: Date.now(), text: body });
    return body;
  };

  return async function loadSource(source, text, link) {
    if (!SOURCES[source]) throw new HttpError(400, 'unknown source');
    if (source === 'url') {
      if (typeof link !== 'string' || !link.trim()) throw new HttpError(400, 'paste a link first');
      const body = await download(link.trim(), 'the link', () => fetchText(link, { allowPrivate: allowPrivateUrls }));
      if (!body.trim()) throw new HttpError(400, 'the file is empty');
      return body;
    }
    if (!presets[source]) { // pasted text
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'paste some text first');
      if (text.length > 2_000_000) throw new HttpError(413, 'text too large (2 MB max)');
      return text;
    }
    return download(source, SOURCES[source].label, async () => {
      const r = await fetch(presets[source], { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.text();
      if (body.length > 8_000_000) throw new Error('downloaded file is unexpectedly large');
      return body;
    });
  };
}
