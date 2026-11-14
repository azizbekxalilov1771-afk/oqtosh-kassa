import crypto from 'node:crypto';
import { liveItems } from './items.js';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { getMenu } from './menu.js';
import { posConfigured, misonOlap } from './pos.js';
import { PAY_METHODS } from './tabs.js';
import { misonLive, ourExternalId } from './mison-live.js';

// Owner hisobotlari: savdo, eng ko'p sotilgan taomlar, soatlar, ofitsiantlar, to'lov turlari, mijozlar (CRM).
// Ikki manba:
//   mison — butun restoran (Mison kassasidagi hamma cheklar): POST /reports/olap. Kalitda "Доступ к отчётам" kerak.
//   site  — sayt orqali o'tgan buyurtmalar (QR, ofitsiant/kassa yozgani, yetkazib berish) va yopilgan hisoblar.
// Sayt ma'lumoti kunlar bo'yicha yig'ilib owner_days/{kun} da saqlanadi — o'tgan kunlar qayta o'qilmaydi
// (Firestore o'qishlari tejaladi). Mison javoblari owner_cache da 10 daqiqa (o'tgan davr — 12 soat) saqlanadi.

const TZ_OFFSET = '+05:00'; // Toshkent (yozgi vaqt yo'q)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

const dayStart = (day) => Date.parse(`${day}T00:00:00${TZ_OFFSET}`);
const addDays = (day, n) => new Date(dayStart(day) + n * 86_400_000 + 5 * 3_600_000).toISOString().slice(0, 10);
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms + 5 * 3_600_000).getUTCHours();
const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

export function normalizeRange(q = {}) {
  const t = today();
  let from = String(q.from || '');
  let to = String(q.to || '');
  if (!DAY_RE.test(from)) from = addDays(t, -6);
  if (!DAY_RE.test(to)) to = t;
  if (to > t) to = t;
  if (from > to) [from, to] = [to, from];
  const n = daysBetween(from, to).length;
  if (n > MAX_DAYS) throw new AppError(400, `Ko‘pi bilan ${MAX_DAYS} kun tanlang.`);
  return { from, to, days: n, prevFrom: addDays(from, -n), prevTo: addDays(from, -1) };
}

/* ───────── Sayt ma'lumoti: kunlik yig'indi ───────── */

const add = (map, key, patch) => {
  const cur = map[key] || (map[key] = {});
  for (const [k, v] of Object.entries(patch)) cur[k] = typeof v === 'number' ? (cur[k] || 0) + v : v;
};

async function computeSiteDay(db, day, catOf) {
  const [orders, tabs] = await Promise.all([
    db.collection('orders').where('day', '==', day).get(),
    db.collection('tabs').where('closedDay', '==', day).get(),
  ]);
  const s = { day, revenue: 0, orders: 0, items: 0, cancelled: 0, cancelledSum: 0, service: 0, tabs: 0, hours: {}, modes: {}, channels: {}, products: {}, waiters: {}, customers: {}, payments: {} };
  for (const d of orders.docs) {
    const o = d.data();
    if (o.status === 'bekor' && o.acceptedAtMs) {
      s.cancelled += 1;
      s.cancelledSum += o.total || 0;
      continue;
    }
    if (o.status !== 'qabul') continue;
    const total = o.total || 0;
    s.revenue += total;
    s.orders += 1;
    add(s.hours, String(hourOf(o.acceptedAtMs || o.createdAtMs)), { revenue: total, orders: 1 });
    add(s.modes, o.mode === 'delivery' ? 'delivery' : o.mode === 'saboy' || o.takeaway ? 'saboy' : 'table', { revenue: total, orders: 1 });
    add(s.channels, o.mode === 'delivery' ? 'delivery' : o.byStaff ? 'staff' : 'qr', { revenue: total, orders: 1 });
    for (const i of liveItems(o.items)) {
      const qty = i.unit === 'kg' ? 1 : Number(i.qty) || 0;
      s.items += qty;
      add(s.products, String(i.id || i.name), { name: i.name, category: catOf(String(i.id)) || '', qty, sum: i.sum || 0 });
    }
    const waiter = o.acceptedByName || o.createdByName || '';
    if (waiter) add(s.waiters, waiter, { name: waiter, orders: 1, revenue: total });
    if (o.customerId) add(s.customers, String(o.customerId), { name: o.customerName || '', phone: o.customerPhone || o.deliveryPhone || '', orders: 1, revenue: total, last: o.createdAtMs || 0 });
  }
  for (const d of tabs.docs) {
    const t = d.data();
    s.tabs += 1;
    s.service += t.service || 0;
    const p = t.payment;
    if (p) add(s.payments, p.method || 'naqd', { name: p.label || PAY_METHODS[p.method] || p.method, amount: p.amount ?? t.total ?? 0, count: 1 });
  }
  return s;
}

async function siteDays(db, days, catOf) {
  const t = today();
  const out = [];
  for (const day of days) {
    const ref = db.collection('owner_days').doc(day);
    const snap = await ref.get();
    // o'tgan kun, tugaganidan 3 soat keyin hisoblangan bo'lsa — yakuniy (qayta o'qilmaydi)
    if (snap.exists && day < t && snap.data().computedAtMs > dayStart(day) + 27 * 3_600_000) {
      out.push(snap.data());
      continue;
    }
    const s = await computeSiteDay(db, day, catOf);
    if (day < t) await ref.set({ ...s, computedAtMs: Date.now() }).catch(() => {});
    out.push(s);
  }
  return out;
}

function mergeSite(list) {
  const m = { revenue: 0, orders: 0, items: 0, cancelled: 0, cancelledSum: 0, service: 0, tabs: 0, hours: {}, modes: {}, channels: {}, products: {}, waiters: {}, customers: {}, payments: {} };
  for (const s of list) {
    for (const k of ['revenue', 'orders', 'items', 'cancelled', 'cancelledSum', 'service', 'tabs']) m[k] += s[k] || 0;
    for (const k of ['hours', 'modes', 'channels', 'products', 'waiters', 'payments']) for (const [key, v] of Object.entries(s[k] || {})) add(m[k], key, v);
    for (const [key, v] of Object.entries(s.customers || {})) {
      const cur = m.customers[key];
      m.customers[key] = cur ? { ...cur, name: v.name || cur.name, phone: v.phone || cur.phone, orders: cur.orders + v.orders, revenue: cur.revenue + v.revenue, last: Math.max(cur.last, v.last) } : { ...v };
    }
  }
  return m;
}

const sortBy = (arr, k) => arr.sort((a, b) => (b[k] || 0) - (a[k] || 0));

async function siteReport(range, menu) {
  const db = await needDb();
  const catOf = (() => {
    const map = new Map((menu.items || []).map((i) => [String(i.id), i.category || '']));
    return (id) => map.get(id) || '';
  })();
  const days = daysBetween(range.from, range.to);
  const [cur, prev] = await Promise.all([siteDays(db, days, catOf), siteDays(db, daysBetween(range.prevFrom, range.prevTo), catOf)]);
  const m = mergeSite(cur);
  const p = mergeSite(prev);
  const customers = sortBy(Object.entries(m.customers).map(([id, c]) => ({ id, ...c, last: c.last ? new Date(c.last).toISOString() : '' })), 'revenue');
  const prevCustomers = new Set(Object.keys(p.customers));
  const products = sortBy(Object.entries(m.products).map(([id, x]) => ({ id, name: x.name, category: x.category, qty: Math.round(x.qty * 1000) / 1000, sum: x.sum })), 'sum');
  const cats = {};
  for (const x of products) add(cats, x.category || 'Boshqa', { name: x.category || 'Boshqa', qty: x.qty, sum: x.sum });
  const totals = (x, n) => ({ revenue: x.revenue, cheques: x.orders, avg: x.orders ? Math.round(x.revenue / x.orders) : 0, customers: Object.keys(x.customers).length, service: x.service, cancelled: x.cancelled, cancelledSum: x.cancelledSum, items: x.items, perDay: n ? Math.round(x.revenue / n) : 0 });
  return {
    totals: totals(m, days.length),
    prevTotals: totals(p, days.length),
    byDay: cur.map((s) => ({ key: s.day, label: s.day, revenue: s.revenue, cheques: s.orders })),
    byHour: Array.from({ length: 24 }, (_, h) => ({ key: h, label: `${String(h).padStart(2, '0')}:00`, revenue: m.hours[h]?.revenue || 0, cheques: m.hours[h]?.orders || 0 })),
    byWeekday: weekdayStats(cur.map((s) => ({ day: s.day, revenue: s.revenue, cheques: s.orders }))),
    products,
    categories: sortBy(Object.values(cats), 'sum'),
    payments: sortBy(Object.entries(m.payments).map(([k, v]) => ({ key: k, name: v.name || PAY_METHODS[k] || k, amount: v.amount, count: v.count })), 'amount'),
    waiters: sortBy(Object.values(m.waiters).map((w) => ({ name: w.name, cheques: w.orders, revenue: w.revenue, avg: w.orders ? Math.round(w.revenue / w.orders) : 0 })), 'revenue'),
    types: sortBy([['table', 'Zalda'], ['saboy', 'Saboy (olib ketish)'], ['delivery', 'Yetkazib berish']].map(([k, name]) => ({ key: k, name, revenue: m.modes[k]?.revenue || 0, cheques: m.modes[k]?.orders || 0 })).filter((x) => x.cheques), 'revenue'),
    channels: sortBy([['qr', 'Mijoz QR orqali'], ['staff', 'Ofitsiant / kassa yozgan'], ['delivery', 'Yetkazib berish (sayt)']].map(([k, name]) => ({ key: k, name, revenue: m.channels[k]?.revenue || 0, cheques: m.channels[k]?.orders || 0 })).filter((x) => x.cheques), 'revenue'),
    customers: {
      top: customers.slice(0, 50),
      count: customers.length,
      returning: customers.filter((c) => prevCustomers.has(c.id) || c.orders > 1).length,
      fresh: customers.filter((c) => !prevCustomers.has(c.id) && c.orders === 1).length,
    },
  };
}

function weekdayStats(days) {
  const w = Array.from({ length: 7 }, (_, i) => ({ key: i, label: WEEKDAYS[i], revenue: 0, cheques: 0, n: 0 }));
  for (const d of days) {
    const x = w[weekdayOf(d.day)];
    x.revenue += d.revenue;
    x.cheques += d.cheques;
    x.n += 1;
  }
  // Dushanbadan boshlab, o'rtacha kunlik tushum
  return [1, 2, 3, 4, 5, 6, 0].map((i) => ({ ...w[i], avgRevenue: w[i].n ? Math.round(w[i].revenue / w[i].n) : 0 }));
}

/* ───────── Mison OLAP ───────── */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const colName = (row, g) => row[`${g}_name`] ?? row[g] ?? row[`${g}_id`] ?? '';
const colId = (row, g) => row[`${g}_id`] ?? row[g] ?? row[`${g}_name`] ?? '';

const memo = new Map();
async function cachedOlap(cfg, body, ttlMs) {
  const key = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 24);
  const now = Date.now();
  const m = memo.get(key);
  if (m && now - m.at < ttlMs) return m.data;
  const db = await getDb();
  const ref = db?.collection('owner_cache').doc(key);
  const snap = ref ? await ref.get().catch(() => null) : null;
  if (snap?.exists && now - snap.data().at < ttlMs) {
    const data = JSON.parse(snap.data().json);
    memo.set(key, { at: snap.data().at, data });
    return data;
  }
  const data = await misonOlap(cfg, body);
  memo.set(key, { at: now, data });
  if (ref) await ref.set({ at: now, json: JSON.stringify(data).slice(0, 900_000) }).catch(() => {});
  return data;
}

async function misonReport(cfg, range, menu) {
  const ttl = range.to < today() ? 12 * 3_600_000 : 10 * 60_000;
  const q = (report_type, group_by, measures, extra = {}) => cachedOlap(cfg, { report_type, date_from: range.from, date_to: range.to, group_by, measures, include_totals: true, ...extra }, ttl);
  const [tot, prev, days, hours, prods, cats, pays, waiters, types, clients] = await Promise.all([
    q('ORDERS', [], ['revenue', 'cheques_count', 'avg_cheque', 'guests', 'service_amount', 'discount', 'return_amount']),
    cachedOlap(cfg, { report_type: 'ORDERS', date_from: range.prevFrom, date_to: range.prevTo, group_by: [], measures: ['revenue', 'cheques_count', 'avg_cheque', 'guests', 'service_amount'], include_totals: true }, 12 * 3_600_000),
    q('ORDERS', ['date'], ['revenue', 'cheques_count']),
    q('ORDERS', ['hour'], ['revenue', 'cheques_count']),
    q('SALES', ['product'], ['quantity', 'net_amount', 'gross_profit', 'cost'], { order_by: { measure: 'net_amount', direction: 'desc' }, limit: 500 }),
    q('SALES', ['category'], ['quantity', 'net_amount']),
    q('PAYMENTS', ['payment_type'], ['amount', 'cheques_count']),
    q('ORDERS', ['waiter'], ['revenue', 'cheques_count', 'avg_cheque', 'guests']),
    q('ORDERS', ['order_type'], ['revenue', 'cheques_count']),
    q('ORDERS', ['client'], ['revenue', 'cheques_count'], { order_by: { measure: 'revenue', direction: 'desc' }, limit: 50 }).catch(() => ({ rows: [], totals: null })),
  ]);
  const T = (r) => r.totals || r.rows[0] || {};
  const t = T(tot);
  const pt = T(prev);
  const n = range.days;
  const totals = (x) => ({ revenue: num(x.revenue), cheques: num(x.cheques_count), avg: num(x.avg_cheque) || (num(x.cheques_count) ? Math.round(num(x.revenue) / num(x.cheques_count)) : 0), guests: num(x.guests), service: num(x.service_amount), discount: num(x.discount), returns: num(x.return_amount), perDay: n ? Math.round(num(x.revenue) / n) : 0 });
  const byDayMap = new Map(days.rows.map((r) => [String(colName(r, 'date')).slice(0, 10), r]));
  const dayList = daysBetween(range.from, range.to).map((d) => ({ key: d, label: d, revenue: num(byDayMap.get(d)?.revenue), cheques: num(byDayMap.get(d)?.cheques_count) }));
  const hourMap = new Map(hours.rows.map((r) => [Number(colName(r, 'hour')), r]));
  const products = prods.rows.map((r) => ({ id: String(colId(r, 'product')), name: String(colName(r, 'product')), unit: r.unit_name || '', qty: num(r.quantity), sum: num(r.net_amount), profit: num(r.gross_profit), cost: num(r.cost) })).filter((x) => x.name);
  const sold = new Set(products.flatMap((x) => [x.id, x.name.toLowerCase()]));
  return {
    totals: totals(t),
    prevTotals: totals(pt),
    byDay: dayList,
    byHour: Array.from({ length: 24 }, (_, h) => ({ key: h, label: `${String(h).padStart(2, '0')}:00`, revenue: num(hourMap.get(h)?.revenue), cheques: num(hourMap.get(h)?.cheques_count) })),
    byWeekday: weekdayStats(dayList.map((d) => ({ day: d.key, revenue: d.revenue, cheques: d.cheques }))),
    products: sortBy(products, 'sum'),
    unsold: (menu.items || []).filter((i) => i.available !== false && !sold.has(String(i.id)) && !sold.has(String(i.name).toLowerCase())).slice(0, 40).map((i) => ({ id: String(i.id), name: i.name, category: i.category || '' })),
    categories: sortBy(cats.rows.map((r) => ({ name: String(colName(r, 'category')) || 'Boshqa', qty: num(r.quantity), sum: num(r.net_amount) })), 'sum'),
    payments: sortBy(pays.rows.map((r) => ({ key: String(colId(r, 'payment_type')), name: String(colName(r, 'payment_type')), amount: num(r.amount), count: num(r.cheques_count) })), 'amount'),
    waiters: sortBy(waiters.rows.map((r) => ({ name: String(colName(r, 'waiter')) || '—', cheques: num(r.cheques_count), revenue: num(r.revenue), avg: num(r.avg_cheque), guests: num(r.guests) })), 'revenue'),
    types: sortBy(types.rows.map((r) => ({ key: String(colId(r, 'order_type')), name: String(colName(r, 'order_type')), revenue: num(r.revenue), cheques: num(r.cheques_count) })), 'revenue'),
    channels: [],
    customers: {
      top: clients.rows.map((r) => ({ id: String(colId(r, 'client')), name: String(r.client_name ?? colName(r, 'client') ?? ''), phone: String(r.client_phone || r.phone || ''), orders: num(r.cheques_count), revenue: num(r.revenue), last: '' })).filter((c) => c.name || c.phone).slice(0, 50),
      count: num(t.clients_count) || clients.rows.length,
      returning: null,
      fresh: null,
    },
    freshness: tot.freshness.map((f) => ({ point: f.point_name || '', lastSync: f.last_sync_at || '' })),
  };
}

/* ───────── umumiy ───────── */

export async function ownerReport(query = {}) {
  const range = normalizeRange(query);
  const cfg = await getConfig();
  const menu = await getMenu().catch(() => ({ items: [] }));
  const misonAvailable = posConfigured(cfg);
  let source = query.source === 'site' || !misonAvailable ? 'site' : 'mison';
  let note = '';
  let report;
  if (source === 'mison') {
    try {
      report = await misonReport(cfg, range, menu);
    } catch (e) {
      note = e.status === 403
        ? 'Mison kalitida hisobotlarga ruxsat yo‘q. Mison kabineti → Интеграции → API-ключи → kalit → «Доступ к отчётам» ni yoqing. Hozir sayt ma’lumoti ko‘rsatilmoqda.'
        : `Mison hisobotini olib bo‘lmadi (${e.message}). Hozir sayt ma’lumoti ko‘rsatilmoqda.`;
      source = 'site';
    }
  }
  if (source === 'site') {
    report = await siteReport(range, menu);
    const sold = new Set(report.products.map((x) => x.id));
    report.unsold = (menu.items || []).filter((i) => i.available !== false && !sold.has(String(i.id))).slice(0, 40).map((i) => ({ id: String(i.id), name: i.name, category: i.category || '' }));
  }
  return { range, source, sources: { mison: misonAvailable, site: true }, note, generatedAt: new Date().toISOString(), ...report };
}

/* ───────── Owner: kassa va ombor tafsilotlari (smenalar, chegirma, olib tashlash, bekor, kirim) ───────── */
// Hisobot davri bo'yicha "ipidan ignasigacha": kim nima qildi, qancha pul qayerga ketdi.
export async function ownerExtras(q = {}) {
  const { listMoves, listProducts } = await import('./stock.js');
  const { from, to } = normalizeRange(q);
  const db = await getDb();
  if (!db) return { shifts: [], discounts: { count: 0, sum: 0, list: [] }, voids: { count: 0, sum: 0, list: [] }, cancels: { count: 0, sum: 0, list: [] }, stock: null };
  const inRange = (d) => d && d >= from && d <= to;
  const dayOfMs = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const [shiftSnap, tabSnap, orderSnap, counts] = await Promise.all([
    db.collection('shifts').orderBy('openedAtMs', 'desc').limit(200).get().catch(() => ({ docs: [] })),
    db.collection('tabs').orderBy('openedAtMs', 'desc').limit(3000).get().catch(() => ({ docs: [] })),
    db.collection('orders').orderBy('createdAtMs', 'desc').limit(3000).get().catch(() => ({ docs: [] })),
    db.collection('stock_counts').orderBy('day', 'desc').limit(60).get().catch(() => ({ docs: [] })),
  ]);
  const shifts = shiftSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => inRange(dayOfMs(s.openedAtMs))).map((s) => ({
    id: s.id, number: s.number, status: s.status, openedAt: new Date(s.openedAtMs).toISOString(), closedAt: s.closedAtMs ? new Date(s.closedAtMs).toISOString() : '',
    openedByName: s.openedByName || '', closedByName: s.closedByName || '', openingCash: s.openingCash || 0,
    revenue: s.summary?.revenue ?? null, checks: s.summary?.checks ?? null, methods: s.summary?.methods || [], countedCash: s.countedCash ?? null, expectedCash: s.expectedCash ?? null, diff: s.diff ?? null,
    cashIn: (s.ops || []).filter((o) => o.type === 'in').reduce((a, o) => a + o.amount, 0), cashOut: (s.ops || []).filter((o) => o.type === 'out').reduce((a, o) => a + o.amount, 0),
    ops: (s.ops || []).map((o) => ({ type: o.type, amount: o.amount, reason: o.reason || '', byName: o.byName || '', at: new Date(o.atMs).toISOString() })),
  }));
  const tabs = tabSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.status === 'closed' && inRange(t.closedDay));
  const disc = tabs.filter((t) => t.discountAmt).map((t) => ({ table: (t.tableLabels || []).join(' + '), sum: t.discountAmt, reason: t.discount?.reason || '', byName: t.discount?.byName || '', at: new Date(t.closedAtMs).toISOString() }));
  const orders = orderSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const voids = orders.flatMap((o) => (o.items || []).flatMap((i) => (i.voids || []).filter((v) => inRange(dayOfMs(v.atMs))).map((v) => ({ number: o.number, table: o.tableLabel || '', name: i.name, qty: v.qty, sum: v.sum || 0, reason: v.reason || '', byName: v.byName || '', at: new Date(v.atMs).toISOString() }))));
  const cancels = orders.filter((o) => o.status === 'bekor' && o.cancelledById && inRange(dayOfMs(o.cancelledAtMs || o.createdAtMs))).map((o) => ({ number: o.number, table: o.tableLabel || '', sum: o.total || 0, reason: o.cancelReason || '', byName: o.cancelledByName || '', at: new Date(o.cancelledAtMs || o.createdAtMs).toISOString() }));
  const moved = tabs.filter((t) => t.movedFrom).length;
  const unpaid = tabs.filter((t) => !t.payment && !t.mergedInto);
  const pack = (list) => ({ count: list.length, sum: list.reduce((a, x) => a + x.sum, 0), list: list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60) });
  // ombor: kirim (ta'minotchilar), mahsulotlar bo'yicha kelgan, oxirgi qoldiq va kam qolganlar
  let stock = null;
  try {
    const [moves, products] = await Promise.all([listMoves({ from, to }), listProducts({ all: true })]);
    const last = counts.docs.map((d) => d.data())[0] || null;
    const sup = new Map();
    const prod = new Map();
    for (const m of moves) {
      const k = m.supplierName || 'Ta’minotchisiz';
      const c = sup.get(k) || { name: k, count: 0, total: 0 };
      sup.set(k, { ...c, count: c.count + 1, total: c.total + m.total });
      for (const l of m.lines) {
        const p = prod.get(l.productId) || { name: l.name, unit: l.unit, qty: 0, sum: 0 };
        prod.set(l.productId, { ...p, qty: Math.round((p.qty + l.qty) * 1000) / 1000, sum: p.sum + l.sum });
      }
    }
    stock = {
      totalIn: moves.reduce((a, m) => a + m.total, 0), receipts: moves.length,
      suppliers: [...sup.values()].sort((a, b) => b.total - a.total),
      products: [...prod.values()].sort((a, b) => b.sum - a.sum).slice(0, 30),
      lastCount: last ? { day: last.day, byName: last.byName || '' } : null,
      low: last ? products.filter((p) => p.minQty > 0 && last.lines?.[p.id] !== undefined && last.lines[p.id] < p.minQty).map((p) => ({ name: p.name, unit: p.unitLabel, qty: last.lines[p.id], minQty: p.minQty })) : [],
    };
  } catch (e) {
    console.error('[owner] ombor:', e.message);
  }
  // Mison kassasida hozir ochiq stollar (saytdan yuborilmagan cheklar)
  const live = await misonLive().catch(() => null);
  const mc = live && !live.error ? live.cheques.filter((c) => (c.orderType === 1 || c.tableId) && !ourExternalId(c.externalId)) : null;
  const misonOpen = mc ? { count: mc.length, sum: mc.reduce((a, c) => a + c.total, 0) } : null;
  return { range: { from, to }, shifts, discounts: pack(disc), voids: pack(voids), cancels: pack(cancels), moved, unpaid: { count: unpaid.length, sum: unpaid.reduce((a, t) => a + (t.total || 0), 0) }, stock, misonOpen };
}
