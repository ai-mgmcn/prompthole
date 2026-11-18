// Sends the request to the real provider. Built on node:http(s) rather than fetch so we control timeouts
// (fetch silently gives up after 5 minutes without data, which breaks long non-streaming requests).
import http from 'node:http';
import https from 'node:https';

const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };

// -> Promise<IncomingMessage>. `signal` aborts the connection (used when the client goes away).
export function forward(url, { method, headers, body, signal, idleMs = 900_000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'https:' ? https : http;
    const h = { ...headers };
    if (body && body.length) h['content-length'] = String(body.length);
    const req = lib.request(u, { method, headers: h, agent: agents[u.protocol], signal, timeout: idleMs }, resolve);
    req.on('timeout', () => req.destroy(new Error(`upstream sent nothing for ${Math.round(idleMs / 1000)} s`)));
    req.on('error', reject);
    req.end(body && body.length ? body : undefined);
  });
}
