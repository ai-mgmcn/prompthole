// The gateway itself. One request goes through three small stages:
//   screen()  look at what the user SENDS  -> pass / mask / block        (content rules, run in worker threads)
//   forward() send it to the real provider
//   relay()   look at what comes BACK      -> record tokens, audit and optionally replace tool calls
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { scanValue as scan, extractUsage, Capture, identify, blockedBody, errorBody, safeHeaders } from '../lib/core.mjs';
import { makeDecider, rewriteAnthropicJson, rewriteOpenAIJson, createAnthropicSseFilter, createOpenAISseFilter } from '../lib/toolcalls.mjs';
import { readBody, json } from './http.mjs';
import { inspectKind } from './inspect.mjs';
import { ScanError } from './scan-pool.mjs';
import { forward } from './upstream.mjs';

// hop-by-hop headers describe the client's connection to us, not the one we open to the provider
const NOT_FORWARDED = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'te', 'upgrade', 'expect']);
const NOT_RELAYED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const MAX_JSON_REWRITE = 8_000_000;
const MAX_CALLS_PER_EVENT = 50;
const MAX_COMMAND_SCAN = 64 * 1024; // longest command text that is masked / matched; the audit log keeps 400 characters anyway

export function createProxy(store, { pool, config }) {
  // Command text is stored and matched only after every content rule has been applied in mask mode, so secrets never land in the audit log.
  // (Runs on the main thread, so it only ever sees a bounded prefix and rules that were checked for runaway backtracking when saved.)
  const maskForStore = (s) => scan(store.rules.value.map((r) => ({ ...r, mode: 'mask' })), s.length > MAX_COMMAND_SCAN ? s.slice(0, MAX_COMMAND_SCAN) : s).value;

  // ---- stage 1: the request ----
  async function screen(raw, req, up, ev) {
    if (!(/json/.test(req.headers['content-type'] || '') && raw.length)) return { body: raw };
    let r;
    try {
      r = await pool.scan({ raw, rules: store.rules.value, version: store.rules.version, keepText: store.settings.value.storeMatchedText });
    } catch (e) {
      if (!(e instanceof ScanError)) throw e;
      ev.error = `scan_${e.kind}`;
      if (e.kind !== 'busy' && config.onScanTimeout === 'allow') return { body: raw }; // the owner chose to fail open
      ev.action = 'blocked';
      const msg = e.kind === 'busy'
        ? 'PromptHole is busy scanning other requests. Retry in a moment.'
        : 'PromptHole could not finish checking this request in time (a rule may be too slow for this input), so it was not sent.';
      return { reject: errorBody(up.format, msg, 'prompthole_scan_failed'), status: e.kind === 'busy' ? 503 : 400 };
    }
    if (r.unparseable) return { body: raw }; // not JSON after all: pass through untouched
    ev.model = r.model; ev.hits = r.hits;
    if (r.blocked) { ev.action = 'blocked'; return { reject: blockedBody(up.format, r.hits), status: 400 }; }
    if (r.body !== undefined) { ev.action = 'masked'; return { body: Buffer.from(r.body) }; }
    if (r.hits.length) ev.action = 'logged';
    return { body: raw };
  }

  // ---- stage 3: the response ----
  function relay(src, res, ev, t0, up, upPath, abort) {
    const ct = src.headers['content-type'] || '';
    const cap = new Capture();
    const fail = () => res.destroy(); // upstream died mid-response: end the client's connection instead of crashing or hanging
    src.on('error', fail);
    src.on('data', (c) => cap.push(c)); // observe only: token usage is read from what the provider really sent
    res.on('close', () => { if (!src.destroyed) src.destroy(); abort.abort(); }); // client went away: stop reading from the provider

    const kind = store.settings.value.inspectToolCalls && src.statusCode === 200 ? inspectKind(up.format, upPath, ct) : null;
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
    const raw = await readBody(req, config.maxBodyBytes);
    const ev = {
      id: crypto.randomUUID(), ts: t0, tool: identify(req.headers, store.clients.value), provider: up.id, headers: safeHeaders(req.headers),
      path: upPath.split('?')[0], model: null, action: 'allowed', hits: [], bytes: raw.length, status: 0, ms: 0,
    };

    const screened = await screen(raw, req, up, ev);
    if (screened.reject) { ev.status = screened.status; ev.ms = Date.now() - t0; store.events.record(ev); return json(res, screened.status, screened.reject); }

    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !NOT_FORWARDED.has(k)));
    const abort = new AbortController();
    try {
      const upstream = await forward(up.url + upPath, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : screened.body, signal: abort.signal, idleMs: config.upstreamIdleMs });
      ev.status = upstream.statusCode;
      const out = {};
      for (const [k, v] of Object.entries(upstream.headers)) if (!NOT_RELAYED.has(k)) out[k] = v;
      res.writeHead(upstream.statusCode, out);
      relay(upstream, res, ev, t0, up, upPath, abort);
    } catch (e) {
      if (res.headersSent) return;
      ev.status = 502; ev.ms = Date.now() - t0; ev.error = 'upstream_unreachable'; store.events.record(ev);
      json(res, 502, { error: { message: 'PromptHole could not reach upstream: ' + e.message } });
    }
  };
}

async function collect(stream) { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts); }
