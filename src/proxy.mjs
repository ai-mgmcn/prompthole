// The gateway itself. One request goes through three small stages:
//   screen()  look at what the user SENDS  -> pass / mask / block        (content rules)
//   forward() send it to the real provider
//   relay()   look at what comes BACK      -> record tokens, audit and optionally replace tool calls
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { scanValue as scan, extractUsage, Capture, identify, blockedBody, safeHeaders } from '../lib/core.mjs';
import { makeDecider, rewriteAnthropicJson, rewriteOpenAIJson, createAnthropicSseFilter, createOpenAISseFilter } from '../lib/toolcalls.mjs';
import { readBody, json } from './http.mjs';
import { inspectKind } from './inspect.mjs';

// hop-by-hop headers describe the client's connection to us, not the one we open to the provider
const NOT_FORWARDED = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'te', 'upgrade', 'expect']);
const NOT_RELAYED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const MAX_JSON_REWRITE = 8_000_000;
const MAX_CALLS_PER_EVENT = 50;

export function createProxy(store) {
  // Command text is stored and matched only after every content rule has been applied in mask mode, so secrets never land in the audit log.
  const maskForStore = (s) => scan(store.rules.value.map((r) => ({ ...r, mode: 'mask' })), s).value;

  // ---- stage 1: the request ----
  function screen(raw, req, up, ev) {
    if (!(/json/.test(req.headers['content-type'] || '') && raw.length)) return { body: raw };
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      ev.model = parsed.model || null;
      const r = scan(store.rules.value, parsed, { keepText: store.settings.value.storeMatchedText });
      ev.hits = r.hits;
      if (r.blocked) { ev.action = 'blocked'; return { reject: blockedBody(up.format, r.hits) }; }
      if (r.hits.some((h) => h.mode === 'mask')) { ev.action = 'masked'; return { body: Buffer.from(JSON.stringify(r.value)) }; }
      if (r.hits.length) ev.action = 'logged';
    } catch { /* not parseable: pass through untouched */ }
    return { body: raw };
  }

  // ---- stage 3: the response ----
  function relay(upstream, res, ev, t0, up, upPath, abort) {
    const ct = upstream.headers.get('content-type') || '';
    const src = Readable.fromWeb(upstream.body);
    const fail = () => res.destroy(); // upstream died mid-response: end the client's connection instead of crashing or hanging
    src.on('error', fail);
    res.on('close', () => { if (!src.destroyed) src.destroy(); abort.abort(); }); // client went away: stop reading from the provider
    const cap = new Capture();
    src.on('data', (c) => cap.push(c)); // observe only: token usage is read from what the provider really sent

    const kind = store.settings.value.inspectToolCalls && upstream.status === 200 ? inspectKind(up.format, upPath, ct) : null;
    const decide = kind ? makeDecider(store.toolRules.value, maskForStore) : null;
    let filter = null, jsonResult = null;

    res.on('close', () => { // runs once the client has everything
      ev.ms = Date.now() - t0;
      const usage = extractUsage(cap.text(), ct);
      if (usage) ev.tokens = usage;
      const calls = filter ? filter.calls : jsonResult?.calls;
      const blocked = filter ? filter.blocked : jsonResult?.blocked;
      if (calls?.length) ev.calls = calls.slice(0, MAX_CALLS_PER_EVENT);
      if (blocked) ev.blockedCalls = blocked;
      store.events.record(ev);
    });

    if (kind?.endsWith('-sse')) { // only tool_use blocks are held back until complete; text streams through immediately
      filter = kind === 'anthropic-sse' ? createAnthropicSseFilter(decide) : createOpenAISseFilter(decide);
      const dec = new StringDecoder('utf8');
      src.pipe(new Transform({
        transform(chunk, _e, cb) { try { cb(null, filter.write(dec.write(chunk))); } catch { cb(null, chunk); } }, // fail open
        flush(cb) { try { cb(null, filter.flush() + dec.end()); } catch { cb(); } },
      }).on('error', fail)).pipe(res);
    } else if (kind?.endsWith('-json')) {
      collect(src).catch(() => null).then((buf) => {
        if (!buf) return fail();
        let out = buf;
        if (buf.length <= MAX_JSON_REWRITE) {
          try {
            const rewrite = kind === 'anthropic-json' ? rewriteAnthropicJson : rewriteOpenAIJson;
            jsonResult = rewrite(JSON.parse(buf.toString('utf8')), decide);
            if (jsonResult.blocked) out = Buffer.from(JSON.stringify(jsonResult.obj));
          } catch { /* not the shape we expected: pass through */ }
        }
        res.end(out);
      });
    } else src.pipe(res);
  }

  return async function proxy(req, res, prefix, up) {
    const t0 = Date.now();
    const upPath = req.url.slice(prefix.length) || '/';
    const raw = await readBody(req);
    const ev = {
      id: crypto.randomUUID(), ts: t0, tool: identify(req.headers, store.clients.value), provider: up.id, headers: safeHeaders(req.headers),
      path: upPath.split('?')[0], model: null, action: 'allowed', hits: [], bytes: raw.length, status: 0, ms: 0,
    };

    const screened = screen(raw, req, up, ev);
    if (screened.reject) { ev.status = 400; ev.ms = Date.now() - t0; store.events.record(ev); return json(res, 400, screened.reject); }

    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !NOT_FORWARDED.has(k)));
    try {
      const abort = new AbortController();
      const upstream = await fetch(up.url + upPath, { signal: abort.signal, method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : screened.body });
      ev.status = upstream.status;
      const out = {};
      upstream.headers.forEach((v, k) => { if (!NOT_RELAYED.has(k)) out[k] = v; });
      res.writeHead(upstream.status, out);
      if (!upstream.body) return res.end();
      relay(upstream, res, ev, t0, up, upPath, abort);
    } catch (e) {
      ev.status = 502; ev.ms = Date.now() - t0; store.events.record(ev);
      json(res, 502, { error: { message: 'PromptHole could not reach upstream: ' + e.message } });
    }
  };
}

async function collect(stream) { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts); }
