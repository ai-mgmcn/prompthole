// Small HTTP helpers shared by the proxy, the API and the static server.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const MAX_BODY = 256 * 1024 * 1024; // generous (images/PDFs), but a runaway client cannot exhaust memory
export const readBody = (req, max = MAX_BODY) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0, over = false;
  req.on('data', (d) => { // past the limit the rest is read and thrown away; the caller answers 413 and closes the connection
    if (over) return;
    size += d.length;
    if (size > max) { over = true; chunks.length = 0; reject(new HttpError(413, 'request body too large')); return; }
    chunks.push(d);
  });
  req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
});
export const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

const LOOPBACK = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
export const localHost = (req) => LOOPBACK.test(req.headers.host || '');                       // anti DNS-rebinding
export const badOrigin = (req) => !!req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin); // anti CSRF

export async function readJson(req) {
  const text = (await readBody(req)).toString();
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'invalid json'); }
}
