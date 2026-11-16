import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { getTables } from './tables.js';
import { tableKey } from './pos.js';
import { callView } from './calls.js';
import { liveItems, voidedItems, movedItems } from './items.js';
import { shiftForPayment, currentShiftId } from './shifts.js';
import { str } from './validate.js';
import { methodLabels } from './payments.js';
import { debtPayment, recordDebt } from './debts.js';
import { misonLive, ourExternalId } from './mison-live.js';

// Stol hisobi ("shot"): bitta stolni bitta mijoz egallaydi, keyingi buyurtmalari shu hisobga qo'shiladi.
// Ofitsiant "Mijoz ketdi" (yoki kassir "Yopish") bosganda hisob yopiladi va stol bo'shaydi.
//   tabs/{id}:          { status: open|closed|merged, tableIds, tableLabels, customerId, customerName, customerPhone,
//                         waiterId, waiterName, servicePct, openedAtMs, updatedAtMs, closedAtMs, closedByName, mergedInto }
//   table_state/{key}:  { tabId, customerId, tableLabel, sinceMs } — stol band (kim egallagani boshqa mijozga ko'rinmaydi)

const newId = () => (1e13 - Date.now()).toString(36).padStart(9, '0') + crypto.randomBytes(3).toString('hex');
export const stateKey = (where) => (where.misonTableId !== undefined && where.misonTableId !== null ? `m${where.misonTableId}` : `t${tableKey(where.table) || 'x'}`);

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

/* ── xizmat foizi: admin panel → Stollar ── */
export const getServiceConfig = () => readSetting('tables_config', { defaultPct: 0, perTable: {} });
export async function saveServiceConfig(b) {
  const pct = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 50) throw new AppError(400, 'Xizmat foizi 0–50 oralig‘ida bo‘lsin.');
    return Math.round(n * 10) / 10;
  };
  const perTable = {};
  for (const [id, v] of Object.entries(b?.perTable || {}).slice(0, 500)) if (/^[\w-]{1,40}$/.test(id) && v !== '' && v !== null) perTable[id] = pct(v);
  return writeSetting('tables_config', { defaultPct: pct(b?.defaultPct ?? 0), perTable });
}
const pctFor = (conf, where) => {
  const id = where.misonTableId !== undefined && where.misonTableId !== null ? String(where.misonTableId) : '';
  return id && conf.perTable?.[id] !== undefined ? conf.perTable[id] : conf.defaultPct || 0;
};

/* ── mijoz: stolni egallash yoki o'z hisobiga qo'shish ── */
export async function attachToTable(customer, where) {
  const db = await needDb();
  const key = stateKey(where);
  const mine = await db.collection('table_state').where('customerId', '==', customer.id).limit(3).get();
  const other = mine.docs.find((d) => d.id !== key);
  if (other) throw Object.assign(new AppError(409, `Siz hozir ${other.data().tableLabel || 'boshqa stol'}dasiz. Boshqa stolga o‘tish uchun ofitsiantga ayting.`), { code: 'table-busy' });
  const pct = pctFor(await getServiceConfig(), where);
  return db.runTransaction(async (t) => {
    const sref = db.collection('table_state').doc(key);
    const snap = await t.get(sref);
    if (snap.exists) {
      const s = snap.data();
      // Ofitsiant/kassa ochgan stol (mijoz hali yo'q) — QR'ni skanerlagan mijoz shu hisobga qo'shiladi
      if (!s.customerId) {
        t.update(sref, { customerId: customer.id });
        t.update(db.collection('tabs').doc(s.tabId), { customerId: customer.id, customerName: customer.name || customer.firstName || '', customerPhone: customer.phone || '', updatedAtMs: Date.now() });
        return s.tabId;
      }
      if (s.customerId !== customer.id) throw Object.assign(new AppError(409, 'Bu stol band. Boshqa stolni tanlang yoki ofitsiantni chaqiring.'), { code: 'table-busy' });
      return s.tabId;
    }
    const tabId = newId();
    const now = Date.now();
    t.set(db.collection('tabs').doc(tabId), {
      status: 'open', tableIds: [key], tableLabels: [where.tableLabel], hall: where.tableHall || '',
      customerId: customer.id, customerName: customer.name || customer.firstName || '', customerPhone: customer.phone || '',
      waiterId: '', waiterName: '', servicePct: pct, openedAtMs: now, updatedAtMs: now,
    });
    t.set(sref, { tabId, customerId: customer.id, tableLabel: where.tableLabel, sinceMs: now });
    return tabId;
  });
}

/* ── xodim: bo'sh stolga buyurtma (mijozsiz hisob) va saboy ── */
export async function attachStaffTable(where, actor) {
  const db = await needDb();
  const key = stateKey(where);
  const pct = pctFor(await getServiceConfig(), where);
  return db.runTransaction(async (t) => {
    const sref = db.collection('table_state').doc(key);
    const snap = await t.get(sref);
    if (snap.exists) return snap.data().tabId; // band stol — o'sha hisobga qo'shiladi
    const tabId = newId();
    const now = Date.now();
    t.set(db.collection('tabs').doc(tabId), {
      status: 'open', kind: 'table', tableIds: [key], tableLabels: [where.tableLabel], hall: where.tableHall || '',
      customerId: '', customerName: '', customerPhone: '', staffOpened: true, openedByName: actor.name,
      waiterId: actor.role === 'waiter' ? actor.id : '', waiterName: actor.role === 'waiter' ? actor.name : '',
      servicePct: pct, openedAtMs: now, updatedAtMs: now,
    });
    t.set(sref, { tabId, customerId: '', tableLabel: where.tableLabel, sinceMs: now });
    return tabId;
  });
}

// Saboy (olib ketish): stolga bog'lanmagan hisob, xizmat foizi yo'q
export async function openSaboyTab(actor, label) {
  const db = await needDb();
  const tabId = newId();
  const now = Date.now();
  await db.collection('tabs').doc(tabId).set({
    status: 'open', kind: 'saboy', tableIds: [], tableLabels: [label], hall: '',
    customerId: '', customerName: '', customerPhone: '', staffOpened: true, openedByName: actor.name,
    waiterId: actor.role === 'waiter' ? actor.id : '', waiterName: actor.role === 'waiter' ? actor.name : '',
    servicePct: 0, openedAtMs: now, updatedAtMs: now,
  });
  return tabId;
}

export async function loadOpenTab(id) {
  const db = await needDb();
  const { tab } = await loadTab(db, id);
  if (tab.status !== 'open') throw new AppError(409, 'Bu hisob yopilgan.');
  return tab;
}

// Hisobni bo'lish: shu stolning yangi cheki (2-, 3-chek…). Stolga bog'lanmaydi — stolda asosiy hisob qoladi;
// ofitsiant, xizmat foizi va foizli chegirma asosiy hisobdan olinadi.
export async function openSplitTab(parentId, actor) {
  const db = await needDb();
  const { tab } = await loadTab(db, parentId);
  if (tab.status !== 'open') throw new AppError(409, 'Bu hisob yopilgan.');
  const rootId = tab.parentId || parentId;
  const siblings = await db.collection('tabs').where('parentId', '==', rootId).get();
  const splitNo = Math.max(1, ...siblings.docs.map((d) => d.data().splitNo || 1)) + 1;
  const id = newId();
  const now = Date.now();
  await db.collection('tabs').doc(id).set({
    status: 'open', kind: tab.kind === 'saboy' ? 'saboy' : 'split', parentId: rootId, splitNo,
    tableIds: [], tableLabels: tab.tableLabels || [], hall: tab.hall || '',
    customerId: '', customerName: tab.customerName || '', customerPhone: tab.customerPhone || '', staffOpened: true, openedByName: actor.name || '',
    waiterId: tab.waiterId || '', waiterName: tab.waiterName || '', servicePct: tab.servicePct || 0,
    ...(tab.discount?.type === 'pct' ? { discount: tab.discount } : {}),
    openedAtMs: now, updatedAtMs: now,
  });
  return { id, splitNo };
}

/* ── ko'rinishlar ── */
export async function openTabIds(db, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const snaps = await Promise.all(uniq.map((id) => db.collection('tabs').doc(id).get().catch(() => null)));
  return new Set(snaps.filter((s) => s?.exists && s.data().status === 'open').map((s) => s.id));
}

export async function tabIdForTable(misonTableId) {
  const db = await needDb();
  const snap = await db.collection('table_state').doc(`m${misonTableId}`).get();
  return snap.exists ? snap.data().tabId : null;
}

export async function tabOrdersOf(tabId) {
  return tabOrders(await needDb(), tabId);
}

async function tabOrders(db, tabId) {
  const snap = await db.collection('orders').where('tabId', '==', tabId).limit(100).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export function tabTotals(tab, orders) {
  const live = orders.filter((o) => o.status === 'qabul');
  const subtotal = live.reduce((s, o) => s + o.total, 0);
  const pending = orders.filter((o) => o.status === 'yangi').reduce((s, o) => s + o.total, 0);
  // Saboy (olib ketiladigan) taomlarga xizmat haqi qo'shilmaydi
  const takeaway = tab.kind === 'saboy' ? subtotal : live.filter((o) => o.takeaway).reduce((s, o) => s + o.total, 0);
  // Chegirma taomlarga beriladi; xizmat haqi chegirmadan keyingi summadan hisoblanadi
  const d = tab.discount;
  const discountAmt = !d || !subtotal ? 0 : Math.min(subtotal, d.type === 'pct' ? Math.round((subtotal * d.value) / 100) : Math.round(d.value));
  const ratio = subtotal ? (subtotal - discountAmt) / subtotal : 1;
  const service = tab.kind === 'saboy' ? 0 : Math.round(((subtotal - takeaway) * ratio * (tab.servicePct || 0)) / 100);
  return { subtotal, pending, takeaway, discountAmt, service, total: subtotal - discountAmt + service };
}

const roundView = (o) => ({
  id: o.id, number: o.number, status: o.status, items: liveItems(o.items), voided: voidedItems(o.items), moved: movedItems(o.items), total: o.total, comment: o.comment || '',
  createdAt: o.createdAtMs ? new Date(o.createdAtMs).toISOString() : '', acceptedByName: o.acceptedByName || '',
  takeaway: Boolean(o.takeaway), byStaff: Boolean(o.byStaff),
});

export function tabView(id, tab, orders, { staff = false } = {}) {
  return {
    id, status: tab.status, kind: tab.kind || 'table', tableLabel: `${(tab.tableLabels || []).join(' + ')}${tab.splitNo ? ` · ${tab.splitNo}-chek` : ''}`, tableIds: tab.tableIds || [], hall: tab.hall || '',
    ...(tab.splitNo ? { splitNo: tab.splitNo, parentId: tab.parentId || '' } : {}),
    servicePct: tab.servicePct || 0, ...tabTotals(tab, orders),
    discount: tab.discount ? { type: tab.discount.type, value: tab.discount.value, reason: tab.discount.reason || '', byName: tab.discount.byName || '' } : null,
    rounds: orders.map(roundView), openedAt: new Date(tab.openedAtMs).toISOString(),
    closedAt: tab.closedAtMs ? new Date(tab.closedAtMs).toISOString() : '',
    waiterName: tab.waiterName || '', call: tab.status === 'open' ? callView(tab.call) : null,
    ...(staff ? { waiterId: tab.waiterId || '', customerName: tab.customerName || '', customerPhone: tab.customerPhone || '', closedByName: tab.closedByName || '', mergedInto: tab.mergedInto || '', payment: tab.payment || null, shiftId: tab.shiftId || '', movedFrom: tab.movedFrom || '', billPrintedAt: tab.billPrintedAtMs ? new Date(tab.billPrintedAtMs).toISOString() : '' } : {}),
  };
}

async function loadTab(db, id) {
  if (!/^[a-z0-9]{9,20}$/.test(String(id || ''))) throw new AppError(404, 'Hisob topilmadi.');
  const snap = await db.collection('tabs').doc(id).get();
  if (!snap.exists) throw new AppError(404, 'Hisob topilmadi.');
  return { ref: snap.ref, tab: snap.data() };
}

export async function getTabForStaff(id) {
  const db = await needDb();
  const { tab } = await loadTab(db, id);
  return tabView(id, tab, await tabOrders(db, id), { staff: true });
}

// Mijozning ochiq stol hisobi (bo'lmasa null)
export async function getCustomerTab(customer) {
  const db = await needDb();
  const snap = await db.collection('table_state').where('customerId', '==', customer.id).limit(1).get();
  if (snap.empty) return null;
  const tabId = snap.docs[0].data().tabId;
  const t = await db.collection('tabs').doc(tabId).get();
  if (!t.exists || t.data().status !== 'open') return null;
  return tabView(tabId, t.data(), await tabOrders(db, tabId));
}

// Mijozga: qaysi stollar band (kim egallagani ko'rsatilmaydi) va o'zining stoli
export async function tableOccupancy(customerId = '') {
  const db = await needDb();
  const snap = await db.collection('table_state').limit(500).get();
  const busy = [];
  let mine = null;
  for (const d of snap.docs) {
    if (!d.id.startsWith('m')) continue;
    const s = d.data();
    if (customerId && s.customerId === customerId) mine = { tableId: d.id.slice(1), tabId: s.tabId };
    else busy.push(d.id.slice(1));
  }
  return { busy, mine };
}

export async function listTabs({ scope = 'open', days = 1.5 } = {}) {
  const db = await needDb();
  const snap = await db.collection('tabs').orderBy('openedAtMs', 'desc').limit(scope === 'open' ? 200 : 500).get();
  const from = Date.now() - Math.min(31, Math.max(0.5, Number(days) || 1.5)) * 86_400_000;
  const docs = snap.docs.filter((d) => (scope === 'open' ? d.data().status === 'open' : d.data().status === 'closed' && (d.data().closedAtMs || 0) > from));
  return Promise.all(docs.map(async (d) => tabView(d.id, d.data(), await tabOrders(db, d.id), { staff: true })));
}

// Stol holati: band; hisob cheki chiqqan (chekdan keyin yangi buyurtma bo'lmagan) — boshqa rangda
const tableTab = (t) => {
  const last = t.rounds.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), '');
  return {
    id: t.id, kind: t.kind, total: t.total, pending: t.pending, waiterId: t.waiterId || '', waiterName: t.waiterName, rounds: t.rounds.length, openedAt: t.openedAt,
    billPrinted: Boolean(t.billPrintedAt && t.billPrintedAt >= last), call: t.call || null,
  };
};

// Mison kassasining o'zida ochilgan stol cheklari (bizning sayt yubormagan) — stolga biriktiriladi
const lower = (v) => String(v || '').trim().toLowerCase();
function misonTableOf(halls, c) {
  for (const h of halls) for (const x of h.tables) if (c.tableId && String(x.id) === c.tableId) return x;
  // nom bo'yicha: "Основной зал / 8" yoki "8"
  const parts = String(c.tableName || '').split(' / ');
  const tName = parts.pop() || '';
  const hName = c.hallName || parts.join(' / ');
  const want = tableKey(tName);
  if (!want) return null;
  const hits = halls.filter((h) => !hName || lower(h.name) === lower(hName)).flatMap((h) => h.tables.filter((x) => tableKey(x.name) === want));
  return hits.length === 1 ? hits[0] : null;
}
const misonSum = (list) => ({
  count: list.length,
  total: list.reduce((a, c) => a + c.total, 0),
  guests: list.reduce((a, c) => a + (c.guests || 0), 0) || null,
  waiterName: [...new Set(list.map((c) => c.waiterName).filter(Boolean))].join(', '),
  openedAt: list.map((c) => c.openedAt).filter(Boolean).sort()[0] || '',
  ids: list.map((c) => c.id),
});

// Ofitsiant va kassa uchun: zal → stollar, har birining holati (sayt hisobi va Mison kassasidagi ochiq chek)
export async function staffTableMap() {
  const [tables, open, live] = await Promise.all([getTables(), listTabs({ scope: 'open' }), misonLive().catch(() => null)]);
  const byKey = new Map();
  for (const t of open) for (const k of t.tableIds) byKey.set(k, t);
  const halls = tables.halls.map((h) => ({
    id: h.id, name: h.name,
    tables: h.tables.map((x) => {
      const t = byKey.get(`m${x.id}`);
      const splits = t ? open.filter((o) => o.parentId === t.id).length : 0; // shu stolning qo'shimcha cheklari
      return { id: x.id, name: x.name, capacity: x.capacity || null, tab: t ? { ...tableTab(t), ...(splits ? { splits } : {}) } : null };
    }),
  }));
  // Mison'da yo'q (qo'lda yozilgan) stollardagi hisoblar
  const known = new Set(tables.halls.flatMap((h) => h.tables.map((x) => `m${x.id}`)));
  const loose = open.filter((t) => !t.tableIds.some((k) => known.has(k))).map((t) => ({ ...t, ...tableTab(t) }));
  if (!live) return { halls, loose };
  // Mison: zal cheklari (olib ketish va yetkazish — stolsiz, bu yerda ko'rsatilmaydi); saytdan yuborilganlari — tashlab ketiladi
  const cheques = live.cheques.filter((c) => (c.orderType === 1 || c.tableId) && !ourExternalId(c.externalId));
  const byTable = new Map();
  const misonLoose = [];
  for (const c of cheques) {
    const x = misonTableOf(halls, c);
    if (x) byTable.set(x.id, [...(byTable.get(x.id) || []), c]);
    else misonLoose.push({ id: `mison:${c.id}`, name: c.tableName || `Mison chek ${c.number || c.id}`, hall: c.hallName, mison: misonSum([c]) });
  }
  for (const h of halls) for (const x of h.tables) if (byTable.has(x.id)) x.mison = misonSum(byTable.get(x.id));
  return {
    halls, loose,
    mison: {
      error: live.error || '', onlineEnabled: live.onlineEnabled !== false, shiftOpen: live.shiftOpen !== false,
      lastSyncAt: live.lastSyncAt || '', at: live.atMs ? new Date(live.atMs).toISOString() : '',
      cheques, loose: misonLoose,
    },
  };
}

/* ── xodim amallari ── */
async function freeTables(db, tabId, keys) {
  for (const k of keys) {
    const s = await db.collection('table_state').doc(k).get();
    if (s.exists && s.data().tabId === tabId) await s.ref.delete();
  }
}

// Toshkent kuni (YYYY-MM-DD) — Owner hisobotlari kunlar bo'yicha yig'adi
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export const PAY_METHODS = { naqd: 'Naqd', karta: 'Karta (terminal)', click: 'Click', payme: 'Payme', uzum: 'Uzum', boshqa: 'Boshqa' };

// methods: { key: label } — admin yoqqan to'lov turlari (bo'lmasa — standart ro'yxat)
export function paymentOf(raw, total, actor, methods = PAY_METHODS) {
  if (!raw) return null;
  if (raw.debt) return debtPayment(raw, total, actor, methods); // hammasi yoki bir qismi qarzga
  if (raw.method && !methods[raw.method]) throw new AppError(400, 'Bu to‘lov turi o‘chirilgan. Sahifani yangilang.');
  const method = methods[raw.method] ? raw.method : Object.keys(methods)[0] || 'naqd';
  const received = raw.received === undefined || raw.received === '' || raw.received === null ? total : Math.round(Number(String(raw.received).replace(/\s/g, '')));
  if (!Number.isFinite(received) || received < 0 || received > 1e9) throw new AppError(400, 'Berilgan summa noto‘g‘ri.');
  if (method === 'naqd' && received < total) throw new AppError(400, `Berilgan pul jamidan kam: ${total - received} so‘m yetmaydi.`);
  return { method, label: methods[method] || PAY_METHODS[method] || method, amount: total, received: method === 'naqd' ? received : total, change: method === 'naqd' ? received - total : 0, atMs: Date.now(), byName: actor.name };
}

export async function closeTab(id, actor, { payment: rawPayment } = {}) {
  const db = await needDb();
  const { ref, tab } = await loadTab(db, id);
  if (tab.status !== 'open') throw new AppError(409, 'Bu hisob allaqachon yopilgan.');
  const orders = await tabOrders(db, id);
  let payment = rawPayment ? paymentOf(rawPayment, tabTotals(tab, orders).total, actor, await methodLabels()) : null;
  // to'lov smenaga yoziladi (smena ochilmagan bo'lsa — sozlamaga qarab xato yoki o'zi ochiladi);
  // to'lovsiz yopilgan hisob (Mison'da to'langan, "Mijoz ketdi") ochiq smenaga "to'lovsiz" bo'lib tushadi
  if (!payment && tab.pendingCharge) throw new AppError(409, 'Bu hisobdan Click orqali pul yechilgan — to‘lov bilan (Click) yoping.');
  const shiftId = payment ? await shiftForPayment(actor) : await currentShiftId().catch(() => '');
  // Click Pass: mijoz QR'i skaner qilindi — pul shu yerda yechiladi (summa serverda hisoblangan, smena tekshirilgandan keyin)
  if (payment) {
    const { takeQrPayment } = await import('./clickpass.js');
    payment = await takeQrPayment({ rawPayment, payment, pending: tab.pendingCharge, txId: id, savePending: (r) => ref.update({ pendingCharge: r }) });
    payment = await recordDebt(payment, { kind: 'tab', id, label: (tab.tableLabels || []).join(' + ') || (tab.kind === 'saboy' ? 'Saboy' : 'Stol') }, shiftId, actor);
  }
  for (const o of orders.filter((x) => x.status === 'yangi')) {
    await db.collection('orders').doc(o.id).update({ status: 'bekor', rejectReason: 'Stol yopildi', updatedAtMs: Date.now() });
  }
  const now = Date.now();
  await ref.update({ status: 'closed', closedAtMs: now, closedDay: dayOf(now), updatedAtMs: now, closedByName: actor.name, closedById: actor.id || '', ...tabTotals(tab, orders), ...(payment ? { payment } : {}), ...(shiftId ? { shiftId } : {}) });
  // Hisob yopildi: buyurtmalar ofitsiant va mijoz ro'yxatidan yo'qoladi, faqat kassada qoladi
  for (const o of orders) await db.collection('orders').doc(o.id).update({ tabClosedAtMs: now }).catch(() => {});
  await freeTables(db, id, tab.tableIds || []);
  return tabView(id, { ...tab, status: 'closed', closedAtMs: now, closedByName: actor.name, ...(payment ? { payment } : {}), ...(shiftId ? { shiftId } : {}) }, await tabOrders(db, id), { staff: true });
}

// Ikki stolni bitta hisob qilish: manba hisobidagi buyurtmalar va stollar maqsad hisobga o'tadi
export async function mergeTabs(targetId, sourceId) {
  if (targetId === sourceId) throw new AppError(400, 'Boshqa hisobni tanlang.');
  const db = await needDb();
  const a = await loadTab(db, targetId);
  const b = await loadTab(db, sourceId);
  if (a.tab.status !== 'open' || b.tab.status !== 'open') throw new AppError(409, 'Faqat ochiq hisoblarni birlashtirish mumkin.');
  for (const o of await tabOrders(db, sourceId)) await db.collection('orders').doc(o.id).update({ tabId: targetId });
  for (const k of b.tab.tableIds || []) await db.collection('table_state').doc(k).set({ tabId: targetId, customerId: a.tab.customerId, tableLabel: (a.tab.tableLabels || [])[0] || '', sinceMs: Date.now() });
  const now = Date.now();
  await a.ref.update({ tableIds: [...(a.tab.tableIds || []), ...(b.tab.tableIds || [])], tableLabels: [...(a.tab.tableLabels || []), ...(b.tab.tableLabels || [])], updatedAtMs: now });
  await b.ref.update({ status: 'merged', mergedInto: targetId, closedAtMs: now, updatedAtMs: now });
  return getTabForStaff(targetId);
}

export async function setTabWaiter(id, staff) {
  const db = await needDb();
  const { ref, tab } = await loadTab(db, id);
  if (tab.status !== 'open') throw new AppError(409, 'Hisob yopilgan.');
  await ref.update({ waiterId: staff.id, waiterName: staff.name, updatedAtMs: Date.now() });
  return getTabForStaff(id);
}

export async function setTabService(id, pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 50) throw new AppError(400, 'Xizmat foizi 0–50 oralig‘ida bo‘lsin.');
  const db = await needDb();
  const { ref, tab } = await loadTab(db, id);
  if (tab.status !== 'open') throw new AppError(409, 'Hisob yopilgan.');
  await ref.update({ servicePct: Math.round(n * 10) / 10, updatedAtMs: Date.now() });
  return getTabForStaff(id);
}

// Birinchi qabul qilgan ofitsiant — stol ofitsianti (kassir keyin almashtira oladi)
export async function noteTabActivity(tabId, actor) {
  const db = await needDb();
  const snap = await db.collection('tabs').doc(tabId).get();
  if (!snap.exists) return;
  const t = snap.data();
  await snap.ref.update({ updatedAtMs: Date.now(), ...(!t.waiterId && actor && !actor.admin ? { waiterId: actor.id, waiterName: actor.name } : {}) });
}

// Chegirma: foiz (0–100) yoki summa. value 0 — chegirmani olib tashlash. Sabab majburiy.
export async function setTabDiscount(id, body, actor) {
  const db = await needDb();
  const { ref, tab } = await loadTab(db, id);
  if (tab.status !== 'open') throw new AppError(409, 'Hisob yopilgan.');
  const type = body?.type === 'sum' ? 'sum' : 'pct';
  const value = Math.round(Number(String(body?.value ?? '').replace(/\s/g, '').replace(',', '.')) * (type === 'pct' ? 10 : 1)) / (type === 'pct' ? 10 : 1);
  if (!Number.isFinite(value) || value < 0 || (type === 'pct' && value > 100) || value > 1e9) throw new AppError(400, type === 'pct' ? 'Chegirma 0–100% oralig‘ida bo‘lsin.' : 'Chegirma summasi noto‘g‘ri.');
  if (!value) {
    await ref.update({ discount: null, updatedAtMs: Date.now() });
    return getTabForStaff(id);
  }
  const reason = str(body?.reason, 120);
  if (!reason) throw new AppError(400, 'Chegirma sababini yozing (masalan: doimiy mijoz, tug‘ilgan kun).');
  await ref.update({ discount: { type, value, reason, byId: actor.id || '', byName: actor.name || '', atMs: Date.now() }, updatedAtMs: Date.now() });
  return getTabForStaff(id);
}

// Stolni ko'chirish: hisob (buyurtmalari bilan) bo'sh stolga o'tadi, eski stol bo'shaydi
export async function moveTab(id, where, actor) {
  const db = await needDb();
  const { ref, tab } = await loadTab(db, id);
  if (tab.status !== 'open') throw new AppError(409, 'Hisob yopilgan.');
  if (tab.kind === 'saboy') throw new AppError(409, 'Saboy hisobini stolga ko‘chirib bo‘lmaydi.');
  const key = stateKey(where);
  if ((tab.tableIds || []).length === 1 && tab.tableIds[0] === key) throw new AppError(409, 'Hisob shu stolning o‘zida.');
  await db.runTransaction(async (t) => {
    const sref = db.collection('table_state').doc(key);
    const s = await t.get(sref);
    if (s.exists && s.data().tabId !== id) throw new AppError(409, `${where.tableLabel} band. Ikkala stolni bitta hisob qilish uchun “Birlashtirish”dan foydalaning.`);
    t.set(sref, { tabId: id, customerId: tab.customerId || '', tableLabel: where.tableLabel, sinceMs: Date.now() });
  });
  const from = (tab.tableLabels || []).join(' + ');
  await freeTables(db, id, (tab.tableIds || []).filter((k) => k !== key));
  await ref.update({ tableIds: [key], tableLabels: [where.tableLabel], hall: where.tableHall || '', movedFrom: from, movedByName: actor.name || '', updatedAtMs: Date.now() });
  const orders = await tabOrders(db, id);
  for (const o of orders) {
    await db.collection('orders').doc(o.id).update({ table: where.table, tableLabel: where.tableLabel, tableHall: where.tableHall || '', ...(where.misonTableId !== undefined ? { misonTableId: where.misonTableId } : {}) }).catch(() => {});
  }
  return { tab: await getTabForStaff(id), from, misonOrders: orders.filter((o) => o.status === 'qabul' && o.misonOrderId).length };
}
