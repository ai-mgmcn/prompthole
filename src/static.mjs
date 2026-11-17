// Serves the dashboard (public/) to loopback clients only, with a strict Content-Security-Policy.
import fs from 'node:fs';
import path from 'node:path';
import { localHost } from './http.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
// scripts only from this origin; no inline scripts, no remote anything
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createStatic(publicDir) {
  const root = path.resolve(publicDir);
  return function serve(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method) || !localHost(req)) return false;
    let rel;
    try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return false; } // malformed %-escape
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return false; // path traversal
    const type = TYPES[path.extname(file)];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
    return true;
  };
}
