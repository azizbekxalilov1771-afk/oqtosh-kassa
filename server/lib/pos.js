import { getDb } from './firebase.js';
import { encrypt, decrypt, sha256 } from './crypto.js';
import { getReceipt, misonComment } from './receipt-settings.js';

// ───────── Mison POS — "Партнёрское API" (hujjat: https://api.mison.uz) ─────────
// 1) API kalit POST /auth/token orqali access_token'ga almashtiriladi (30 kun amal qiladi, keshlanadi)
// 2) Har so'rov: Authorization: Bearer <token>; 401 bo'lsa token yangilanib, bir marta qayta uriniladi
// 3) Menyu filial (point) bo'yicha: GET /nomenclature?point_id=... yoki GET /menus/{id}?point_id=...
// 4) Stop-list: GET /stop-list?point_id=...   5) Buyurtma: POST /orders (zal, order_type_id = 1)

export const MISON_DEFAULT_URL = 'https://backend.mison.uz/api/integrations/v1';
const baseUrl = (cfg) => String(cfg.misonApiUrl || MISON_DEFAULT_URL).replace(/\/+$/, '');
const keyId = (cfg) => sha256(`${baseUrl(cfg)}|${cfg.misonApiKey}`).slice(0, 32);

// Misonsiz rejimda (posMode = 'own') Mison'ga umuman murojaat qilinmaydi — kalit qolgan bo'lsa ham
export function posConfigured(cfg) {
  return Boolean(cfg.misonApiKey) && cfg.posMode !== 'own';
}

const HINTS = {
  401: 'API kalit noto‘g‘ri yoki Mison kabinetida o‘chirilgan',
  402: 'restoranda Mison "Партнёрское API" moduli yoqilmagan yoki to‘lanmagan',
  403: 'kalitga bu bo‘limga ruxsat berilmagan',
  404: 'topilmadi — filial (point) ID yoki menyu ID’ni tekshiring',
  429: 'so‘rovlar ko‘payib ketdi, birozdan keyin qayta urinib ko‘ring',
};

function misonError(status, data) {
  const msg = typeof data?.message === 'string' ? data.message : '';
  const hint = HINTS[status] || (status >= 500 ? 'Mison serverida xato, keyinroq urinib ko‘ring' : '');
  const e = new Error(`Mison ${status}: ${[msg, hint].filter(Boolean).join(' — ') || 'javob xato'}`.slice(0, 400));
  e.status = status;
  e.misonMessage = msg;
  return e;
}

async function readBody(res) {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    if (res.ok) throw new Error(`Mison JSON qaytarmadi: ${raw.slice(0, 150)}`);
    return { message: raw.slice(0, 200) };
  }
}

async function send(url, init, timeout = 10_000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new Error(`Mison serveriga ulanib bo‘lmadi (${url.origin}): ${e.name === 'TimeoutError' ? 'javob kelmadi' : e.cause?.code || e.message}`);
  }
}

// ── token: xotira → Firestore (shifrlangan) → /auth/token ──
// Bir vaqtdagi so'rovlar bitta token so'rovini kutadi; 401 olgan so'rov eskirgan tokenni aytadi —
// boshqasi allaqachon yangilagan bo'lsa, qayta so'ralmaydi.
const tokenMem = new Map();
const inflight = new Map();
const tokenDoc = (db) => db.collection('settings').doc('mison_token');

async function cachedToken(id, now) {
  const m = tokenMem.get(id);
  if (m && m.until > now) return m.token;
  const db = await getDb();
  if (!db) return '';
  try {
    const snap = await tokenDoc(db).get();
    const d = snap.exists ? snap.data() : null;
    const t = d?.keyId === id && d.untilMs > now ? decrypt(d.token) : '';
    if (t) tokenMem.set(id, { token: t, until: d.untilMs });
    return t || '';
  } catch (e) {
    console.warn('[mison] token keshini o‘qib bo‘lmadi:', e.message);
    return '';
  }
}

async function requestToken(cfg, id) {
  const url = new URL(`${baseUrl(cfg)}/auth/token`);
  const res = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ api_key: cfg.misonApiKey }) });
  const data = await readBody(res);
  if (!res.ok || !data.access_token) throw misonError(res.ok ? 500 : res.status, res.ok ? { message: 'access_token kelmadi' } : data);
  // Hujjat: token 30 kun yashaydi, haftasiga bir yangilash tavsiya etiladi
  const life = Math.max(60, Number(data.expires_in) || 86_400) * 1000;
  const until = Date.now() + Math.min(life / 2, 7 * 86_400_000);
  tokenMem.set(id, { token: data.access_token, until });
  const db = await getDb();
  if (db) await tokenDoc(db).set({ keyId: id, token: encrypt(data.access_token), untilMs: until }).catch((e) => console.warn('[mison] token keshlanmadi:', e.message));
  return data.access_token;
}

async function getToken(cfg, stale = '') {
  const id = keyId(cfg);
  if (inflight.has(id)) return inflight.get(id);
  const mem = tokenMem.get(id);
  if (mem && mem.until > Date.now() && mem.token !== stale) return mem.token;
  const job = (async () => {
    if (!stale) {
      const t = await cachedToken(id, Date.now());
      if (t) return t;
    }
    tokenMem.delete(id);
    return requestToken(cfg, id);
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

export async function misonRequest(cfg, path, { method = 'GET', query, body, timeout } = {}) {
  if (!posConfigured(cfg)) throw new Error('Mison API kaliti kiritilmagan');
  const url = new URL(baseUrl(cfg) + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  let stale = '';
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(cfg, stale);
    const res = await send(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, timeout);
    const data = await readBody(res);
    if (res.status === 401 && attempt === 0) {
      stale = token;
      continue;
    }
    if (!res.ok) throw misonError(res.status, data);
    return data;
  }
}

const listOf = (d, key) => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : Array.isArray(d?.data) ? d.data : Array.isArray(d?.data?.[key]) ? d.data[key] : []);
const unwrap = (d) => (d && typeof d.data === 'object' && d.data && !Array.isArray(d.data) && !d.products ? d.data : d);

// ── filiallar, menyular, to'lov turlari ──
const coord = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export async function listPoints(cfg) {
  return listOf(await misonRequest(cfg, '/points'), 'points').map((p) => ({
    id: String(p.id ?? p.uuid ?? ''), name: text(p.name) || text(p.short_name), shortName: text(p.short_name), address: text(p.address), phone: text(p.phone),
    lat: coord(p.latitude), lng: coord(p.longitude),
  })).filter((p) => p.id);
}

const pointMem = new Map();
export async function resolvePointId(cfg) {
  if (cfg.misonPointId) return cfg.misonPointId;
  const id = keyId(cfg);
  const m = pointMem.get(id);
  if (m && m.until > Date.now()) return m.value;
  const points = await listPoints(cfg);
  if (!points.length) throw new Error('Mison: bu kalitga birorta ham filial (point) biriktirilmagan');
  pointMem.set(id, { value: points[0].id, until: Date.now() + 10 * 60_000 });
  return points[0].id;
}

export async function listMenus(cfg) {
  return listOf(await misonRequest(cfg, '/menus'), 'menus').map((m) => ({ id: String(m.id), name: text(m.name), description: text(m.description) }));
}

export async function listPaymentTypes(cfg, pointId) {
  return listOf(await misonRequest(cfg, '/payment-types', { query: { point_id: pointId } }), 'payment_types')
    .map((p) => ({ id: Number(p.id), name: text(p.name), category: Number(p.category_id) }))
    .filter((p) => Number.isFinite(p.id));
}

// Naqd (1), bo'lmasa karta/terminal (2). Onlayn to'lov (5) olinmaydi — buyurtma "to'lov kutilmoqda"da qoladi.
export const defaultPaymentType = (types) => types.find((t) => t.category === 1) || types.find((t) => t.category === 2) || types.find((t) => t.category !== 5) || null;

export async function pointAlive(cfg, pointId) {
  const d = unwrap(await misonRequest(cfg, `/points/${encodeURIComponent(pointId)}/is-alive`));
  return { alive: d.is_alive !== false, since: d.shift_opened_at || '' };
}

// Stop-list: { product_id: qoldiq } — 0 = tugagan, > 0 = shuncha porsiya qolgan; ro'yxatda yo'q = cheklovsiz
export async function fetchStopList(cfg) {
  const pointId = await resolvePointId(cfg);
  const out = {};
  for (const s of listOf(await misonRequest(cfg, '/stop-list', { query: { point_id: pointId } }), 'stop_list')) {
    if (s && s.product_id !== undefined && s.product_id !== null && Number.isFinite(Number(s.quantity))) out[String(s.product_id)] = Number(s.quantity);
  }
  return { pointId, items: out };
}

// Zal va stollar (kalitda "Бронирование столов" ruxsati bo'lsa). Stol nomidan raqamini ajratib, saytdagi stol raqamiga moslanadi.
const tablesMem = new Map();
export const tableKey = (v) => String(v || '').toLowerCase().replace(/стол|stol|table|№|#/g, '').replace(/[^\p{L}\d]/gu, '');
export async function listTables(cfg, pointId) {
  const d = await misonRequest(cfg, '/reservations/halls', { query: { point_id: pointId } });
  return listOf(d, 'halls').flatMap((h) => (h?.tables || []).filter((t) => t && t.id !== undefined && t.id !== null).map((t) => ({ id: t.id, name: text(t.name) || String(t.id), hall: text(h.name), hallId: h.id ?? '', capacity: t.capacity ?? null })));
}
export async function findTableId(cfg, pointId, table) {
  const key = `${keyId(cfg)}|${pointId}`;
  let m = tablesMem.get(key);
  if (!m || m.until < Date.now()) {
    const tables = await listTables(cfg, pointId).catch((e) => {
      if (e.status !== 403 && e.status !== 404) console.warn('[mison] stollar:', e.message);
      return [];
    });
    m = { tables, until: Date.now() + 60 * 60_000 };
    tablesMem.set(key, m);
  }
  const want = tableKey(table);
  const hits = m.tables.filter((t) => tableKey(t.name) === want);
  return hits.length === 1 ? hits[0].id : null; // bir nechta zalda bir xil raqam bo'lsa — taxmin qilinmaydi
}

const orderItems = (lines) => lines.map((i) => ({
  product_id: misonId(i.id),
  quantity: i.qty,
  ...(i.mods?.length ? { modifiers: i.mods.map((m) => ({ product_id: misonId(m.id), quantity: m.qty })) } : {}),
  ...(i.note ? { comment: String(i.note).slice(0, 120) } : {}),
}));
const misonId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : id);

// Savatni Mison narxlari bilan hisoblash (stop-list va modifikatorlar ham tekshiriladi)
export async function calculateMisonOrder(cfg, lines) {
  const pointId = await resolvePointId(cfg);
  return unwrap(await misonRequest(cfg, '/orders/calculate', { method: 'POST', body: { point_id: pointId, order_type_id: 1, items: orderItems(lines) } }));
}

export async function getMisonOrder(cfg, orderId) {
  const o = unwrap(await misonRequest(cfg, `/orders/${encodeURIComponent(orderId)}`));
  const x = o.order && typeof o.order === 'object' ? o.order : o;
  return { orderId: x.order_id ?? orderId, status: x.status || '', statusName: x.status_name || '', total: x.total_amount };
}

// ── bekor qilish: faqat kassa hali qabul qilmagan bo'lsa (keyin — faqat Mison kassasining o'zida) ──
// POST /orders/{id}/cancel { cancel_cause_id?, comment? } → status DELETED; 409 — qabul qilingan yoki allaqachon bekor
export async function cancelMisonOrder(cfg, orderId, { causeId, comment } = {}) {
  const body = {
    ...(Number(causeId) ? { cancel_cause_id: Number(causeId) } : {}),
    ...(comment ? { comment: String(comment).slice(0, 200) } : {}),
  };
  try {
    const r = unwrap(await misonRequest(cfg, `/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', body, timeout: 15_000 }));
    const x = r.order && typeof r.order === 'object' ? r.order : r;
    return { ok: true, status: x.status || 'DELETED' };
  } catch (e) {
    if (e.status !== 409) throw e;
    const already = /уже отмен|already/i.test(e.misonMessage || '');
    return already
      ? { ok: true, status: 'DELETED', already: true }
      : { ok: false, accepted: true, message: e.misonMessage || 'Buyurtma kassada qabul qilingan' };
  }
}

let causesMem = { key: '', at: 0, list: [] };
export async function listCancelCauses(cfg) {
  const key = keyId(cfg);
  if (causesMem.key === key && Date.now() - causesMem.at < 10 * 60_000) return causesMem.list;
  const d = await misonRequest(cfg, '/cancel-causes');
  const list = listOf(d, 'cancel_causes').map((c) => ({ id: c.id, name: text(c.name), isDefault: Boolean(c.is_default), commentRequired: Boolean(c.is_comment_required) })).filter((c) => c.id !== undefined);
  causesMem = { key, at: Date.now(), list };
  return list;
}

// ── hisobotlar (OLAP): kalitda "Доступ к отчётам" yoqilgan bo'lishi kerak, aks holda 403 ──
// POST /reports/olap { report_type: SALES|ORDERS|PAYMENTS, date_from, date_to (≤ 92 kun), group_by, measures, ... }
export async function misonOlap(cfg, body) {
  const clean = { ...body };
  if (!clean.group_by?.length) delete clean.group_by;
  const d = await misonRequest(cfg, '/reports/olap', { method: 'POST', body: clean, timeout: 25_000 });
  const x = d && typeof d.data === 'object' && d.data && !Array.isArray(d.data) && d.data.rows ? d.data : d;
  return { rows: listOf(x, 'rows'), totals: x.totals && typeof x.totals === 'object' ? x.totals : null, freshness: Array.isArray(x.data_freshness) ? x.data_freshness : [] };
}

// ── Kassada hozir ochiq cheklar: GET /reports/cheques?status=open (kalitda "Доступ к отчётам" kerak, aks holda 403).
// Mison kassasining o'zida ochilgan stollar ham ko'rinadi; kassa o'zgarishni bulutga odatda bir necha soniyada yuboradi.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const tashkentIso = (v) => {
  const s = text(v);
  if (!s) return '';
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s.replace(' ', 'T')}+05:00` : s;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : '';
};
const chequeOf = (c) => ({
  id: String(c.id ?? ''), number: text(c.cheque_number), status: text(c.status), externalId: text(c.external_id),
  orderType: Number(c.order_type_id) || 0, orderTypeName: text(c.order_type_name),
  tableId: c.table_id === null || c.table_id === undefined || c.table_id === '' ? '' : String(c.table_id), tableName: text(c.table_name),
  hallId: c.hall_id === null || c.hall_id === undefined ? '' : String(c.hall_id), hallName: text(c.hall_name),
  guests: num(c.guests) || null, waiterName: text(c.waiter_name), cashierName: text(c.cashier_name),
  openedAt: tashkentIso(c.opened_at), minutesOpen: Number.isFinite(Number(c.minutes_open)) && c.minutes_open !== null ? Number(c.minutes_open) : null,
  goods: num(c.goods_amount), discount: num(c.discount), service: num(c.service_amount), total: num(c.total_amount),
  items: (Array.isArray(c.items) ? c.items : []).map((i) => ({
    line: String(i.line_id ?? ''), parent: i.parent_line_id === null || i.parent_line_id === undefined ? '' : String(i.parent_line_id),
    name: text(i.product_name), qty: num(i.quantity), price: num(i.price), sum: num(i.amount), comment: text(i.comment), kitchen: Boolean(i.kitchen_sent_at),
  })),
});
export async function fetchOpenCheques(cfg) {
  const pointId = await resolvePointId(cfg);
  const d = await misonRequest(cfg, '/reports/cheques', { query: { status: 'open', point_id: pointId, with_items: 'true', limit: 1000 }, timeout: 12_000 });
  const x = Array.isArray(d?.cheques) ? d : d?.data && !Array.isArray(d.data) ? d.data : d;
  const point = listOf(x, 'points').find((p) => String(p.point_id) === String(pointId)) || listOf(x, 'points')[0] || {};
  return {
    pointId, onlineEnabled: x?.is_online_cheques_enabled !== false, shiftOpen: point.is_shift_open !== false, lastSyncAt: tashkentIso(point.last_sync_at),
    cheques: listOf(x, 'cheques').filter((c) => c && c.is_open !== false && !c.closed_at && !c.deleted_at).map(chequeOf),
  };
}

// ── menyu ──
export async function fetchPosRaw(cfg) {
  const pointId = await resolvePointId(cfg);
  const query = { point_id: pointId };
  const [menu, stop] = await Promise.all([
    cfg.misonMenuId ? misonRequest(cfg, `/menus/${encodeURIComponent(cfg.misonMenuId)}`, { query }) : misonRequest(cfg, '/nomenclature', { query }),
    misonRequest(cfg, '/stop-list', { query }).catch((e) => {
      console.warn('[mison] stop-list:', e.message);
      return null;
    }),
  ]);
  const body = unwrap(menu);
  return { ...body, point_id: pointId, stop_list: stop ? listOf(stop, 'stop_list') : body.stop_list };
}

// ── buyurtma: zal (order_type_id 1), narxni Mison o'zi hisoblaydi ──
const payMem = new Map();
export async function createMisonOrder(cfg, order, externalId) {
  const delivery = order.mode === 'delivery';
  const pointId = await resolvePointId(cfg);
  const shift = await pointAlive(cfg, pointId).catch(() => null);
  if (shift && !shift.alive) throw new Error('Kassada smena ochilmagan');
  let paymentTypeId = Number(cfg.misonPaymentTypeId) || payMem.get(pointId);
  if (!paymentTypeId) {
    paymentTypeId = defaultPaymentType(await listPaymentTypes(cfg, pointId))?.id;
    if (!paymentTypeId) throw new Error('Filialda to‘lov turi topilmadi — admin panelda "To‘lov turi ID"ni kiriting');
    payMem.set(pointId, paymentTypeId);
  }
  const saboy = order.mode === 'saboy';
  // Xodim yozgan buyurtmada mijoz telefoni bo'lmasligi mumkin — xodim (yoki restoran) raqami
  const phone = String((delivery && order.deliveryPhone) || order.customerPhone || order.staffPhone || '').replace(/[^\d+]/g, '');
  if (!phone) throw new Error('Mijozning telefon raqami yo‘q');
  const tableId = delivery || saboy ? null : order.misonTableId ?? (await findTableId(cfg, pointId, order.table).catch(() => null));
  const body = {
    point_id: pointId,
    order_type_id: delivery ? 3 : saboy ? 2 : 1,
    payment_type_id: paymentTypeId,
    ...(delivery ? {
      address: { street: order.address.text, apartment: order.address.apartment || undefined, floor: order.address.floor || undefined, entrance: order.address.entrance || undefined, latitude: order.address.lat, longitude: order.address.lng },
      delivery_price: order.deliveryFee || 0,
    } : {}),
    client: { phone, ...(order.customerName ? { name: String(order.customerName).slice(0, 60) } : {}) },
    items: orderItems(order.items),
    ...(tableId !== null && tableId !== undefined ? { table_id: tableId } : {}),
    external_id: String(externalId),
    external_number: String(order.number),
    source: 'oqtoshrestoran.uz',
    persons: 1,
    // Qisqa izoh: Mison o'z chekida stol, mijoz va taomlarni baribir chiqaradi (admin → Chek ko'rinishi → Mison izohi)
    comment: misonComment(order, { tableFound: tableId !== null && tableId !== undefined, opts: (await getReceipt().catch(() => null))?.mison }),
  };
  let r;
  try {
    r = unwrap(await misonRequest(cfg, '/orders', { method: 'POST', body, timeout: 15_000 }));
  } catch (e) {
    // Filialda "olib ketish" turi yoqilmagan bo'lsa — zal buyurtmasi sifatida (izohda SABOY)
    if (!saboy || ![400, 404, 422].includes(e.status)) throw e;
    r = unwrap(await misonRequest(cfg, '/orders', { method: 'POST', body: { ...body, order_type_id: 1 }, timeout: 15_000 }));
  }
  const o = r.order && typeof r.order === 'object' ? r.order : r;
  return { orderId: o.order_id ?? o.id ?? '', status: o.status || '', statusName: o.status_name || o.status || '', total: o.total_amount, tableId };
}

// Mison javobi: { categories: [{id, name, order_number, image, parent_id}],
//   products: [{product_id, category_id, name, description, price, weight, unit, image, calories, proteins, fat, carbohydrates,
//               is_available, available_quantity, order_number, modifier_groups: [{id, name, min, max, required, free_quantity,
//               items: [{product_id, name, price, min_amount, max_amount, default_quantity, base_price_included}]}]}] }
const UNITS = { г: 'g', гр: 'g', кг: 'kg', мл: 'ml', л: 'l', шт: 'dona', порц: 'porsiya', порция: 'porsiya' };
const int = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.round(Number(v))) : d);

function weightText(w, unit) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = text(unit).toLowerCase().replace(/\.$/, '');
  return `${String(Math.round(n * 1000) / 1000).replace('.', ',')} ${UNITS[u] || u || 'g'}`.trim();
}

function nutrition(p) {
  const n = { kcal: Number(p.calories), protein: Number(p.proteins), fat: Number(p.fat), carbs: Number(p.carbohydrates) };
  for (const k of Object.keys(n)) if (!Number.isFinite(n[k]) || n[k] <= 0) delete n[k];
  else n[k] = Math.round(n[k] * 10) / 10;
  return Object.keys(n).length ? n : null;
}

function optionGroup(g, money, stop) {
  if (!g) return null;
  const items = (g.items || []).filter((i) => i && i.product_id !== undefined && i.product_id !== null && text(i.name)).map((i) => {
    const o = { id: String(i.product_id), name: text(i.name).slice(0, 80), price: money(i.price || 0) };
    if (int(i.min_amount) > 0) o.min = int(i.min_amount);
    if (int(i.max_amount) > 0) o.max = int(i.max_amount);
    if (int(i.default_quantity) > 0) o.def = int(i.default_quantity);
    if (i.base_price_included) o.incl = true;
    if (stop?.[o.id] === 0) o.off = true;
    return o;
  });
  if (!items.length) return null;
  const min = int(g.min);
  const required = Boolean(g.required) || min > 0;
  const out = { id: String(g.id ?? ''), name: (text(g.name) || 'Qo‘shimcha').slice(0, 60), min: required ? Math.max(1, min) : 0, max: int(g.max), required, items };
  if (int(g.free_quantity) > 0) out.free = int(g.free_quantity);
  return out;
}

function normalizeMison(raw, cfg) {
  const divisor = Number(cfg.misonPriceDivisor) || 1;
  const money = (v) => Math.round(toNumber(v) / divisor);
  const imageBase = cfg.misonImageBaseUrl || new URL(baseUrl(cfg)).origin;
  const cats = new Map((raw.categories || []).filter(Boolean).map((c) => [String(c.id), c]));
  // stop_list: massiv (API) yoki { id: qoldiq } (kesh)
  const stop = Array.isArray(raw.stop_list)
    ? Object.fromEntries(raw.stop_list.filter((x) => x && Number.isFinite(Number(x.quantity))).map((x) => [String(x.product_id), Number(x.quantity)]))
    : raw.stop_list && typeof raw.stop_list === 'object' ? raw.stop_list : null;
  const order = (v) => (Number.isFinite(Number(v)) ? Number(v) : 1e9);
  const seen = new Set();
  const items = [];
  for (const p of raw.products) {
    if (!p || p.product_id === undefined || p.product_id === null) continue;
    const id = String(p.product_id);
    const name = text(p.name);
    const price = toNumber(p.price);
    if (!name || !Number.isFinite(price) || seen.has(id)) continue;
    seen.add(id);
    const cat = cats.get(String(p.category_id));
    const left = stop && id in stop ? stop[id] : int(p.available_quantity, null);
    const item = {
      id,
      name: name.slice(0, 120),
      price: money(price),
      category: (text(cat?.name) || 'Boshqa').slice(0, 60),
      description: text(p.description).slice(0, 300),
      image: imageUrl(p.image, imageBase),
      // Stop-list ma'lum bo'lsa — u hal qiladi (is_available ham stop-listdan keladi)
      available: stop ? stop[id] !== 0 : p.is_available !== false && p.available_quantity !== 0,
      _sort: [order(cat?.order_number), order(p.order_number), items.length],
    };
    if (left > 0) item.left = left;
    const w = weightText(p.weight, p.unit);
    if (w) item.weight = w;
    if (UNITS[text(p.unit).toLowerCase().replace(/\.$/, '')] === 'kg' && Number(p.weight) === 1) item.perKg = true; // 1 kg narxi — og'irlik bo'yicha sotiladi
    const n = nutrition(p);
    if (n) item.nutrition = n;
    const options = (p.modifier_groups || []).map((g) => optionGroup(g, money, stop)).filter(Boolean);
    if (options.length) item.options = options;
    items.push(item);
  }
  items.sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2] - b._sort[2]);
  for (const i of items) delete i._sort;
  const used = new Set(items.map((i) => i.category));
  const categoryImages = {};
  for (const c of cats.values()) {
    const img = imageUrl(c.image, imageBase);
    if (img && used.has(text(c.name))) categoryImages[text(c.name)] = img;
  }
  return { items, categories: [...used], categoryImages, kind: 'mison' };
}

// Saqlangan menyuga yangi stop-list'ni qo'llash (menyuni qayta yuklamasdan)
export function applyStopList(items, stop) {
  return items.map((i) => {
    const q = i.id in stop ? stop[i.id] : null;
    const next = { ...i, available: q !== 0 };
    if (q > 0) next.left = q;
    else delete next.left;
    if (i.options) {
      next.options = i.options.map((g) => ({
        ...g,
        items: g.items.map((m) => {
          const x = { ...m };
          if (stop[m.id] === 0) x.off = true;
          else delete x.off;
          return x;
        }),
      }));
    }
    return next;
  });
}

export function normalizeMenu(raw, cfg = {}) {
  if (Array.isArray(raw?.products) && raw.products.some((p) => p && 'product_id' in p)) return normalizeMison(raw, cfg);
  return normalizeGeneric(raw, cfg);
}

// ───────── Boshqa tuzilmadagi javob (zaxira): ichma-ich yoki tekis ro'yxat ─────────
const NAME_KEYS = ['name', 'title', 'nameUz', 'name_uz', 'productName', 'product_name', 'dishName', 'dish_name', 'label'];
const PRICE_KEYS = ['price', 'sellPrice', 'sell_price', 'salePrice', 'sale_price', 'retailPrice', 'retail_price', 'basePrice', 'base_price', 'cost', 'priceUzs'];
const CAT_KEYS = ['category', 'categoryName', 'category_name', 'group', 'groupName', 'group_name', 'section'];
const CAT_ID_KEYS = ['categoryId', 'category_id', 'groupId', 'group_id', 'sectionId', 'section_id', 'parentId', 'parent_id'];
const IMG_KEYS = ['image', 'imageUrl', 'image_url', 'photo', 'photoUrl', 'photo_url', 'img', 'picture', 'thumbnail', 'images', 'photos'];
const DESC_KEYS = ['description', 'desc', 'composition', 'ingredients', 'about', 'info'];
const ID_KEYS = ['id', '_id', 'uuid', 'productId', 'product_id', 'code', 'sku'];
const HIDDEN_FLAGS = [['isActive', false], ['active', false], ['visible', false], ['isVisible', false], ['is_visible', false], ['deleted', true], ['isDeleted', true], ['is_deleted', true], ['archived', true]];
const STOP_FLAGS = [['available', false], ['isAvailable', false], ['is_available', false], ['inStock', false], ['in_stock', false], ['inStopList', true], ['stopList', true], ['stop_list', true], ['isStopped', true]];

function text(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['uz', 'uz_latn', 'uzLatn', 'ru', 'en', 'name', 'title']) if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    const first = Object.values(v).find((x) => typeof x === 'string' && x.trim());
    return first ? first.trim() : '';
  }
  return '';
}

function pick(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[\s,]/g, '').replace(/[^\d.-]/g, ''));
    return v.trim() && Number.isFinite(n) ? n : NaN;
  }
  if (Array.isArray(v)) return toNumber(v[0]?.price ?? v[0]);
  if (v && typeof v === 'object') return toNumber(pick(v, ['amount', 'value', 'price']));
  return NaN;
}

const isItem = (o) => Boolean(text(pick(o, NAME_KEYS))) && Number.isFinite(toNumber(pick(o, PRICE_KEYS)));

function imageUrl(v, base) {
  const s = Array.isArray(v) ? text(v[0]?.url ?? v[0]) : typeof v === 'object' && v ? text(v.url ?? v.src) : text(v);
  if (!s) return '';
  if (/^https?:\/\//.test(s)) return s;
  try {
    return new URL(s, base.endsWith('/') ? base : `${base}/`).href;
  } catch {
    return '';
  }
}

function collectCategoryMap(raw) {
  const map = new Map();
  (function scan(node, key, depth) {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (/categor|group|section|bo.?lim|kategor/i.test(key)) {
        for (const c of node) {
          if (!c || typeof c !== 'object' || isItem(c)) continue;
          const id = text(pick(c, ID_KEYS));
          const name = text(pick(c, NAME_KEYS));
          if (id && name) map.set(id, name);
        }
      }
      for (const el of node) scan(el, key, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) scan(v, k, depth + 1);
  })(raw, '', 0);
  return map;
}

function normalizeGeneric(raw, cfg = {}) {
  const divisor = Number(cfg.misonPriceDivisor) || 1;
  const imageBase = cfg.misonImageBaseUrl || cfg.misonApiUrl || '';
  const items = [];
  const seen = new Set();
  const catMap = collectCategoryMap(raw);

  function mapItem(o, parentCategory) {
    if (HIDDEN_FLAGS.some(([k, bad]) => o[k] === bad) || o.status === 'inactive' || o.status === 'deleted') return null;
    const rawCat = pick(o, CAT_KEYS);
    const catText = text(rawCat);
    const catId = text(pick(o, CAT_ID_KEYS)) || (typeof rawCat === 'object' && rawCat ? text(pick(rawCat, ID_KEYS)) : '');
    const category = catMap.get(catText) || (catText && !/^\d+$/.test(catText) ? catText : '') || catMap.get(catId) || parentCategory || 'Boshqa';
    return {
      id: text(pick(o, ID_KEYS)) || `${category}:${text(pick(o, NAME_KEYS))}`,
      name: text(pick(o, NAME_KEYS)).slice(0, 120),
      price: Math.round(toNumber(pick(o, PRICE_KEYS)) / divisor),
      category: category.slice(0, 60),
      description: text(pick(o, DESC_KEYS)).slice(0, 300),
      image: imageUrl(pick(o, IMG_KEYS), imageBase),
      available: !STOP_FLAGS.some(([k, bad]) => o[k] === bad),
    };
  }

  function walk(node, category, depth) {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el, category, depth + 1);
      return;
    }
    if (isItem(node)) {
      const item = mapItem(node, category);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
      return; // taom ichidagi modifikatorlarga kirmaymiz
    }
    if (HIDDEN_FLAGS.some(([k, bad]) => node[k] === bad)) return;
    const hasChildList = Object.values(node).some(Array.isArray);
    const ownName = text(pick(node, NAME_KEYS));
    const next = depth > 0 && hasChildList && ownName ? ownName : category;
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, next, depth + 1);
  }

  walk(raw, '', 0);
  return { items, categories: [...new Set(items.map((i) => i.category))] };
}
