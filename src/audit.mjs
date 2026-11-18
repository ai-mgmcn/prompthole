// The audit trail: every request is appended to one file per day (audit/YYYY-MM-DD.jsonl, UTC days), and files are never rewritten
// or compacted. (The only exceptions are "Purge stored text", which removes saved matched text, and the optional retention limit,
// which deletes whole old days.) The dashboard asks for a time range and this loads just the days that range touches.
//
// Safety notes:
//  - appends are single synchronous writes of one whole line, so a reader that stops at the last newline never sees half a record
//  - queries run one at a time (they share the day cache); the cache is bounded by item count and dropped whenever files are rewritten
//  - a day that is still being written is read incrementally (only the new bytes), so polling stays cheap
import fs from 'node:fs';
import path from 'node:path';
import { slimEvent, searchText, matchesFilters } from './event.mjs';

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const DAY_MS = 86_400_000;
export const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const dayStart = (date) => Date.parse(date + 'T00:00:00Z');
const tick = () => new Promise((r) => setImmediate(r));

export class AuditLog {
  // retentionDays: 0 keeps everything. cacheItems: how many parsed entries are kept in memory (least recently used days go first).
  constructor(dir, { retentionDays = 0, cacheItems = 150_000 } = {}) {
    this.dir = dir; this.retentionDays = retentionDays; this.cacheItems = cacheItems;
    this.version = 0;          // changes whenever the files change (lets the dashboard poll with ETags)
    this.generation = 0;       // changes when files are rewritten or deleted: anything parsed before is stale
    this.cache = new Map(); this.queue = Promise.resolve();
    this.sealed = new Set();   // days whose file is known to end on a complete line
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  file(date) { return path.join(this.dir, date + '.jsonl'); }
  serial(fn) { const run = this.queue.then(fn); this.queue = run.catch(() => {}); return run; } // the chain keeps only the latest link: nothing accumulates
  invalidate() { this.generation++; this.cache.clear(); this.version++; }

  // One whole line per record. If an earlier write was cut short (crash, full disk) the file ends in the middle of a line;
  // the next record must start on a new line, otherwise it would be glued onto the broken one and lost with it.
  append(ev) {
    const date = dayOf(ev.ts), file = this.file(date);
    try {
      if (!this.sealed.has(date)) { this.endUnfinishedLine(file); this.sealed.add(date); }
      fs.appendFileSync(file, JSON.stringify(ev) + '\n', { mode: 0o600 });
    } catch (e) { this.sealed.delete(date); throw e; } // after a failed write the end of the file is unknown: look again next time
    this.version++;
  }
  endUnfinishedLine(file) {
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return; } // no file yet: nothing to repair
    try {
      const size = fs.fstatSync(fd).size, last = Buffer.alloc(1);
      if (size && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) fs.appendFileSync(file, '\n');
    } finally { fs.closeSync(fd); }
  }

  days() { // oldest first
    return fs.readdirSync(this.dir).map((n) => DAY_RE.exec(n)).filter(Boolean)
      .map((m) => ({ date: m[1], bytes: fs.statSync(this.file(m[1])).size })).sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  isEmpty() { return this.days().length === 0; }

  // delete days older than the retention limit; returns how many files were removed
  prune(now = Date.now()) {
    if (!this.retentionDays) return 0;
    const cutoff = dayOf(now - this.retentionDays * DAY_MS);
    let n = 0;
    for (const d of this.days()) if (d.date < cutoff) { fs.unlinkSync(this.file(d.date)); n++; }
    if (n) this.invalidate();
    return n;
  }

  // The parsed entries of one day: { offset, items:[{ ev, text, at, len }] } where at/len locate the record in the file.
  async load(date) {
    let st; try { st = await fs.promises.stat(this.file(date)); } catch { this.cache.delete(date); return null; }
    const gen = this.generation;
    let ent = this.cache.get(date);
    if (!ent || st.size < ent.offset) ent = { offset: 0, items: [] };
    if (st.size > ent.offset) {
      const fh = await fs.promises.open(this.file(date), 'r');
      try {
        const buf = Buffer.alloc(st.size - ent.offset), { bytesRead } = await fh.read(buf, 0, buf.length, ent.offset);
        const end = buf.subarray(0, bytesRead).lastIndexOf(10) + 1; // whole lines only; a half-written last line is picked up next time
        let pos = 0, n = 0;
        while (pos < end) {
          const nl = buf.indexOf(10, pos);
          if (nl > pos) { try { const e = JSON.parse(buf.toString('utf8', pos, nl)); ent.items.push({ ev: slimEvent(e), text: searchText(e), at: ent.offset + pos, len: nl - pos }); } catch { /* a corrupt line is skipped */ } }
          pos = nl + 1;
          if (++n % 2000 === 0) await tick(); // a big day must not freeze the gateway while it is read
        }
        ent.offset += end;
      } finally { await fh.close(); }
    }
    if (gen !== this.generation) return ent; // files changed while we were reading: use it for this answer, but do not keep it
    this.cache.delete(date); this.cache.set(date, ent); // most recently used goes last
    let total = 0; for (const e of this.cache.values()) total += e.items.length;
    for (const k of this.cache.keys()) { if (total <= this.cacheItems || this.cache.size <= 1 || k === date) break; total -= this.cache.get(k).items.length; this.cache.delete(k); }
    return ent;
  }

  // Newest first. from / to are timestamps (ms); only the days they touch are read.
  query({ from = 0, to = Infinity, action = '', tool = '', calls = '', q = '', page = 1, size = 50 } = {}) {
    return this.serial(async () => {
      size = Math.min(Math.max(Math.floor(size) || 50, 1), 500);
      from = Number(from); to = Number(to);
      if (!(from >= 0)) from = 0; if (Number.isNaN(to)) to = Infinity; // a reversed range (to before from) is simply empty
      const f = { action, tool, calls, needle: String(q).trim().toLowerCase() };
      const dates = this.days().map((d) => d.date).filter((d) => dayStart(d) + DAY_MS - 1 >= from && dayStart(d) <= to).reverse();
      const matched = [];
      for (const d of dates) {
        const ent = await this.load(d); if (!ent) continue;
        for (let i = ent.items.length - 1; i >= 0; i--) {
          const { ev, text } = ent.items[i];
          if (ev.ts >= from && ev.ts <= to && matchesFilters(ev, f, text)) matched.push(ev);
        }
      }
      const pages = Math.max(1, Math.ceil(matched.length / size));
      page = Math.min(Math.max(Math.floor(page) || 1, 1), pages); // a page past the end shows the last one
      return { items: matched.slice((page - 1) * size, page * size), total: matched.length, page, pages, size, days: dates.length };
    });
  }

  // One full record (with headers and any saved matched text). ts narrows the search to its day.
  byId(id, ts) {
    if (!/^[\w-]{1,64}$/.test(String(id))) return Promise.resolve(null);
    return this.serial(async () => {
      const t = Number(ts), dates = Number.isFinite(t) && t > 0 && t < 8.64e15 ? [dayOf(t)] : this.days().map((d) => d.date).reverse();
      for (const d of dates) {
        const ent = await this.load(d), it = ent?.items.find((x) => x.ev.id === id); if (!it) continue;
        const fh = await fs.promises.open(this.file(d), 'r');
        try {
          const buf = Buffer.alloc(it.len); const { bytesRead } = await fh.read(buf, 0, it.len, it.at); // exactly this record, not the whole day
          const e = JSON.parse(buf.toString('utf8', 0, bytesRead)); if (e.id === id) return e;
        } catch { /* the file changed under us: treat as not found */ } finally { await fh.close(); }
      }
      return null;
    });
  }

  // remove saved matched text from every day file (counts and metadata stay)
  purgeMatchedText() {
    let purged = 0;
    try {
      for (const { date } of this.days()) {
        const file = this.file(date), lines = fs.readFileSync(file, 'utf8').split('\n');
        let changed = false;
        const out = lines.map((l) => {
          if (!l || !l.includes('"matches"')) return l;
          try { const e = JSON.parse(l); let hit = false; for (const h of e.hits || []) if (h.matches) { delete h.matches; purged++; hit = true; } if (!hit) return l; changed = true; return JSON.stringify(e); } catch { return l; }
        });
        if (changed) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 }); fs.renameSync(tmp, file); } // all or nothing: a crash cannot leave half a day
      }
    } finally { this.invalidate(); } // offsets in the cache no longer match the rewritten files (also if something failed halfway)
    return purged;
  }
}
