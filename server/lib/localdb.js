// Lokal ma'lumotlar bazasi — Firestore o'rniga, server kompyuterining o'z diskida.
// Loyiha kodi Firestore'ning qaysi qismini ishlatsa (collection/doc/where/orderBy/limit/count/tranzaksiya),
// shu yerda aynan o'sha ko'rinishda bor — qolgan kod o'zgarmaydi.
//
// Saqlash:
//   <papka>/c/<kolleksiya>.json — kolleksiyaning to'liq nusxasi (vaqti-vaqti bilan qayta yoziladi)
//   <papka>/journal.log         — har bir yozuv darhol shu yerga qo'shiladi (hujjatning to'liq holati, bir qator)
// Ishga tushganda: nusxalar o'qiladi, keyin jurnal ustidan qo'llanadi. Jurnal kattalashsa — nusxalarga
// yig'iladi va tozalanadi. Tok o'chsa ham ko'pi bilan oxirgi ~0,2 soniyadagi yozuv yo'qolishi mumkin.
// Hamma narsa xotirada — so'rovlar diskka murojaat qilmaydi (restoran hajmi uchun yetarli).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const JOURNAL_LIMIT = 16 * 1024 * 1024;
const SYNC_MS = 200;

/* ───────── qiymatlar ───────── */
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array);

// Yozishda: chuqur nusxa, undefined tashlanadi (Firestore ignoreUndefinedProperties kabi), Timestamp → Date
function norm(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'number' && !Number.isFinite(v) ? null : v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v.toDate === 'function') return v.toDate();
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(norm);
  if (v.constructor && v.constructor !== Object) {
    // Firebase'dan ko'chirishda uchrashi mumkin: DocumentReference → yo'l, GeoPoint → {latitude, longitude}
    if (typeof v.path === 'string' && v.firestore) return v.path;
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number') return { latitude: v.latitude, longitude: v.longitude };
  }
  const o = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = norm(x);
  return o;
}
// O'qishda: chaqiruvchi o'zgartirsa ham bazadagi nusxa buzilmasin
function copy(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(copy);
  const o = {};
  for (const k of Object.keys(v)) o[k] = copy(v[k]);
  return o;
}
// Diskka: Date → {$d}, Buffer → {$b}
export function enc(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return { $d: v.getTime() };
  if (Buffer.isBuffer(v)) return { $b: v.toString('base64') };
  if (Array.isArray(v)) return v.map(enc);
  const o = {};
  for (const k of Object.keys(v)) o[k] = enc(v[k]);
  return o;
}
export function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$d' && typeof v.$d === 'number') return new Date(v.$d);
  if (keys.length === 1 && keys[0] === '$b' && typeof v.$b === 'string') return Buffer.from(v.$b, 'base64');
  const o = {};
  for (const k of keys) o[k] = dec(v[k]);
  return o;
}

const getField = (obj, field) => {
  let cur = obj;
  for (const part of String(field).split('.')) {
    if (!isPlain(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
};

// Firestore tartibi: null < boolean < son < vaqt < matn < bayt < massiv < obyekt
const rank = (v) => (v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : v instanceof Date ? 3 : typeof v === 'string' ? 4 : Buffer.isBuffer(v) ? 5 : Array.isArray(v) ? 7 : 8);
function cmp(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 3) return a.getTime() - b.getTime();
  if (ra === 5) return Buffer.compare(a, b);
  if (ra === 7) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (ra === 8) return cmp(JSON.stringify(enc(a)), JSON.stringify(enc(b)));
  return a < b ? -1 : a > b ? 1 : 0;
}
const same = (a, b) => rank(a) === rank(b) && cmp(a, b) === 0;

function matches(doc, [field, op, value]) {
  const v = getField(doc, field);
  switch (op) {
    case '==': return v !== undefined && same(v, value);
    case '!=': return v !== undefined && v !== null && !same(v, value);
    case '<': return v !== undefined && rank(v) === rank(value) && cmp(v, value) < 0;
    case '<=': return v !== undefined && rank(v) === rank(value) && cmp(v, value) <= 0;
    case '>': return v !== undefined && rank(v) === rank(value) && cmp(v, value) > 0;
    case '>=': return v !== undefined && rank(v) === rank(value) && cmp(v, value) >= 0;
    case 'in': return v !== undefined && (value || []).some((x) => same(v, x));
    case 'not-in': return v !== undefined && v !== null && !(value || []).some((x) => same(v, x));
    case 'array-contains': return Array.isArray(v) && v.some((x) => same(x, value));
    case 'array-contains-any': return Array.isArray(v) && v.some((x) => (value || []).some((y) => same(x, y)));
    default: throw new Error(`Lokal baza: "${op}" sharti qo'llanmaydi`);
  }
}

// Firestore "merge: true" — ichki obyektlar chuqur birlashtiriladi, massivlar almashtiriladi
function deepMerge(base, patch) {
  const out = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
// update({'a.b': 1}) — nuqtali yo'l ichki maydonni o'zgartiradi
function applyUpdate(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split('.');
    if (parts.length === 1) {
      out[k] = v;
      continue;
    }
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = isPlain(cur[parts[i]]) ? { ...cur[parts[i]] } : {};
      cur = cur[parts[i]];
    }
    cur[parts.at(-1)] = v;
  }
  return out;
}

const fsErr = (code, name, msg) => Object.assign(new Error(`${code} ${name}: ${msg}`), { code, details: msg });
const AUTO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const autoId = () => Array.from(crypto.randomBytes(20), (b) => AUTO[b % 62]).join('');

/* ───────── hujjat va so'rov ───────── */
class DocSnap {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._d = data;
    this.exists = data !== undefined;
  }
  data() {
    return this._d === undefined ? undefined : copy(this._d);
  }
  get(field) {
    return this._d === undefined ? undefined : copy(getField(this._d, field));
  }
}

class DocRef {
  constructor(db, col, id) {
    this._db = db;
    this.id = String(id);
    this.parent = { id: col };
    this.path = `${col}/${this.id}`;
    this._col = col;
  }
  get firestore() {
    return this._db;
  }
  async get() {
    return this._snap();
  }
  _snap() {
    return new DocSnap(this, this._db._map(this._col).get(this.id));
  }
  async set(data, opts = {}) {
    this._db._apply([{ op: 'set', ref: this, data, opts }]);
  }
  async create(data) {
    this._db._apply([{ op: 'create', ref: this, data }]);
  }
  async update(patch) {
    this._db._apply([{ op: 'update', ref: this, data: patch }]);
  }
  async delete() {
    this._db._apply([{ op: 'delete', ref: this }]);
  }
  collection() {
    throw new Error('Lokal baza: ichki kolleksiyalar qo‘llanmaydi');
  }
}

class QuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = !docs.length;
  }
  forEach(fn) {
    this.docs.forEach(fn);
  }
}

class Query {
  constructor(db, col, q = { filters: [], order: [], lim: Infinity, off: 0 }) {
    this._db = db;
    this._col = col;
    this._q = q;
  }
  _with(patch) {
    return new Query(this._db, this._col, { ...this._q, ...patch });
  }
  where(field, op, value) {
    if (typeof field === 'object' && field) throw new Error('Lokal baza: Filter obyektlari qo‘llanmaydi');
    return this._with({ filters: [...this._q.filters, [field, op, value]] });
  }
  orderBy(field, dir = 'asc') {
    return this._with({ order: [...this._q.order, [field, dir === 'desc' ? -1 : 1]] });
  }
  limit(n) {
    return this._with({ lim: Math.max(0, Number(n) || 0) });
  }
  offset(n) {
    return this._with({ off: Math.max(0, Number(n) || 0) });
  }
  startAfter(...values) {
    return this._with({ after: values });
  }
  _rows() {
    const { filters, lim, off, after } = this._q;
    let order = this._q.order;
    // Firestore: tengsizlik sharti bo'lsa va tartib berilmagan bo'lsa — shu maydon bo'yicha
    const ineq = filters.find(([, op]) => ['<', '<=', '>', '>=', '!=', 'not-in'].includes(op));
    if (!order.length && ineq) order = [[ineq[0], 1]];
    const val = (id, d, f) => (f === '__name__' ? id : getField(d, f));
    let rows = [];
    for (const [id, d] of this._db._map(this._col)) if (filters.every((f) => matches(f[0] === '__name__' ? { __name__: id } : d, f))) rows.push([id, d]);
    if (order.length) {
      rows = rows.filter(([id, d]) => order.every(([f]) => val(id, d, f) !== undefined));
      const last = order.at(-1)[1];
      rows.sort(([ia, a], [ib, b]) => {
        for (const [f, dir] of order) {
          const c = cmp(val(ia, a, f), val(ib, b, f));
          if (c) return c * dir;
        }
        return (ia < ib ? -1 : ia > ib ? 1 : 0) * last;
      });
    } else rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (after?.length) {
      const keys = order.length ? order : [['__name__', 1]];
      rows = rows.filter(([id, d]) => {
        for (let i = 0; i < keys.length && i < after.length; i++) {
          const c = cmp(val(id, d, keys[i][0]), after[i]) * keys[i][1];
          if (c) return c > 0;
        }
        return false;
      });
    }
    return rows.slice(off, off + lim);
  }
  _snapNow() {
    return new QuerySnap(this._rows().map(([id, d]) => new DocSnap(new DocRef(this._db, this._col, id), d)));
  }
  async get() {
    return this._snapNow();
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this._rows().length }) }) };
  }
}

class ColRef extends Query {
  constructor(db, col) {
    super(db, col);
    this.id = col;
    this.path = col;
  }
  doc(id) {
    return new DocRef(this._db, this._col, id === undefined ? autoId() : id);
  }
  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
  async listDocuments() {
    return [...this._db._map(this._col).keys()].map((id) => new DocRef(this._db, this._col, id));
  }
}

/* ───────── saqlash ───────── */
const fileOf = (dir, col) => path.join(dir, 'c', `${encodeURIComponent(col)}.json`);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      // Windows: antivirus yoki indeksatsiya faylni bir lahza ushlab turishi mumkin
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      sleepSync(50);
    }
  }
}
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameRetry(tmp, file);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export class LocalDb {
  // dir yo'q bo'lsa — faqat xotirada (sinovlar uchun)
  constructor(dir = '') {
    this.store = new Map();
    this.ver = new Map();
    this.dir = dir;
    this.fd = null;
    this.bytes = 0;
    this.dirty = new Set();
    this.syncTimer = null;
    this.txChain = Promise.resolve();
    this.stats = { loadedAtMs: Date.now(), replayed: 0, skipped: 0, compactedAtMs: 0, writes: 0 };
    if (dir) this._open();
  }

  static open(dir) {
    return new LocalDb(dir);
  }

  _map(col) {
    let m = this.store.get(col);
    if (!m) {
      m = new Map();
      this.store.set(col, m);
    }
    return m;
  }

  collection(name) {
    if (!name || String(name).includes('/')) throw new Error(`Lokal baza: noto‘g‘ri kolleksiya nomi "${name}"`);
    return new ColRef(this, String(name));
  }

  async listCollections() {
    return [...this.store].filter(([, m]) => m.size).map(([id]) => this.collection(id));
  }

  async getAll(...refs) {
    return refs.map((r) => r._snap());
  }

  batch() {
    const ops = [];
    const b = {
      set: (ref, data, opts = {}) => (ops.push({ op: 'set', ref, data, opts }), b),
      create: (ref, data) => (ops.push({ op: 'create', ref, data }), b),
      update: (ref, data) => (ops.push({ op: 'update', ref, data }), b),
      delete: (ref) => (ops.push({ op: 'delete', ref }), b),
      commit: async () => this._apply(ops),
    };
    return b;
  }

  // Tranzaksiya: bir vaqtda bittasi; o'qilgan hujjat oraliqda o'zgarsa — qaytadan (Firestore kabi)
  runTransaction(fn, { maxAttempts = 5 } = {}) {
    const run = async () => {
      for (let attempt = 1; ; attempt++) {
        const reads = new Map();
        const ops = [];
        const note = (ref) => reads.set(ref.path, this.ver.get(ref.path) || 0);
        const t = {
          get: async (target) => {
            if (target instanceof DocRef) {
              note(target);
              return target._snap();
            }
            const snap = target._snapNow();
            for (const d of snap.docs) note(d.ref);
            return snap;
          },
          getAll: async (...refs) => refs.map((r) => (note(r), r._snap())),
          set: (ref, data, opts = {}) => (ops.push({ op: 'set', ref, data, opts }), t),
          create: (ref, data) => (ops.push({ op: 'create', ref, data }), t),
          update: (ref, data) => (ops.push({ op: 'update', ref, data }), t),
          delete: (ref) => (ops.push({ op: 'delete', ref }), t),
        };
        const result = await fn(t);
        const changed = [...reads].some(([p, v]) => (this.ver.get(p) || 0) !== v);
        if (!changed) {
          this._apply(ops);
          return result;
        }
        if (attempt >= maxAttempts) throw fsErr(10, 'ABORTED', 'Too much contention on these documents. Please try again.');
      }
    };
    const p = this.txChain.then(run, run);
    this.txChain = p.catch(() => {});
    return p;
  }

  // Bir nechta yozuv — hammasi tekshiriladi, keyin birdaniga qo'llanadi
  _apply(ops) {
    const next = new Map();
    const cur = (ref) => (next.has(ref.path) ? next.get(ref.path) : this._map(ref._col).get(ref.id));
    for (const { op, ref, data, opts } of ops) {
      if (!(ref instanceof DocRef)) throw new Error('Lokal baza: noto‘g‘ri hujjat havolasi');
      const prev = cur(ref);
      if (op === 'delete') next.set(ref.path, undefined);
      else if (op === 'create') {
        if (prev !== undefined) throw fsErr(6, 'ALREADY_EXISTS', `Document already exists: ${ref.path}`);
        next.set(ref.path, norm(data));
      } else if (op === 'update') {
        if (prev === undefined) throw fsErr(5, 'NOT_FOUND', `No document to update: ${ref.path}`);
        next.set(ref.path, applyUpdate(prev, norm(data)));
      } else if (op === 'set') {
        if (!isPlain(data)) throw new Error('Lokal baza: hujjat obyekt bo‘lishi kerak');
        next.set(ref.path, opts?.merge && prev !== undefined ? deepMerge(prev, norm(data)) : norm(data));
      }
    }
    for (const [p, d] of next) {
      const i = p.indexOf('/');
      this._put(p.slice(0, i), p.slice(i + 1), d);
    }
  }

  _put(col, id, data, { log = true } = {}) {
    const m = this._map(col);
    if (data === undefined) m.delete(id);
    else m.set(id, data);
    const p = `${col}/${id}`;
    this.ver.set(p, (this.ver.get(p) || 0) + 1);
    this.stats.writes++;
    if (log && this.fd !== null) this._log(col, id, data);
  }

  /* ── disk ── */
  _open() {
    fs.mkdirSync(path.join(this.dir, 'c'), { recursive: true });
    const lock = path.join(this.dir, 'LOCK');
    try {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid && pid !== process.pid && alive(pid)) throw Object.assign(new Error(`Ma'lumotlar papkasi boshqa jarayonda ochiq (pid ${pid}): ${this.dir}`), { code: 'LOCKED' });
    } catch (e) {
      if (e.code === 'LOCKED') throw e;
    }
    fs.writeFileSync(lock, String(process.pid));
    this.lockFile = lock;

    for (const f of fs.readdirSync(path.join(this.dir, 'c'))) {
      if (!f.endsWith('.json')) continue;
      const col = decodeURIComponent(f.slice(0, -5));
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'c', f), 'utf8'));
      const m = this._map(col);
      for (const [id, d] of Object.entries(raw)) m.set(id, dec(d));
    }
    const jfile = path.join(this.dir, 'journal.log');
    if (fs.existsSync(jfile)) {
      const text = fs.readFileSync(jfile, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          this.stats.skipped++; // tok o'chganda yarim yozilgan oxirgi qator
          continue;
        }
        if (!e || typeof e.c !== 'string' || typeof e.i !== 'string') continue;
        const m = this._map(e.c);
        if (e.x) m.delete(e.i);
        else m.set(e.i, dec(e.d));
        this.dirty.add(e.c);
        this.stats.replayed++;
      }
    }
    // 'a' (append) emas: Windows'da append rejimidagi faylni qisqartirib (ftruncate) va fsync qilib bo'lmaydi —
    // oddiy yozish rejimida ochib, joyini o'zimiz kuzatamiz
    if (!fs.existsSync(jfile)) fs.writeFileSync(jfile, '');
    this.fd = fs.openSync(jfile, 'r+');
    this.bytes = fs.fstatSync(this.fd).size;
    if (this.dirty.size || this.bytes) this.compact();
  }

  _log(col, id, data) {
    const line = `${JSON.stringify(data === undefined ? { c: col, i: id, x: 1 } : { c: col, i: id, d: enc(data) })}\n`;
    this.bytes += fs.writeSync(this.fd, line, this.bytes, 'utf8');
    this.dirty.add(col);
    if (!this.syncTimer) {
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null;
        try {
          if (this.fd !== null) fs.fdatasyncSync(this.fd);
        } catch (e) {
          console.error('[localdb] fsync:', e.message);
        }
      }, SYNC_MS);
      this.syncTimer.unref?.();
    }
    if (this.bytes > JOURNAL_LIMIT && !this.compactSoon) {
      this.compactSoon = setImmediate(() => {
        this.compactSoon = null;
        this.compact();
      });
    }
  }

  // Jurnalni kolleksiya nusxalariga yig'ish (o'zgargan kolleksiyalargina qayta yoziladi)
  compact() {
    if (!this.dir || this.fd === null) return;
    for (const col of this.dirty) {
      const m = this.store.get(col);
      const file = fileOf(this.dir, col);
      if (!m || !m.size) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const out = {};
      for (const [id, d] of m) out[id] = enc(d);
      writeAtomic(file, JSON.stringify(out));
    }
    this.dirty.clear();
    fs.ftruncateSync(this.fd, 0);
    fs.fsyncSync(this.fd);
    this.bytes = 0;
    this.stats.compactedAtMs = Date.now();
  }

  close() {
    if (this.fd === null) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (this.compactSoon) clearImmediate(this.compactSoon);
    this.compactSoon = null;
    try {
      this.compact();
    } finally {
      fs.closeSync(this.fd);
      this.fd = null;
      try {
        if (Number(fs.readFileSync(this.lockFile, 'utf8')) === process.pid) fs.rmSync(this.lockFile, { force: true });
      } catch {}
    }
  }

  /* ── zaxira, ko'chirish, holat ── */
  // Butun baza bitta obyektda (diskka yozish formatida)
  exportAll({ skip = [] } = {}) {
    const out = {};
    for (const [col, m] of this.store) {
      if (!m.size || skip.includes(col)) continue;
      const o = {};
      for (const [id, d] of m) o[id] = enc(d);
      out[col] = o;
    }
    return out;
  }

  // Zaxiradan tiklash yoki Firebase'dan ko'chirish: kolleksiya to'liq almashtiriladi (replace) yoki qo'shiladi
  importCollection(col, docs, { replace = false, encoded = true } = {}) {
    if (replace) for (const id of [...this._map(col).keys()]) if (!(id in docs)) this._put(col, id, undefined);
    let n = 0;
    for (const [id, d] of Object.entries(docs)) {
      this._put(col, id, norm(encoded ? dec(d) : d));
      n++;
    }
    return n;
  }

  putRaw(col, id, data) {
    this._put(col, String(id), data === undefined ? undefined : norm(data));
  }

  summary() {
    const cols = {};
    let docs = 0;
    for (const [col, m] of this.store) {
      if (!m.size) continue;
      cols[col] = m.size;
      docs += m.size;
    }
    return { docs, collections: cols, journalBytes: this.bytes, ...this.stats };
  }

  dump(col) {
    return Object.fromEntries(this.store.get(col) || []);
  }
}
