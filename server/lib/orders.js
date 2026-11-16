import crypto from 'node:crypto';
import { cached, ttlFor } from './pulse.js';
import { env, AppError } from './env.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { getMenu } from './menu.js';
import { posConfigured, createMisonOrder, calculateMisonOrder, getMisonOrder, cancelMisonOrder } from './pos.js';
import { getRestaurantInfo } from './info.js';
import { sendMessage, sendOrdersChat, escapeHtml, loginBot } from './telegram.js';
import { randomToken, randomDigits, safeEqual } from './crypto.js';
import { str, text } from './validate.js';
import { getTables, hasTables, findTable, tableLabel } from './tables.js';
import { attachToTable, noteTabActivity, openTabIds, closeTab, tabIdForTable, tabOrdersOf, attachStaffTable, openSaboyTab, loadOpenTab, moveTab, paymentOf, openSplitTab, getTabForStaff } from './tabs.js';
import { liveItems, voidedItems, voidShare, roundQty, leftQty } from './items.js';
import { shiftForPayment } from './shifts.js';
import { methodLabels } from './payments.js';
import { staffSiteUrl } from './config.js';
import { quoteDelivery, parseAddress } from './delivery.js';
import { checkQty } from './menuconfig.js';
import { listStaff, normalizePhone } from './customers.js';
import { printKitchen, getKitchen } from './kitchen.js';

// Buyurtma oqimi:
//   mijoz savatdan buyurtma beradi → status "yangi", ekranda QR kod va 4 xonali kod
//   ofitsiant QR'ni skanerlaydi (yoki raqam + kodni kiritadi) → "qabul"
//   ofitsiant rad etishi ("rad") yoki mijoz kutayotganda bekor qilishi ("bekor") mumkin.
// Narxlar har doim serverda, joriy menyudan hisoblanadi — brauzerdan kelgan narxga ishonilmaydi.

export const STATUSES = { yangi: 'Ofitsiant kutilmoqda', qabul: 'Qabul qilindi', rad: 'Qabul qilinmadi', bekor: 'Bekor qilindi' };
export const DELIVERY_STATUSES = { kutilmoqda: 'Tayyorlanmoqda', yolda: 'Kuryer yo‘lda', yetkazildi: 'Yetkazildi' };
const statusLabel = (o) => (o.mode === 'delivery' && o.status === 'yangi' ? 'Tasdiqlash kutilmoqda' : o.mode === 'delivery' && o.status === 'qabul' ? DELIVERY_STATUSES[o.deliveryStatus] || STATUSES.qabul : STATUSES[o.status] || o.status);
const fmtQty = (i) => (i.unit === 'kg' ? `${String(i.qty).replace('.', ',')} kg${i.byAmount ? ` (${formatPrice(i.byAmount)}lik)` : ''}` : `${i.qty} ×`);

// Mison buyurtma holatlari (https://api.mison.uz/orders). Zalda kuryer bosqichlari bo'lmaydi; holat o'tkazib yuborilishi mumkin.
export const MISON_STATUSES = {
  CREATED: 'Kassaga yuborildi', AWAITING_PAYMENT: 'To‘lov kutilmoqda', AWAITING_CONFIRMATION: 'Kassa tasdig‘i kutilmoqda',
  PREORDER: 'Oldindan buyurtma', UNCONFIRMED_ORDER: 'Kassada qabul qilindi', COOKING: 'Oshxonada tayyorlanmoqda',
  PACKED: 'Tayyor', TAKEN_BY_COURIER: 'Kuryerda', DELIVERED: 'Yetkazildi', CLOSED: 'Yopildi', DELETED: 'Kassada bekor qilindi',
};
const MISON_RANK = { CREATED: 1, AWAITING_PAYMENT: 1, AWAITING_CONFIRMATION: 1, PREORDER: 1, UNCONFIRMED_ORDER: 2, COOKING: 3, PACKED: 4, TAKEN_BY_COURIER: 5, DELIVERED: 6, CLOSED: 7, DELETED: 7 };
const MISON_FINAL = new Set(['CLOSED', 'DELETED']);
const misonLabel = (o) => MISON_STATUSES[o.misonStatusCode] || o.misonStatus || '';
const MAX_PENDING = 3;

const formatPrice = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;

export function tashkentDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env('TIMEZONE', 'Asia/Tashkent'), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Hujjat ID'si vaqt bo'yicha teskari tartiblanadi: Firestore ID bo'yicha o'sish tartibida
// qaytargani uchun eng yangi buyurtma birinchi keladi (qo'shimcha indeks shart emas).
const newOrderId = () => (1e13 - Date.now()).toString(36).padStart(9, '0') + crypto.randomBytes(3).toString('hex');

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

async function nextNumber(db, day) {
  const counter = db.collection('counters').doc('orders');
  return db.runTransaction(async (t) => {
    const snap = await t.get(counter);
    const cur = snap.exists ? snap.data() : {};
    const n = cur.day === day ? (cur.n || 0) + 1 : 1;
    t.set(counter, { day, n });
    return n;
  });
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
// Stol nomi: Mison'dan tanlangan bo'lsa — Mison'dagidek ("Asosiy zal · Стол 5"), aks holda "Stol 5"
export const labelOf = (o) => (o.mode === 'delivery' ? 'Yetkazib berish' : o.tableLabel || `Stol ${o.table}`);

// Mijoz tanlagan stol: Mison ro'yxatidan (tableId) yoki — Mison'da stollar bo'lmasa — qo'lda yozilgan raqam
async function resolveTable(body) {
  const tables = await getTables();
  const id = body?.tableId;
  if (hasTables(tables)) {
    const hit = findTable(tables, { id: id === undefined || id === null ? '' : String(id), name: str(body?.table, 40) });
    if (!hit) throw Object.assign(new AppError(id ? 409 : 400, id ? 'Bu stol endi yo‘q — ro‘yxatdan qayta tanlang.' : 'Stolingizni ro‘yxatdan tanlang.'), { code: 'table' });
    return { table: hit.table.name, tableHall: hit.hall.name, misonTableId: /^\d+$/.test(hit.table.id) ? Number(hit.table.id) : hit.table.id, tableLabel: tableLabel(tables.halls, hit.hall, hit.table) };
  }
  const table = str(body?.table, 10);
  if (!/^[\p{L}\d][\p{L}\d -]{0,9}$/u.test(table)) throw Object.assign(new AppError(400, 'Stol raqamini yozing.'), { code: 'table' });
  return { table, tableLabel: `Stol ${table}` };
}

export function customerView(id, o) {
  return {
    id, number: o.number, table: o.table, tableLabel: labelOf(o), items: liveItems(o.items), total: o.total, comment: o.comment || '',
    status: o.status, statusLabel: statusLabel(o), createdAt: iso(o.createdAtMs),
    acceptedAt: iso(o.acceptedAtMs), rejectReason: o.rejectReason || '',
    mode: o.mode || 'table', tabId: o.tabId || '',
    ...(o.mode === 'delivery' ? { address: o.address, deliveryFee: o.deliveryFee || 0, deliveryKm: o.deliveryKm || 0, deliveryStatus: o.deliveryStatus || '', courierName: o.courierName || '', deliveredAt: iso(o.deliveredAtMs) } : {}),
    kitchen: o.misonOrderId ? { code: o.misonStatusCode || '', label: misonLabel(o), final: MISON_FINAL.has(o.misonStatusCode) } : null,
    ...(o.status === 'yangi' ? { token: o.token, checkCode: o.checkCode } : {}),
  };
}

export function staffView(id, o) {
  return {
    id, number: o.number, day: o.day, table: o.table, tableLabel: labelOf(o), items: liveItems(o.items), voided: voidedItems(o.items), total: o.total, comment: o.comment || '',
    status: o.status, statusLabel: statusLabel(o), payment: o.payment || null, paidAt: iso(o.paidAtMs),
    customerName: o.customerName || '', customerPhone: o.customerPhone || '',
    mode: o.mode || 'table', tabId: o.tabId || '', takeaway: Boolean(o.takeaway), byStaff: Boolean(o.byStaff), createdByName: o.createdByName || '',
    ...(o.mode === 'delivery' ? { address: o.address, deliveryFee: o.deliveryFee || 0, deliveryKm: o.deliveryKm || 0, deliveryPhone: o.deliveryPhone || o.customerPhone || '', deliveryStatus: o.deliveryStatus || '', courierId: o.courierId || '', courierName: o.courierName || '', takenAt: iso(o.takenAtMs), deliveredAt: iso(o.deliveredAtMs) } : {}),
    createdAt: iso(o.createdAtMs), acceptedAt: iso(o.acceptedAtMs), acceptedByName: o.acceptedByName || '',
    rejectReason: o.rejectReason || '',
    kitchenAt: iso(o.kitchenAtMs), kitchenStations: o.kitchenStations || [], kitchenMissing: o.kitchenMissing || [],
    cancelReason: o.cancelReason || '', cancelledByName: o.cancelledByName || '', misonCancelError: o.misonCancelError || '',
    misonOpen: Boolean(o.misonOrderId) && !MISON_FINAL.has(o.misonStatusCode),
    misonOrderId: o.misonOrderId ? String(o.misonOrderId) : '', misonStatus: misonLabel(o), misonStatusCode: o.misonStatusCode || '', misonError: o.misonError || '',
  };
}

function orderText(o, title) {
  const lines = o.items.map((i) => `${fmtQty(i)} ${escapeHtml(i.name)}${i.mods?.length ? ` (${escapeHtml(modsText(i.mods))})` : ''} — ${formatPrice(i.sum)}`);
  return [
    `${title} <b>#${o.number}</b> — ${o.mode === 'delivery' ? '🛵 Yetkazib berish' : escapeHtml(labelOf(o))}`,
    o.mode === 'delivery' ? `📍 ${escapeHtml(o.address.text)}${o.address.apartment ? `, kv. ${escapeHtml(o.address.apartment)}` : ''} (${o.deliveryKm} km, yetkazish ${formatPrice(o.deliveryFee)})` : null,
    '',
    ...lines,
    `<b>Jami: ${formatPrice(o.total)}</b>`,
    o.comment ? `Izoh: ${escapeHtml(o.comment)}` : null,
    `Mijoz: ${escapeHtml(o.customerName || '—')}${o.customerPhone ? `, ${escapeHtml(o.customerPhone)}` : ''}`,
  ].filter((l) => l !== null).join('\n');
}

// Hamma xodimga (ofitsiant/kassir/kuryer) shaxsiy Telegram xabari — verifikatsiya boti orqali (ular shu bot bilan kirgan)
async function notifyStaff(cfg, roles, html) {
  let staff = [];
  try {
    staff = (await listStaff()).filter((s) => roles.includes(s.role));
  } catch (e) {
    return console.error('[orders] xodimlar ro‘yxati:', e.message);
  }
  await Promise.all(staff.map((s) => notify(() => sendMessage(loginBot(cfg), s.id, html))));
}
// Xodim sahifalari admin saytida (/xodim/...)
const staffLink = (id, page = 'ofitsiant') => {
  const site = staffSiteUrl();
  return /^https:\/\//.test(site) ? `\n\n<a href="${site}/xodim/${page}.html#o=${id}">Buyurtmani ochish</a>` : '';
};

export const modsText = (mods) => mods.map((m) => (m.qty > 1 ? `${m.name} ×${m.qty}` : m.name)).join(', ');

async function notify(fn) {
  try {
    await fn();
  } catch (e) {
    console.error('[orders] Telegram:', e.message);
  }
}

// Qabul qilingan buyurtma Mison kassasiga tushadi (POST /orders, zal). external_id = bizning ID —
// qayta yuborilsa Mison dublikat yaratmaydi. Xato bo'lsa buyurtma baribir qabul qilingan bo'ladi,
// xato matni saqlanadi va admin paneldan qayta yuboriladi.
const misonOn = (cfg) => posConfigured(cfg) && cfg.misonOrders !== 'off';

async function sendToMison(id, order, cfg, { alertChat = true } = {}) {
  if (!misonOn(cfg)) return null;
  try {
    const r = await createMisonOrder(cfg, order, id);
    return { misonOrderId: String(r.orderId ?? ''), misonStatus: r.statusName || '', misonStatusCode: r.status || '', misonError: '', misonSentAtMs: Date.now(), misonCheckedAtMs: Date.now(), ...(r.tableId !== null && r.tableId !== undefined ? { misonTableId: r.tableId } : {}) };
  } catch (e) {
    console.error('[orders] Mison:', e.message);
    if (alertChat) await notify(() => sendOrdersChat(cfg, `⚠️ <b>#${order.number}</b> (${escapeHtml(labelOf(order))}) Mison kassasiga tushmadi:\n${escapeHtml(e.message)}\nKassaga qo‘lda kiriting yoki admin paneldan qayta yuboring.`));
    return { misonError: e.message.slice(0, 300) };
  }
}

export async function retryMison(id) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.status !== 'qabul') throw new AppError(409, 'Faqat qabul qilingan buyurtma Mison’ga yuboriladi.');
  if (o.misonOrderId) return staffView(id, o);
  const cfg = await getConfig();
  if (!misonOn(cfg)) throw new AppError(400, 'Mison ulanmagan yoki buyurtma yuborish o‘chirilgan (Kalitlar → Mison).');
  const patch = await sendToMison(id, o, cfg, { alertChat: false });
  await ref.update(patch);
  if (patch.misonError) throw new AppError(502, patch.misonError);
  return staffView(id, { ...o, ...patch });
}

// Holatni Mison'dan so'rash: buyurtma sahifasi ochiq turganda, 30 soniyada ko'pi bilan bir marta
const MISON_POLL_MS = 30_000;
async function refreshMisonStatus(ref, o, { force = false } = {}) {
  if (!o.misonOrderId || MISON_FINAL.has(o.misonStatusCode)) return o;
  if (!force && Date.now() - (o.misonCheckedAtMs ?? o.misonSentAtMs ?? 0) < MISON_POLL_MS) return o;
  const cfg = await getConfig();
  if (!posConfigured(cfg)) return o;
  try {
    const r = await getMisonOrder(cfg, o.misonOrderId);
    const patch = { misonCheckedAtMs: Date.now(), ...(r.status ? { misonStatusCode: r.status, misonStatus: r.statusName || r.status } : {}) };
    await ref.update(patch);
    return { ...o, ...patch };
  } catch (e) {
    console.warn('[orders] Mison holati:', e.message);
    await ref.update({ misonCheckedAtMs: Date.now() }).catch(() => {});
    return o;
  }
}

// Mison webhook "order.status_changed"
export async function applyMisonStatus(data) {
  const id = String(data?.external_id || '');
  if (!/^[a-z0-9]{9,20}$/.test(id) || !data.status) return { ignored: 'external_id yo‘q' };
  const db = await needDb();
  const snap = await db.collection('orders').doc(id).get();
  if (!snap.exists) return { ignored: 'buyurtma topilmadi' };
  const o = snap.data();
  if (o.misonOrderId && data.order_id && String(o.misonOrderId) !== String(data.order_id)) return { ignored: 'boshqa Mison buyurtmasi' };
  // Hodisalar tartibsiz kelishi mumkin: holat orqaga ketsa — Mison'dan tekshiriladi
  if ((MISON_RANK[data.status] || 0) < (MISON_RANK[o.misonStatusCode] || 0)) {
    const fresh = await refreshMisonStatus(snap.ref, { ...o, misonOrderId: o.misonOrderId || String(data.order_id) }, { force: true });
    return { status: fresh.misonStatusCode, checked: true };
  }
  await snap.ref.update({
    misonStatusCode: data.status, misonStatus: data.status_name || data.status, misonCheckedAtMs: Date.now(),
    ...(!o.misonOrderId && data.order_id ? { misonOrderId: String(data.order_id), misonError: '' } : {}),
  });
  if (MISON_FINAL.has(data.status) && o.tabId) return { status: data.status, ...(await maybeCloseTabFromMison(o.tabId)) };
  return { status: data.status };
}

/* ───────── Mijoz ───────── */
function parseMods(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 30) throw new AppError(400, 'Qo‘shimchalar noto‘g‘ri.');
  const merged = new Map();
  for (const m of raw) {
    const id = str(m?.id, 120);
    const qty = Number(m?.qty ?? 1);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new AppError(400, 'Qo‘shimchalar noto‘g‘ri.');
    merged.set(id, Math.min(20, (merged.get(id) || 0) + qty));
  }
  return [...merged].map(([id, qty]) => ({ id, qty })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function parseItems(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new AppError(400, 'Savat bo‘sh.');
  if (raw.length > 40) throw new AppError(400, 'Savatda juda ko‘p taom.');
  const merged = new Map(); // bir xil taom + bir xil qo'shimchalar = bitta qator
  for (const it of raw) {
    const id = str(it?.id, 120);
    const mods = parseMods(it?.mods);
    // Og'irlikdagi taom summa bilan: "100 000 so'mlik jiz" → og'irligini server hisoblaydi
    if (it?.amount !== undefined && it?.amount !== null && it?.amount !== '') {
      const amount = Math.round(Number(it.amount));
      if (!id || !Number.isFinite(amount) || amount < 1000 || amount > 1e8) throw new AppError(400, 'Summa noto‘g‘ri (eng kami 1 000 so‘m).');
      const key = `${id}|a|${mods.map((m) => `${m.id}:${m.qty}`).join(',')}`;
      merged.set(key, { id, mods, qty: 0, amount: (merged.get(key)?.amount || 0) + amount });
      continue;
    }
    const qty = Math.round(Number(it?.qty) * 1000) / 1000;
    if (!id || !Number.isFinite(qty) || qty <= 0 || qty > 50) throw new AppError(400, 'Savatdagi miqdor noto‘g‘ri.');
    // oshxonaga izoh (achchiqsiz, piyozsiz…) — izohi boshqa bo'lsa alohida qator
    const note = str(it?.note, 120).replace(/\s+/g, ' ').trim();
    const key = `${id}|${mods.map((m) => `${m.id}:${m.qty}`).join(',')}|${note}`;
    const cur = merged.get(key);
    merged.set(key, { id, mods, qty: Math.min(50, Math.round(((cur?.qty || 0) + qty) * 1000) / 1000), ...(note ? { note } : {}) });
  }
  return [...merged.values()];
}

// Qo'shimchalarni menyudagi guruh qoidalari bo'yicha tekshirish va narxni hisoblash
function buildLine(m, { id, qty, mods, amount, note }) {
  const groups = m.options || [];
  const byId = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, { g, i }])));
  for (const x of mods) if (!byId.has(x.id)) throw new AppError(409, `Menyu yangilangan — "${m.name}" qo‘shimchalarini qayta tanlang.`);
  const chosen = [];
  let extra = 0;
  for (const g of groups) {
    const mine = mods.filter((x) => byId.get(x.id).g === g);
    const count = mine.reduce((s, x) => s + x.qty, 0);
    if (g.required && count < Math.max(1, g.min)) throw new AppError(409, `"${m.name}": ${g.name} — ${g.min > 1 ? `kamida ${g.min} ta ` : ''}tanlang.`);
    if (g.min && count && count < g.min) throw new AppError(409, `"${m.name}": ${g.name} — kamida ${g.min} ta tanlang.`);
    if (g.max && count > g.max) throw new AppError(409, `"${m.name}": ${g.name} — ko‘pi bilan ${g.max} ta.`);
    for (const x of mine) {
      const it = byId.get(x.id).i;
      if (it.off) throw new AppError(409, `Hozir mavjud emas: ${it.name}. Boshqasini tanlang.`);
      if (it.max && x.qty > it.max) throw new AppError(409, `"${it.name}" — ko‘pi bilan ${it.max} ta.`);
      if (it.min && x.qty < it.min) throw new AppError(409, `"${it.name}" — kamida ${it.min} ta.`);
      const paid = it.incl ? Math.max(0, x.qty - (it.def || 0)) : x.qty;
      extra += paid * it.price;
      chosen.push({ id: it.id, name: it.name, qty: x.qty, price: it.price });
    }
  }
  const price = m.price + extra;
  if (amount) {
    if (!m.byWeight) throw new AppError(400, `"${m.name}" summa bilan emas, dona bilan buyurtma qilinadi.`);
    if (!(price > 0)) throw new AppError(409, `"${m.name}" narxi yo‘q.`);
    const q = Math.round((amount / price) * 1000) / 1000;
    if (q < m.byWeight.min - 1e-9) throw new AppError(400, `"${m.name}": eng kami ${m.byWeight.min} kg (${Math.ceil(price * m.byWeight.min)} so‘m).`);
    if (q > 50) throw new AppError(400, `"${m.name}": juda ko‘p.`);
    return { id, name: m.name, price, qty: q, sum: amount, unit: 'kg', byAmount: amount, ...(chosen.length ? { mods: chosen } : {}), ...(note ? { note } : {}) };
  }
  return { id, name: m.name, price, qty, sum: Math.round(price * qty), ...(m.byWeight ? { unit: 'kg' } : {}), ...(chosen.length ? { mods: chosen } : {}), ...(note ? { note } : {}) };
}

// Mison /orders/calculate javobi: modifikatorlar o'z taomidan keyin is_modifier: true qatorlar bo'lib keladi
function applyCalc(items, calc, divisor) {
  const money = (v) => Math.round(Number(v) / divisor);
  const rows = Array.isArray(calc?.items) ? calc.items : [];
  const groups = [];
  for (const r of rows) {
    if (r?.is_modifier && groups.length) groups.at(-1).push(r);
    else groups.push([r]);
  }
  if (groups.length === items.length && groups.every((g, i) => String(g[0]?.product_id) === String(items[i].id))) {
    items.forEach((l, i) => {
      const sum = groups[i].reduce((s, r) => s + money(r.total), 0);
      if (Number.isFinite(sum) && sum >= 0) {
        l.sum = sum;
        l.price = Math.round(sum / l.qty);
      }
    });
  }
  const total = money(calc?.total_amount);
  return Number.isFinite(total) && total >= 0 ? total : items.reduce((s, i) => s + i.sum, 0);
}

// Savatni joriy menyu bo'yicha narxlash (mijoz va xodim buyurtmasi uchun umumiy)
async function priceItems(wanted, cfg) {
  const menu = await getMenu();
  if (!menu.items.length) throw new AppError(503, 'Menyu hozir mavjud emas.');
  const byId = new Map(menu.items.map((i) => [String(i.id), i]));
  const missing = [];
  const off = [];
  const items = [];
  for (const line of wanted) {
    const m = byId.get(line.id);
    if (!m) missing.push(line.id);
    else if (!m.available) off.push(m.name);
    else if (!line.amount && m.left > 0 && line.qty > m.left) throw new AppError(409, `"${m.name}" dan ${m.left} ta qoldi.`);
    else items.push(buildLine(m, line.amount ? line : { ...line, qty: checkQty(m, line.qty) }));
  }
  if (missing.length) throw new AppError(409, 'Menyu yangilangan — ba’zi taomlar endi yo‘q. Savatni tekshiring.');
  if (off.length) throw new AppError(409, `Hozir mavjud emas: ${off.join(', ')}. Savatdan olib tashlang.`);
  for (const m of new Set(items.filter((i) => byId.get(i.id).left > 0).map((i) => i.id))) {
    const total = items.filter((i) => i.id === m).reduce((s, i) => s + i.qty, 0);
    if (total > byId.get(m).left) throw new AppError(409, `"${byId.get(m).name}" dan ${byId.get(m).left} ta qoldi.`);
  }

  // Mison yoqilgan bo'lsa — savat kassa narxlari va qoidalari bo'yicha oldindan tekshiriladi
  let total = items.reduce((s, i) => s + i.sum, 0);
  if (misonOn(cfg) && menu.kind === 'mison') {
    try {
      total = applyCalc(items, await calculateMisonOrder(cfg, items), Number(cfg.misonPriceDivisor) || 1);
    } catch (e) {
      if ([400, 409, 422].includes(e.status)) {
        throw new AppError(409, `Kassa bu buyurtmani qabul qilmaydi: ${e.misonMessage || e.message}`);
      }
      console.warn('[orders] Mison hisob-kitobi:', e.message);
    }
  }

  return { items, total };
}

export async function createOrder(customer, body) {
  const info = await getRestaurantInfo();
  if (info.orderingEnabled === false) throw new AppError(409, info.orderingNote || 'Hozir onlayn buyurtma qabul qilinmayapti.');
  const mode = body?.mode === 'delivery' ? 'delivery' : 'table';
  const wanted = parseItems(body?.items);
  let where = {};
  let delivery = null;
  if (mode === 'table') where = await resolveTable(body);
  else {
    const address = parseAddress(body?.address);
    const q = await quoteDelivery(address.lat, address.lng);
    const phone = normalizePhone(body?.phone) || customer.phone || '';
    if (phone.length < 8) throw new AppError(400, 'Telefon raqamingizni yozing.');
    delivery = { address, deliveryFee: q.fee, deliveryKm: q.km, deliveryPhone: phone, minOrder: q.minOrder };
  }

  const cfg = await getConfig();
  const { items, total } = await priceItems(wanted, cfg);

  if (delivery?.minOrder && total < delivery.minOrder) throw new AppError(409, `Yetkazib berish uchun eng kam buyurtma — ${formatPrice(delivery.minOrder)}.`);

  const db = await needDb();
  const mine = await db.collection('orders').where('customerId', '==', customer.id).limit(20).get();
  if (mine.docs.filter((d) => d.data().status === 'yangi').length >= MAX_PENDING) {
    throw new AppError(429, 'Sizda tasdiqlanmagan buyurtmalar ko‘p. Avval ofitsiant ularni ko‘rib chiqsin.');
  }

  // Stol: shu mijoz egallaydi yoki uning ochiq hisobiga qo'shiladi (band bo'lsa — rad)
  const tabId = mode === 'table' ? await attachToTable(customer, where) : '';
  const day = tashkentDay();
  const number = await nextNumber(db, day);
  const id = newOrderId();
  const now = Date.now();
  const extra = delivery ? { mode, address: delivery.address, deliveryFee: delivery.deliveryFee, deliveryKm: delivery.deliveryKm, deliveryPhone: delivery.deliveryPhone, deliveryStatus: '' } : { mode, tabId };
  const order = {
    number, day, ref: `${day}-${number}`,
    customerId: customer.id, customerName: customer.name || customer.firstName || '', customerPhone: customer.phone || '',
    ...(customer.guest ? { guest: true } : {}),
    ...where, ...extra, items, total: total + (delivery?.deliveryFee || 0), itemsTotal: total, comment: text(body?.comment, 300),
    status: 'yangi', token: randomToken(16), checkCode: randomDigits(4), codeAttempts: 0,
    createdAt: new Date(now), createdAtMs: now,
  };
  await db.collection('orders').doc(id).set(order);
  const text0 = orderText(order, mode === 'delivery' ? '🛵 Yangi yetkazish' : '🔔 Yangi buyurtma');
  await notify(() => sendOrdersChat(cfg, `${text0}\n\n${mode === 'delivery' ? 'Kassa qabul qiladi.' : 'Ofitsiant qabul qiladi.'}`));
  await notifyStaff(cfg, mode === 'delivery' ? ['cashier'] : ['waiter', 'cashier'], `${text0}${staffLink(id, mode === 'delivery' ? 'kassa' : 'ofitsiant')}`);
  return customerView(id, order);
}

// Xodim buyurtmasi: ofitsiant yoki kassa o'zi yozadi — darhol "qabul" (QR va kod shart emas).
//   target 'tab'   — ochiq hisobga qo'shimcha (mijoz unutgan narsa)
//   target 'table' — stolga: bo'sh bo'lsa yangi hisob ochiladi, band bo'lsa o'sha hisobga qo'shiladi
//   target 'saboy' — olib ketish: stolsiz alohida hisob, xizmat foizi yo'q
//   takeaway: true — stol hisobidagi saboy (mijoz o'zi bilan olib ketadi) → bu taomlarga xizmat foizi qo'shilmaydi
const whereOfTab = (tab) => {
  const key = (tab.tableIds || [])[0] || '';
  const label = (tab.tableLabels || [])[0] || '';
  const mid = key.startsWith('m') ? key.slice(1) : '';
  return { table: label.replace(/^Stol\s+/i, '') || label, tableLabel: label, tableHall: tab.hall || '', ...(mid ? { misonTableId: /^\d+$/.test(mid) ? Number(mid) : mid } : {}) };
};

export async function createStaffOrder(staff, actor, body) {
  const wanted = parseItems(body?.items);
  const cfg = await getConfig();
  const { items, total } = await priceItems(wanted, cfg);
  const db = await needDb();
  const target = ['tab', 'table', 'saboy'].includes(body?.target) ? body.target : 'tab';
  const who = { ...actor, role: staff.role };
  const day = tashkentDay();
  let number;
  let tabId;
  if (target === 'saboy') {
    number = await nextNumber(db, day);
    tabId = await openSaboyTab(who, `Saboy #${number}`);
  } else if (target === 'table') {
    tabId = await attachStaffTable(await resolveTable({ tableId: body?.tableId }), who);
  } else {
    tabId = String(body?.tabId || '');
  }
  const tab = await loadOpenTab(tabId);
  if (number === undefined) number = await nextNumber(db, day);
  const saboy = tab.kind === 'saboy';
  const takeaway = saboy || Boolean(body?.takeaway);
  const where = saboy ? { tableLabel: (tab.tableLabels || [])[0] || `Saboy #${number}` } : whereOfTab(tab);
  const info = await getRestaurantInfo();
  const id = newOrderId();
  const now = Date.now();
  const order = {
    number, day, ref: `${day}-${number}`,
    customerId: tab.customerId || '', customerName: tab.customerName || '', customerPhone: tab.customerPhone || '',
    staffPhone: staff.phone || info.phone || '',
    ...where, mode: saboy ? 'saboy' : 'table', tabId, items, total, itemsTotal: total, comment: text(body?.comment, 300),
    status: 'qabul', byStaff: true, takeaway, createdById: actor.id, createdByName: actor.name,
    acceptedAt: new Date(now), acceptedAtMs: now, acceptedById: actor.id, acceptedByName: actor.name,
    token: randomToken(16), checkCode: randomDigits(4), codeAttempts: 0, createdAt: new Date(now), createdAtMs: now,
  };
  await db.collection('orders').doc(id).set(order);
  await noteTabActivity(tabId, actor).catch((e) => console.error('[orders] stol hisobi:', e.message));
  noteKitchen(order, await printKitchen(order, id, { source: 'staff' })); // oshxona cheklari (yoqilgan bo'lsa)
  const mison = await sendToMison(id, order, cfg);
  if (mison) {
    await db.collection('orders').doc(id).update(mison).catch((e) => console.error('[orders] Mison holatini saqlab bo‘lmadi:', e.message));
    Object.assign(order, mison);
  }
  await notify(() => sendOrdersChat(cfg, `${orderText(order, saboy ? '🥡 Saboy' : takeaway ? '🧾 Qo‘shimcha (saboy)' : '🧾 Qo‘shimcha')}\n\nYozdi: ${escapeHtml(actor.name)}`));
  return { order: staffView(id, order), tabId };
}

// Qaysi buyurtma hali "jarayonda": stol hisobi ochiq, yetkazish tugamagan, yangi. Yopilganlari — faqat kassada.
const RECENT_MS = 3 * 3600_000;
async function stillLive(db, docs) {
  const open = await openTabIds(db, docs.map((d) => d.data().tabId));
  const now = Date.now();
  return docs.filter((d) => {
    const o = d.data();
    if (o.status === 'yangi') return true;
    if (o.status === 'rad' || o.status === 'bekor') return now - (o.updatedAtMs || o.cancelledAtMs || o.createdAtMs) < RECENT_MS;
    if (o.mode === 'delivery') return o.deliveryStatus !== 'yetkazildi' || now - (o.deliveredAtMs || 0) < RECENT_MS;
    if (o.tabId) return !o.tabClosedAtMs && open.has(o.tabId);
    return now - o.createdAtMs < 12 * 3600_000; // stol hisobidan oldingi eski buyurtmalar
  });
}

export async function listCustomerOrders(customer) {
  const db = await needDb();
  const snap = await db.collection('orders').where('customerId', '==', customer.id).limit(60).get();
  let all = snap.docs;
  // Telegram orqali tasdiqlangan raqam: shu raqam bilan stol QR'dan (Telegram'siz) berilgan buyurtmalar ham
  if (!customer.guest && /^\+998\d{9}$/.test(customer.phone || '')) {
    const g = await db.collection('orders').where('customerPhone', '==', customer.phone).limit(60).get();
    const seen = new Set(all.map((d) => d.id));
    all = [...all, ...g.docs.filter((d) => !seen.has(d.id) && d.data().guest)];
  }
  const docs = await stillLive(db, all);
  return docs.map((d) => customerView(d.id, d.data())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadOrder(db, id) {
  if (!/^[a-z0-9]{9,20}$/.test(String(id || ''))) throw new AppError(404, 'Buyurtma topilmadi.');
  const snap = await db.collection('orders').doc(id).get();
  if (!snap.exists) throw new AppError(404, 'Buyurtma topilmadi.');
  return { ref: snap.ref, o: snap.data() };
}

const ownsOrder = (customer, o) => o.customerId === customer.id || (!customer.guest && o.guest && customer.phone && o.customerPhone === customer.phone);
export async function getCustomerOrder(customer, id) {
  const { ref, o } = await loadOrder(await needDb(), id);
  if (!ownsOrder(customer, o)) throw new AppError(404, 'Buyurtma topilmadi.');
  return customerView(id, await refreshMisonStatus(ref, o));
}

export async function cancelByCustomer(customer, id) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.customerId !== customer.id) throw new AppError(404, 'Buyurtma topilmadi.');
  if (o.status !== 'yangi') throw new AppError(409, 'Bu buyurtmani endi bekor qilib bo‘lmaydi.');
  const patch = { status: 'bekor', cancelledAt: new Date(), cancelledAtMs: Date.now() };
  await ref.update(patch);
  const cfg = await getConfig();
  await notify(() => sendOrdersChat(cfg, `↩️ Buyurtma <b>#${o.number}</b> (${escapeHtml(labelOf(o))}) mijoz tomonidan bekor qilindi.`));
  return customerView(id, { ...o, ...patch });
}

/* ───────── Ofitsiant va admin ───────── */
// Ofitsiant: kutilayotganlar (istalgan kun) + so'nggi `days` kun (sukut bo'yicha — bugun). `mine` — shu ofitsiant qabul qilgan.
// Firestore o'qishlarini tejash: bitta kun uchun — faqat bugungi buyurtmalar va javob kutayotganlar
// (oldin har so'rovda oxirgi 150 ta o'qilardi). Natija bir necha soniya umumiy keshda (p — sahifa ko'rgan
// "yurak urishi"; o'zgarishdan keyingi birinchi so'rov yangisini oladi).
export async function listOrdersForStaff(actorId = '', { days, mode, liveOnly = false, p = '' } = {}) {
  const n = Math.min(31, Math.max(1, Math.round(Number(days)) || 1));
  const from = tashkentDay(new Date(Date.now() - (n - 1) * 86_400_000));
  const rows = await cached(`staff-orders|${n}|${liveOnly}|${p}`, ttlFor(p), async () => {
    const db = await needDb();
    let docs;
    if (n === 1) {
      const [today, pending] = await Promise.all([
        db.collection('orders').where('day', '==', from).limit(800).get(),
        db.collection('orders').where('status', '==', 'yangi').limit(100).get(),
      ]);
      docs = [...new Map([...today.docs, ...pending.docs].map((d) => [d.id, d])).values()].sort((a, b) => (b.data().createdAtMs || 0) - (a.data().createdAtMs || 0));
    } else docs = (await db.collection('orders').orderBy('createdAtMs', 'desc').limit(500).get()).docs;
    if (liveOnly) docs = await stillLive(db, docs);
    return docs.map((d) => ({ id: d.id, o: d.data() }));
  });
  return rows
    .map(({ id, o }) => ({ ...staffView(id, o), mine: Boolean(actorId && o.acceptedById === actorId) }))
    .filter((o) => (!mode || (mode === 'table' ? o.mode !== 'delivery' : o.mode === mode)) && (o.status === 'yangi' || o.day >= from));
}

// Ofitsiantning bugungi natijasi (yopilgan hisoblar ham kiradi)
export async function staffStats(actorId, { p = '' } = {}) {
  const today = tashkentDay();
  return cached(`staff-stats|${actorId}|${today}|${p}`, ttlFor(p, 120_000, 30_000), async () => {
    const db = await needDb();
    // faqat bugungi (oldin — xodimning oxirgi 300 ta buyurtmasi har so'rovda o'qilardi)
    const snap = await db.collection('orders').where('acceptedById', '==', actorId).where('day', '==', today).limit(300).get();
    const mine = snap.docs.map((d) => d.data()).filter((o) => o.status === 'qabul');
    return { acceptedToday: mine.length, sumToday: mine.reduce((s, o) => s + (o.total || 0), 0) };
  });
}

// Mison kassasida chek yopilsa — saytdagi stol hisobi ham yopiladi (barcha qabul qilingan buyurtmalar CLOSED bo'lsa)
export async function maybeCloseTabFromMison(tabId, { refresh = false } = {}) {
  if (!tabId) return { ignored: 'hisob yo‘q' };
  const db = await needDb();
  const tab = await db.collection('tabs').doc(tabId).get();
  if (!tab.exists || tab.data().status !== 'open') return { ignored: 'hisob ochiq emas' };
  let orders = await tabOrdersOf(tabId);
  if (refresh) {
    orders = await Promise.all(orders.map(async (o) => (o.status === 'qabul' ? { id: o.id, ...(await refreshMisonStatus(db.collection('orders').doc(o.id), o, { force: true })) } : o)));
  }
  const accepted = orders.filter((o) => o.status === 'qabul');
  if (!accepted.length || orders.some((o) => o.status === 'yangi')) return { ignored: 'hisobda faol buyurtma bor' };
  if (!accepted.every((o) => o.misonOrderId && MISON_FINAL.has(o.misonStatusCode))) return { ignored: 'Mison’da hali ochiq buyurtma bor' };
  await closeTab(tabId, { id: 'mison', name: 'Mison kassa' });
  return { tabClosed: tabId };
}

// Mison webhook "cheque.closed" / "cheque.deleted"
export async function applyChequeEvent(data) {
  const db = await needDb();
  let tabId = null;
  const ext = String(data?.external_id || '');
  if (/^[a-z0-9]{9,20}$/.test(ext)) {
    const snap = await db.collection('orders').doc(ext).get();
    if (snap.exists) tabId = snap.data().tabId || null;
  }
  if (!tabId && data?.table_id !== undefined && data?.table_id !== null) tabId = await tabIdForTable(String(data.table_id));
  if (!tabId) return { ignored: 'stol hisobi topilmadi' };
  return maybeCloseTabFromMison(tabId, { refresh: true });
}

export async function listOrdersForAdmin() {
  const db = await needDb();
  const snap = await db.collection('orders').orderBy('createdAtMs', 'desc').limit(300).get();
  return snap.docs.map((d) => staffView(d.id, d.data()));
}

export async function getOrderForStaff(id) {
  const { ref, o } = await loadOrder(await needDb(), id);
  return staffView(id, await refreshMisonStatus(ref, o));
}

// Bugungi buyurtma raqami bo'yicha (QR skanerlanmasa, qo'lda kiritish uchun)
export async function findTodayByNumber(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'Buyurtma raqamini yozing.');
  const db = await needDb();
  const snap = await db.collection('orders').where('ref', '==', `${tashkentDay()}-${n}`).limit(1).get();
  if (snap.empty) throw new AppError(404, `Bugun #${n} raqamli buyurtma yo‘q.`);
  return staffView(snap.docs[0].id, snap.docs[0].data());
}

// actor: { id, name, admin } — admin QR/kodsiz qabul qila oladi, ofitsiant uchun QR tokeni yoki kod shart
export async function acceptOrder(id, { token, code } = {}, actor) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.status === 'qabul') throw new AppError(409, `#${o.number} allaqachon qabul qilingan${o.acceptedByName ? ` (${o.acceptedByName})` : ''}.`);
  if (o.status !== 'yangi') throw new AppError(409, `#${o.number} — ${STATUSES[o.status] || o.status}.`);

  if (!actor.admin && token && !safeEqual(String(token), o.token)) throw new AppError(400, 'QR kod bu buyurtmaga tegishli emas.');
  if (!actor.admin && !token && code) {
    if ((o.codeAttempts || 0) >= 5) throw new AppError(429, 'Kod ko‘p marta noto‘g‘ri kiritildi.');
    if (!safeEqual(String(code).replace(/\D/g, ''), o.checkCode)) {
      await ref.update({ codeAttempts: (o.codeAttempts || 0) + 1 });
      throw new AppError(400, 'Kod noto‘g‘ri. Mijoz ekranidagi 4 xonali kodni tekshiring.');
    }
  }

  const now = Date.now();
  const patch = { status: 'qabul', acceptedAt: new Date(now), acceptedAtMs: now, acceptedById: actor.id, acceptedByName: actor.name, ...(o.mode === 'delivery' ? { deliveryStatus: 'kutilmoqda' } : {}) };
  await ref.update(patch);
  if (o.tabId) await noteTabActivity(o.tabId, actor).catch((e) => console.error('[orders] stol hisobi:', e.message));
  const order = { ...o, ...patch };
  noteKitchen(order, await printKitchen(order, id, { source: o.mode === 'delivery' ? 'delivery' : 'qr' })); // oshxona cheklari (yoqilgan bo'lsa)
  const cfg = await getConfig();
  const mison = await sendToMison(id, order, cfg);
  if (mison) {
    await ref.update(mison).catch((e) => console.error('[orders] Mison holatini saqlab bo‘lmadi:', e.message));
    Object.assign(order, mison);
  }
  const where = o.mode === 'delivery' ? 'yetkazib berish' : labelOf(o);
  await notify(() => sendMessage(loginBot(cfg), o.customerId, o.mode === 'delivery'
    ? `✅ Buyurtmangiz <b>#${o.number}</b> qabul qilindi va tayyorlanmoqda. Kuryer yo‘lga chiqqanda xabar beramiz.`
    : `✅ Buyurtmangiz <b>#${o.number}</b> qabul qilindi (${escapeHtml(where)}).\nYoqimli ishtaha!`));
  await notify(() => sendOrdersChat(cfg, `✅ <b>#${o.number}</b> (${escapeHtml(where)}) qabul qilindi — ${escapeHtml(actor.name)}`));
  if (o.mode === 'delivery') await notifyStaff(cfg, ['courier'], `${orderText(order, '🛵 Yetkazish uchun tayyor')}${staffLink(id, 'kuryer')}`);
  return staffView(id, order);
}

const noteKitchen = (order, k) => {
  if (k?.printed || k?.missing?.length) Object.assign(order, { kitchenAtMs: Date.now(), kitchenStations: k.stations || [], ...(k.missing?.length ? { kitchenMissing: k.missing } : {}) });
};

// Oshxona chekini qayta chiqarish (printer qog'ozi tugagan, chek yo'qolgan...)
export async function reprintKitchen(id) {
  const db = await needDb();
  const { o } = await loadOrder(db, id);
  if (o.status !== 'qabul') throw new AppError(409, 'Faqat qabul qilingan buyurtma oshxonaga chiqadi.');
  if (!(await getKitchen()).enabled) throw new AppError(409, 'Oshxona cheklari o‘chirilgan (admin panel → Tayyorlash joylari).');
  const r = await printKitchen(o, id, { force: true });
  if (r.error) throw new AppError(503, r.error);
  if (!r.printed) throw new AppError(409, r.missing?.length ? `Printer tanlanmagan: ${r.missing.join(', ')}.` : 'Bu taomlar hech qaysi tayyorlash joyiga bog‘lanmagan.');
  return { stations: r.stations };
}

// Kassa: qabul qilingan buyurtmani bekor qilish (sayt + Mison + oshxonaga "BEKOR" cheki).
// Mison faqat kassa hali qabul qilmagan buyurtmani API orqali o'chiradi; qabul qilingan bo'lsa — javobda aytiladi.
// Sayt tomonda allaqachon bekor bo'lgan, lekin Mison'da qolib ketgan buyurtma uchun ham ishlaydi (faqat Mison).
export async function cancelStaffOrder(id, actor, { reason = '', causeId = '' } = {}) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.status === 'yangi') throw new AppError(409, 'Hali qabul qilinmagan buyurtma — “Rad etish” tugmasini bosing.');
  const cfg = await getConfig();
  const misonOpen = Boolean(o.misonOrderId) && !MISON_FINAL.has(o.misonStatusCode) && posConfigured(cfg);
  if (o.status !== 'qabul' && !misonOpen) throw new AppError(409, `#${o.number} — ${STATUSES[o.status] || o.status}.`);
  const now = Date.now();
  const why = str(reason, 200);
  const patch = {};
  if (o.status === 'qabul') {
    Object.assign(patch, { status: 'bekor', cancelledAt: new Date(), cancelledAtMs: now, updatedAtMs: now, cancelledById: actor.id || '', cancelledByName: actor.name || '', cancelReason: why });
  }
  let mison = null;
  if (misonOpen) {
    try {
      mison = await cancelMisonOrder(cfg, o.misonOrderId, { causeId, comment: why || `Saytda bekor qilindi (${actor.name || 'kassa'})` });
    } catch (e) {
      mison = { ok: false, message: e.message };
    }
    if (mison.ok) Object.assign(patch, { misonStatusCode: 'DELETED', misonStatus: 'Mison’dan o‘chirildi', misonCheckedAtMs: now, misonCancelError: '' });
    else patch.misonCancelError = String(mison.message || '').slice(0, 300);
  }
  await ref.update(patch);
  const order = { ...o, ...patch };
  if (o.status === 'qabul') {
    if (o.tabId) await noteTabActivity(o.tabId, actor).catch(() => {});
    if (o.kitchenStations?.length && (await getKitchen()).enabled) await printKitchen({ ...order, items: liveItems(order.items) }, id, { force: true, cancel: true });
    await notify(() => sendOrdersChat(cfg, `✖️ <b>#${o.number}</b> (${escapeHtml(labelOf(o))}) bekor qilindi — ${escapeHtml(actor.name || 'kassa')}${why ? `\nSabab: ${escapeHtml(why)}` : ''}${mison && !mison.ok ? `\n⚠️ Mison: ${escapeHtml(mison.message || '')} — Mison kassasida o‘chiring.` : ''}`));
  }
  return { order: staffView(id, order), mison };
}

export async function rejectOrder(id, reason, actor) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.status !== 'yangi') throw new AppError(409, `#${o.number} — ${STATUSES[o.status] || o.status}.`);
  const now = Date.now();
  const patch = { status: 'rad', rejectReason: text(reason, 200), rejectedAt: new Date(now), rejectedAtMs: now, rejectedById: actor.id, rejectedByName: actor.name };
  await ref.update(patch);
  const cfg = await getConfig();
  await notify(() => sendMessage(loginBot(cfg), o.customerId, `❌ Buyurtmangiz <b>#${o.number}</b> qabul qilinmadi.${patch.rejectReason ? `\nSabab: ${escapeHtml(patch.rejectReason)}` : ''}`));
  return staffView(id, { ...o, ...patch });
}

/* ───────── Yetkazib berish: kassa va kuryer ───────── */
export async function listDeliveries({ days = 1 } = {}) {
  const db = await needDb();
  const snap = await db.collection('orders').where('mode', '==', 'delivery').limit(300).get();
  const from = tashkentDay(new Date(Date.now() - (Math.max(1, days) - 1) * 86_400_000));
  return snap.docs.map((d) => staffView(d.id, d.data())).filter((o) => o.status === 'yangi' || (o.status === 'qabul' && o.deliveryStatus !== 'yetkazildi') || o.day >= from)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function takeDelivery(id, actor) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.mode !== 'delivery' || o.status !== 'qabul') throw new AppError(409, 'Bu buyurtma yetkazish uchun tayyor emas.');
  if (o.deliveryStatus === 'yolda' && o.courierId !== actor.id) throw new AppError(409, `Bu buyurtmani ${o.courierName} oldi.`);
  if (o.deliveryStatus === 'yetkazildi') throw new AppError(409, 'Allaqachon yetkazilgan.');
  const patch = { deliveryStatus: 'yolda', courierId: actor.id, courierName: actor.name, takenAtMs: Date.now() };
  await ref.update(patch);
  const cfg = await getConfig();
  await notify(() => sendMessage(loginBot(cfg), o.customerId, `🛵 Buyurtmangiz <b>#${o.number}</b> yo‘lda. Kuryer: ${escapeHtml(actor.name)}.`));
  return staffView(id, { ...o, ...patch });
}

export async function markDelivered(id, actor) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.mode !== 'delivery' || o.status !== 'qabul') throw new AppError(409, 'Bu buyurtma yetkazishda emas.');
  if (o.courierId && o.courierId !== actor.id && !actor.manager) throw new AppError(403, 'Buni boshqa kuryer olgan.');
  const patch = { deliveryStatus: 'yetkazildi', deliveredAtMs: Date.now(), ...(o.courierId ? {} : { courierId: actor.id, courierName: actor.name }) };
  await ref.update(patch);
  const cfg = await getConfig();
  await notify(() => sendMessage(loginBot(cfg), o.customerId, `✅ Buyurtmangiz <b>#${o.number}</b> yetkazildi. Yoqimli ishtaha!`));
  return staffView(id, { ...o, ...patch });
}

export async function countPendingOrders() {
  const db = await getDb();
  if (!db) return null;
  try {
    const snap = await db.collection('orders').where('status', '==', 'yangi').limit(500).get();
    return snap.size ?? snap.docs.length;
  } catch {
    return null;
  }
}

// Kassa: qabul qilingan buyurtmadan taomni (yoki uning bir qismini) olib tashlash. Sabab majburiy.
// Oshxonaga shu taom uchun "BEKOR" cheki chiqadi. Mison'dagi buyurtma API orqali o'zgarmaydi — javobda aytiladi.
export async function voidOrderItem(id, actor, { idx, qty, reason } = {}) {
  const db = await needDb();
  const { ref, o } = await loadOrder(db, id);
  if (o.status !== 'qabul') throw new AppError(409, 'Faqat qabul qilingan buyurtmadan taom olib tashlanadi.');
  if (o.payment) throw new AppError(409, 'Bu buyurtma uchun to‘lov olingan — o‘zgartirib bo‘lmaydi.');
  if (o.tabId) {
    const t = await db.collection('tabs').doc(o.tabId).get();
    if (t.exists && t.data().status !== 'open') throw new AppError(409, 'Hisob yopilgan — o‘zgartirib bo‘lmaydi.');
  }
  const i = Number(idx);
  const item = Number.isInteger(i) ? o.items?.[i] : null;
  if (!item) throw new AppError(404, 'Taom topilmadi.');
  const why = str(reason, 200);
  if (!why) throw new AppError(400, 'Olib tashlash sababini yozing.');
  const left = leftQty(item);
  if (left <= 0) throw new AppError(409, 'Bu taom allaqachon olib tashlangan.');
  const q = item.unit === 'kg' ? left : Math.round(Number(qty) || 1);
  if (!(q > 0) || q > left) throw new AppError(400, `Ko‘pi bilan ${left} ta olib tashlash mumkin.`);
  const sum = voidShare(item, q);
  const now = Date.now();
  const items = o.items.map((x, k) => (k === i ? { ...x, voidQty: roundQty((x.voidQty || 0) + q), voids: [...(x.voids || []), { qty: q, sum, reason: why, byId: actor.id || '', byName: actor.name || '', atMs: now }] } : x));
  const total = Math.max(0, (o.total || 0) - sum);
  const allGone = !liveItems(items).length;
  const patch = { items, total, updatedAtMs: now, ...(allGone ? { status: 'bekor', cancelledAt: new Date(now), cancelledAtMs: now, cancelledById: actor.id || '', cancelledByName: actor.name || '', cancelReason: why } : {}) };
  await ref.update(patch);
  const order = { ...o, ...patch };
  if (o.tabId) await noteTabActivity(o.tabId, actor).catch(() => {});
  if (o.kitchenStations?.length && (await getKitchen()).enabled) await printKitchen({ ...order, items: [{ ...item, qty: q, sum, voidQty: 0, voids: [] }] }, id, { force: true, cancel: true });
  const cfg = await getConfig();
  const misonOpen = Boolean(o.misonOrderId) && !MISON_FINAL.has(o.misonStatusCode) && posConfigured(cfg);
  await notify(() => sendOrdersChat(cfg, `➖ <b>#${o.number}</b> (${escapeHtml(labelOf(o))}): ${item.unit === 'kg' ? `${String(q).replace('.', ',')} kg` : `${q} ×`} ${escapeHtml(item.name)} olib tashlandi — ${escapeHtml(actor.name || 'kassa')}\nSabab: ${escapeHtml(why)}${misonOpen ? '\n⚠️ Mison kassasida ham olib tashlang.' : ''}`));
  return { order: staffView(id, order), misonOpen };
}

// Hisobni bo'lish (bitta stolda ikki chek): tanlangan taomlar shu stolning yangi chekiga o'tadi, har bir chek alohida to'lanadi.
//   lines: [{ orderId, idx, qty }] → { tab: yangi chek, misonOrders }
// Taomlar qayta pishirilmaydi: yangi chekdagi buyurtma oshxonaga chiqmaydi va Mison'ga yuborilmaydi.
export async function splitTab(tabId, actor, { lines } = {}) {
  const db = await needDb();
  await loadOpenTab(tabId);
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, 'Yangi chekka o‘tadigan taomlarni tanlang.');
  const byOrder = new Map();
  for (const l of lines.slice(0, 200)) {
    const oid = str(l?.orderId, 40);
    const idx = Number(l?.idx);
    const qty = Number(l?.qty);
    if (!oid || !Number.isInteger(idx) || !(qty > 0)) throw new AppError(400, 'Tanlangan taomlar noto‘g‘ri.');
    byOrder.set(oid, [...(byOrder.get(oid) || []), { idx, qty }]);
  }
  const plan = [];
  for (const [oid, ls] of byOrder) {
    const { ref, o } = await loadOrder(db, oid);
    if (o.tabId !== tabId) throw new AppError(409, 'Taom boshqa hisobga tegishli. Sahifani yangilang.');
    if (o.status !== 'qabul') throw new AppError(409, `#${o.number} — faqat qabul qilingan buyurtmalarni bo‘lish mumkin.`);
    const items = o.items.map((x) => ({ ...x }));
    const moved = [];
    for (const { idx, qty } of ls) {
      const it = items[idx];
      if (!it) throw new AppError(404, 'Taom topilmadi. Sahifani yangilang.');
      const left = leftQty(it);
      const q = it.unit === 'kg' ? left : Math.round(qty);
      if (!(q > 0) || q > left) throw new AppError(400, `"${it.name}": ko‘pi bilan ${left} ta o‘tkazish mumkin.`);
      moved.push({ idx, q, sum: voidShare(it, q), item: o.items[idx] });
      it.movedQty = roundQty((it.movedQty || 0) + q);
    }
    plan.push({ id: oid, ref, o, items, moved });
  }
  // kamida bitta taom shu chekda qolishi kerak (aks holda bo'lish emas — ko'chirish)
  const planned = new Map(plan.map((p) => [p.id, p.items]));
  const rest = (await tabOrdersOf(tabId)).filter((o) => o.status === 'qabul').flatMap((o) => liveItems(planned.get(o.id) || o.items));
  if (!rest.length) throw new AppError(409, 'Hamma taomni o‘tkazib bo‘lmaydi — kamida bittasi shu chekda qolsin.');

  const { id: newTabId, splitNo } = await openSplitTab(tabId, actor);
  const day = tashkentDay();
  for (const p of plan) {
    const now = Date.now();
    const number = await nextNumber(db, day);
    const oid = newOrderId();
    const items = p.moved.map(({ item, q, sum }) => {
      const { voidQty, voids, movedQty, moves, ...rest } = item;
      return { ...rest, qty: q, sum };
    });
    const total = items.reduce((s, i) => s + i.sum, 0);
    const { misonOrderId, misonStatusCode, misonError, kitchenMissing, payment, ...base } = p.o;
    await db.collection('orders').doc(oid).set({
      ...base, number, day, ref: `${day}-${number}`, tabId: newTabId, items, total, itemsTotal: total,
      splitFrom: { orderId: p.id, number: p.o.number, tabId }, comment: p.o.comment || '',
      createdAt: new Date(now), createdAtMs: now, updatedAtMs: now, token: randomToken(16), checkCode: randomDigits(4),
    });
    const src = p.items.map((x, k) => {
      const m = p.moved.find((v) => v.idx === k);
      return m ? { ...x, moves: [...(x.moves || []), { qty: m.q, sum: m.sum, toTabId: newTabId, toOrderId: oid, splitNo, byName: actor.name || '', atMs: now }] } : x;
    });
    await p.ref.update({ items: src, total: Math.max(0, (p.o.total || 0) - total), updatedAtMs: now });
  }
  await noteTabActivity(tabId, actor).catch(() => {});
  return { tab: await getTabForStaff(newTabId), misonOrders: plan.filter((p) => p.o.misonOrderId).length };
}

// Yetkazish buyurtmasi: kassada to'lov (kerak bo'lsa avval qabul qilinadi — oshxona cheklari shu yerda chiqadi)
export async function payOrder(id, actor, rawPayment) {
  const db = await needDb();
  let { ref, o } = await loadOrder(db, id);
  if (o.mode !== 'delivery') throw new AppError(409, 'Stol buyurtmasining to‘lovi stol hisobida olinadi.');
  if (o.payment) throw new AppError(409, 'Bu buyurtma uchun to‘lov allaqachon olingan.');
  if (o.status !== 'yangi' && o.status !== 'qabul') throw new AppError(409, `#${o.number} — ${STATUSES[o.status] || o.status}.`);
  let payment = paymentOf(rawPayment || { method: 'naqd' }, o.total, actor, await methodLabels());
  const shiftId = await shiftForPayment(actor);
  const { takeQrPayment } = await import('./clickpass.js');
  payment = await takeQrPayment({ rawPayment, payment, pending: o.pendingCharge, txId: id, savePending: (r) => ref.update({ pendingCharge: r }) });
  if (o.status === 'yangi') {
    await acceptOrder(id, {}, actor);
    ({ ref, o } = await loadOrder(db, id));
  }
  const now = Date.now();
  await ref.update({ payment, shiftId, paidAtMs: now, updatedAtMs: now });
  return staffView(id, { ...o, payment, shiftId, paidAtMs: now });
}

// Stolni ko'chirish (kassa): bo'sh stolga
export async function moveTabToTable(tabId, tableId, actor) {
  const where = await resolveTable({ tableId });
  return moveTab(String(tabId || ''), where, actor);
}
