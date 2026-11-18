// Downloads a text file from a URL the user pasted (for example a rule library).
// The server is making this request on the user's behalf, so it must not be usable to reach things that are not meant to be public:
// private / loopback / link-local addresses are refused (checked at connection time, so DNS tricks do not help), and every
// redirect is checked again. Set PROMPTHOLE_ALLOW_PRIVATE_URLS=1 to allow an internal host (for example a company file server).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export class UrlError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

// an IPv6 address as eight 16-bit numbers (handles "::" and a dotted IPv4 tail), or null
function ipv6Groups(ip) {
  let s = ip.split('%')[0].toLowerCase(); // drop a zone id such as fe80::1%en0
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const p = tail[1].split('.').map(Number); s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16); }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const g = [...head, ...Array(fill).fill('0'), ...rest].map((h) => parseInt(h, 16));
  return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}

const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const g = ipv6Groups(String(ip));
  if (!g) return true; // not an address we understand: refuse rather than guess
  const [a, b] = g;
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(v4(g[6], g[7])); // ::ffff:a.b.c.d (also ::a.b.c.d, ::1, ::)
  if (a === 0x64 && b === 0xff9b) return isPrivateAddress(v4(g[6], g[7])) || g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0; // NAT64: carries an IPv4 address (64:ff9b:1::/48 is local-use)
  if (a === 0x2002) return isPrivateAddress(v4(g[1], g[2]));                      // 6to4: carries an IPv4 address
  if (a === 0x2001 && b === 0) return true;                                         // Teredo
  if (a === 0x2001 && b === 0xdb8) return true;                                     // documentation range
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00; // unique-local, link-local, site-local, multicast
}

const refuse = () => new UrlError('that address is on a private network. Only public links are allowed (see PROMPTHOLE_ALLOW_PRIVATE_URLS).');

// timeoutMs: how long a connection may stay silent. totalMs: the longest the whole download may take (a server that trickles bytes is cut off too).
export function fetchText(link, { maxBytes = 8_000_000, timeoutMs = 20_000, totalMs = 30_000, allowPrivate = false, maxRedirects = 3 } = {}) {
  // checked when the connection is made, so a hostname that resolves to a private address is refused too
  const lookup = (host, opts, cb) => dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) return cb(refuse());
    return opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });

  let current = null; // the request in flight (so the overall deadline can stop it)
  const get = (u, hops) => new Promise((resolve, reject) => {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new UrlError('only http(s) links are supported'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate && isPrivateAddress(host)) return reject(refuse()); // an IP in the link skips DNS, so check it here
    const lib = u.protocol === 'https:' ? https : http;
    const req = current = lib.get(u, { lookup, timeout: timeoutMs, headers: { 'user-agent': 'PromptHole', accept: 'text/plain, */*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= maxRedirects) return reject(new UrlError('too many redirects'));
        let next; try { next = new URL(res.headers.location, u); } catch { return reject(new UrlError('bad redirect')); }
        return resolve(get(next, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new UrlError(`the server answered HTTP ${res.statusCode}`, 502)); }
      const chunks = []; let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n <= maxBytes) return chunks.push(d);
        chunks.length = 0;
        reject(new UrlError(`the file is larger than ${maxBytes >= 1e6 ? Math.round(maxBytes / 1e6) + ' MB' : maxBytes + ' bytes'}`, 413)); // reject first, then drop the connection
        req.destroy();
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { reject(new UrlError('the download timed out', 504)); req.destroy(); });
    req.on('error', reject);
  });

  let u; try { u = new URL(String(link).trim()); } catch { return Promise.reject(new UrlError('that is not a valid link')); }
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { reject(new UrlError('the download took too long', 504)); current?.destroy(); }, totalMs); });
  return Promise.race([get(u, 0), deadline]).finally(() => clearTimeout(timer));
}
