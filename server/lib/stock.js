import crypto from 'node:crypto';
import { AppError, env } from './env.js';
import { getDb } from './firebase.js';
import { str } from './validate.js';

// Ombor: mahsulotlar, ta'minotchilar, kirim (kelgan mahsulot) va kunlik qoldiq (astatka).
//   stock_products/{id}   { name, unit, category, minQty, on, createdAtMs }
//   stock_suppliers/{id}  { name, phone, note, on, createdAtMs }
//   stock_moves/{id}      { type: 'in', day, atMs, supplierId, supplierName, lines: [{ productId, name, unit, qty, price, sum }], total, note, byId, byName }
//   stock_counts/{day}    { day, lines: { productId: qty }, note, byId, byName, atMs }
// Kunlik hisobot: kechagi qoldiq + bugun kelgan − bugungi qoldiq = sarflangan.

// O'lchov birliklari. Mahsulotning asosiy birligi (qoldiq shu birlikda) + qadoqlari: "1 blok = 6 dona", "1 qop = 50 kg".
// Og'irlik va hajm o'zaro o'zi aylanadi: kg ↔ g ↔ tonna, litr ↔ ml.
export const UNITS = {
  kg: 'kg', g: 'g', t: 'tonna', l: 'litr', ml: 'ml', dona: 'dona', blok: 'blok', quti: 'quti', karobka: 'karobka', yashik: 'yashik',
  qop: 'qop', paket: 'paket', bog: 'bog‘', banka: 'banka', shisha: 'shisha', butilka: 'butilka', idish: 'idish', rulon: 'rulon', juft: 'juft', porsiya: 'porsiya', m: 'metr',
};
const SCALE = { kg: { g: 0.001, t: 1000 }, g: { kg: 1000, t: 1e6 }, t: { kg: 0.001, g: 1e-6 }, l: { ml: 0.001 }, ml: { l: 1000 } };
// Kiritilgan birlik → asosiy birlikka ko'paytiruvchi (null — bu mahsulot uchun noma'lum birlik)
export function factorOf(product, unit) {
  const u = String(unit || product.unit);
  if (u === product.unit) return 1;
  const pack = (product.packs || []).find((x) => x.unit === u);
  if (pack) return pack.size;
  return SCALE[product.unit]?.[u] ?? null;
}
// Mahsulot uchun tanlanadigan birliklar: [{ unit, label, factor }]
export const unitsOf = (p) => [
  { unit: p.unit, label: UNITS[p.unit] || p.unit, factor: 1 },
  ...(p.packs || []).map((x) => ({ unit: x.unit, label: `${UNITS[x.unit] || x.unit} (${String(x.size).replace('.', ',')} ${UNITS[p.unit] || p.unit})`, factor: x.size })),
  ...Object.entries(SCALE[p.unit] || {}).filter(([u]) => !(p.packs || []).some((x) => x.unit === u)).map(([u, f]) => ({ unit: u, label: UNITS[u], factor: f })),
];
const newId = () => (1e13 - Date.now()).toString(36).padStart(9, '0') + crypto.randomBytes(3).toString('hex');
const day = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: env('TIMEZONE', 'Asia/Tashkent'), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const stockToday = () => day();
const validDay = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return day();
  return s > day() ? day() : s;
};
const q3 = (n) => Math.round(n * 1000) / 1000;
const qty = (v, what = 'Miqdor') => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new AppError(400, `${what} noto‘g‘ri.`);
  return q3(n);
};

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}
const idOk = (id) => /^[a-z0-9]{9,20}$/.test(String(id || ''));

/* ───────── mahsulotlar va ta'minotchilar ───────── */
const productView = (id, p) => {
  const v = { id, name: p.name, unit: p.unit || 'kg', unitLabel: UNITS[p.unit] || p.unit || 'kg', packs: p.packs || [], category: p.category || '', minQty: p.minQty || 0, on: p.on !== false };
  return { ...v, units: unitsOf(v) };
};
const supplierView = (id, s) => ({ id, name: s.name, phone: s.phone || '', note: s.note || '', on: s.on !== false });

export async function listProducts({ all = false } = {}) {
  const db = await needDb();
  const snap = await db.collection('stock_products').limit(1000).get();
  return snap.docs.map((d) => productView(d.id, d.data())).filter((p) => all || p.on)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export async function listSuppliers({ all = false } = {}) {
  const db = await needDb();
  const snap = await db.collection('stock_suppliers').limit(500).get();
  return snap.docs.map((d) => supplierView(d.id, d.data())).filter((s) => all || s.on).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveProduct(id, body) {
  const db = await needDb();
  const name = str(body?.name, 60);
  if (name.length < 2) throw new AppError(400, 'Mahsulot nomini yozing.');
  const unit = UNITS[body?.unit] ? body.unit : 'kg';
  // qadoqlar: [{ unit: 'blok', size: 6 }] — 1 blok = 6 <asosiy birlik>
  const packs = [];
  for (const x of (Array.isArray(body?.packs) ? body.packs : []).slice(0, 6)) {
    if (!x?.unit || x.size === '' || x.size === undefined || x.size === null) continue;
    if (!UNITS[x.unit] || x.unit === unit) throw new AppError(400, 'Qadoq birligi asosiy birlikdan farq qilsin.');
    const size = qty(x.size, 'Qadoq miqdori');
    if (!size) throw new AppError(400, 'Qadoqda nechta borligini yozing.');
    if (!packs.some((y) => y.unit === x.unit)) packs.push({ unit: x.unit, size });
  }
  const doc = { name, unit, packs, category: str(body?.category, 40), minQty: body?.minQty === '' || body?.minQty === undefined ? 0 : qty(body.minQty, 'Eng kam qoldiq'), on: body?.on !== false };
  const all = await listProducts({ all: true });
  if (all.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw new AppError(409, `“${name}” allaqachon bor.`);
  if (id) {
    if (!idOk(id)) throw new AppError(404, 'Mahsulot topilmadi.');
    const ref = db.collection('stock_products').doc(id);
    if (!(await ref.get()).exists) throw new AppError(404, 'Mahsulot topilmadi.');
    await ref.update(doc);
    return productView(id, doc);
  }
  const nid = newId();
  await db.collection('stock_products').doc(nid).set({ ...doc, createdAtMs: Date.now() });
  return productView(nid, doc);
}

export async function saveSupplier(id, body) {
  const db = await needDb();
  const name = str(body?.name, 60);
  if (name.length < 2) throw new AppError(400, 'Ta’minotchi nomini yozing.');
  const doc = { name, phone: str(body?.phone, 30), note: str(body?.note, 120), on: body?.on !== false };
  if (id) {
    if (!idOk(id)) throw new AppError(404, 'Ta’minotchi topilmadi.');
    const ref = db.collection('stock_suppliers').doc(id);
    if (!(await ref.get()).exists) throw new AppError(404, 'Ta’minotchi topilmadi.');
    await ref.update(doc);
    return supplierView(id, doc);
  }
  const all = await listSuppliers({ all: true });
  if (all.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new AppError(409, `“${name}” allaqachon bor.`);
  const nid = newId();
  await db.collection('stock_suppliers').doc(nid).set({ ...doc, createdAtMs: Date.now() });
  return supplierView(nid, doc);
}

/* ───────── kirim ───────── */
const moveView = (id, m) => ({ id, type: m.type, day: m.day, at: new Date(m.atMs).toISOString(), supplierId: m.supplierId || '', supplierName: m.supplierName || '', lines: m.lines || [], total: m.total || 0, note: m.note || '', byName: m.byName || '' });

export async function addReceipt(actor, body) {
  const db = await needDb();
  const products = new Map((await listProducts({ all: true })).map((p) => [p.id, p]));
  const suppliers = new Map((await listSuppliers({ all: true })).map((s) => [s.id, s]));
  const sup = body?.supplierId ? suppliers.get(String(body.supplierId)) : null;
  if (body?.supplierId && !sup) throw new AppError(404, 'Ta’minotchi topilmadi.');
  const lines = [];
  for (const l of (Array.isArray(body?.lines) ? body.lines : []).slice(0, 100)) {
    const p = products.get(String(l?.productId || ''));
    if (!p) throw new AppError(404, 'Mahsulot topilmadi — ro‘yxatni yangilang.');
    const entered = qty(l.qty);
    if (!entered) continue;
    const f = factorOf(p, l.unit);
    if (!f) throw new AppError(400, `“${p.name}” uchun bu o‘lchov birligi yo‘q.`);
    // narx — kiritilgan birlik uchun (1 blok narxi, 1 kg narxi)
    const price = l.price === '' || l.price === undefined || l.price === null ? 0 : Math.round(qty(l.price, 'Narx'));
    const inUnit = l.unit || p.unit;
    lines.push({ productId: p.id, name: p.name, unit: p.unit, qty: q3(entered * f), inQty: entered, inUnit, inUnitLabel: UNITS[inUnit] || inUnit, price, sum: Math.round(entered * price) });
  }
  if (!lines.length) throw new AppError(400, 'Kamida bitta mahsulot va miqdorini yozing.');
  const now = Date.now();
  const doc = {
    type: 'in', day: validDay(body?.day), atMs: now, supplierId: sup?.id || '', supplierName: sup?.name || str(body?.supplierName, 60),
    lines, total: lines.reduce((s, l) => s + l.sum, 0), note: str(body?.note, 200), byId: actor.id || '', byName: actor.name || '',
  };
  const id = newId();
  await db.collection('stock_moves').doc(id).set(doc);
  return moveView(id, doc);
}

export async function listMoves({ days = 7, from: fromDay, to: toDay } = {}) {
  const db = await needDb();
  const to = toDay || day();
  const from = fromDay || day(new Date(Date.now() - (Math.min(92, Math.max(1, Number(days) || 7)) - 1) * 86_400_000));
  const snap = await db.collection('stock_moves').orderBy('atMs', 'desc').limit(1500).get();
  return snap.docs.map((d) => moveView(d.id, d.data())).filter((m) => m.day >= from && m.day <= to);
}

// Kirimni o'chirish: xato yozilgan bo'lsa — faqat o'sha kuni (admin istalgan payt)
export async function deleteMove(id, actor, { admin = false } = {}) {
  if (!idOk(id)) throw new AppError(404, 'Kirim topilmadi.');
  const db = await needDb();
  const ref = db.collection('stock_moves').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError(404, 'Kirim topilmadi.');
  if (!admin && snap.data().day !== day()) throw new AppError(409, 'Faqat bugungi kirimni o‘chirish mumkin. Eskisini admin o‘chiradi.');
  await ref.delete();
  return { ok: true, byName: actor?.name || '' };
}

/* ───────── kunlik qoldiq ───────── */
export async function saveCount(actor, body) {
  const db = await needDb();
  const d = validDay(body?.day);
  const products = new Map((await listProducts({ all: true })).map((p) => [p.id, p]));
  const ref = db.collection('stock_counts').doc(d);
  const prev = await ref.get();
  const lines = { ...(prev.exists ? prev.data().lines || {} : {}) };
  // qiymat: son (asosiy birlikda) yoki qismlar: [{ qty: 3, unit: 'blok' }, { qty: 2, unit: 'dona' }] → 3×6 + 2 = 20 dona
  for (const [pid, v] of Object.entries(body?.lines || {}).slice(0, 1000)) {
    const p = products.get(pid);
    if (!p) continue;
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.some((x) => x?.qty !== '' && x?.qty !== undefined && x?.qty !== null))) {
      delete lines[pid];
      continue;
    }
    if (Array.isArray(v)) {
      let total = 0;
      for (const part of v.slice(0, 6)) {
        if (part?.qty === '' || part?.qty === undefined || part?.qty === null) continue;
        const f = factorOf(p, part.unit);
        if (!f) throw new AppError(400, `“${p.name}” uchun bu o‘lchov birligi yo‘q.`);
        total += qty(part.qty, 'Qoldiq') * f;
      }
      lines[pid] = q3(total);
    } else lines[pid] = qty(v, 'Qoldiq');
  }
  const doc = { day: d, lines, note: str(body?.note, 200), byId: actor.id || '', byName: actor.name || '', atMs: Date.now() };
  await ref.set(doc);
  return stockReport(d);
}

// Kunlik hisobot: har mahsulot bo'yicha kechagi qoldiq, kelgan, sarflangan, bugungi qoldiq
export async function stockReport(dayArg) {
  const db = await needDb();
  const d = validDay(dayArg);
  const [products, counts, moves] = await Promise.all([
    listProducts({ all: true }),
    db.collection('stock_counts').orderBy('day', 'desc').limit(120).get(),
    listMoves({ from: d, to: d }),
  ]);
  const all = counts.docs.map((x) => x.data());
  const today = all.find((c) => c.day === d) || null;
  const before = all.find((c) => c.day < d) || null;
  const incoming = new Map();
  const bySupplier = new Map();
  for (const m of moves) {
    for (const l of m.lines) incoming.set(l.productId, q3((incoming.get(l.productId) || 0) + l.qty));
    const k = m.supplierName || 'Ta’minotchisiz';
    const cur = bySupplier.get(k) || { name: k, count: 0, total: 0 };
    bySupplier.set(k, { ...cur, count: cur.count + 1, total: cur.total + m.total });
  }
  const rows = products.filter((p) => p.on || incoming.has(p.id) || today?.lines?.[p.id] !== undefined).map((p) => {
    const open = before?.lines?.[p.id];
    const inQ = incoming.get(p.id) || 0;
    const close = today?.lines?.[p.id];
    const has = (v) => v !== undefined && v !== null;
    return {
      id: p.id, name: p.name, unit: p.unit, unitLabel: p.unitLabel, units: p.units, category: p.category, minQty: p.minQty,
      open: has(open) ? open : null, in: inQ, close: has(close) ? close : null,
      expected: has(open) ? q3(open + inQ) : null,
      used: has(open) && has(close) ? q3(open + inQ - close) : null,
      low: has(close) && p.minQty > 0 && close < p.minQty,
    };
  });
  return {
    day: d, prevDay: before?.day || '', counted: Boolean(today), countedByName: today?.byName || '', countedAt: today?.atMs ? new Date(today.atMs).toISOString() : '',
    note: today?.note || '', rows, moves, suppliers: [...bySupplier.values()].sort((a, b) => b.total - a.total),
    totalIn: moves.reduce((s, m) => s + m.total, 0),
  };
}
