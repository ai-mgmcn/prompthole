// Fetches rule libraries on demand (never bundled) and hands pasted text through unchanged.
import { SOURCES } from '../lib/rulelib.mjs';
import { HttpError } from './http.mjs';

const TTL = 10 * 60_000;

export function createSourceLoader(presets) {
  const cache = new Map(); // source -> { at, text }
  return async function loadSource(source, text) {
    if (!SOURCES[source]) throw new HttpError(400, 'unknown source');
    if (!presets[source]) { // pasted text
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'paste some text first');
      if (text.length > 2_000_000) throw new HttpError(413, 'text too large (2 MB max)');
      return text;
    }
    const hit = cache.get(source);
    if (hit && Date.now() - hit.at < TTL) return hit.text;
    let body;
    try {
      const r = await fetch(presets[source], { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      body = await r.text();
    } catch (e) { throw new HttpError(502, `could not download ${SOURCES[source].label}: ${e.message}`); }
    if (body.length > 8_000_000) throw new HttpError(502, 'downloaded file is unexpectedly large');
    cache.set(source, { at: Date.now(), text: body });
    return body;
  };
}
