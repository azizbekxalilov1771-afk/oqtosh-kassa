import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { str } from './validate.js';
import { liveItems } from './items.js';
import { debtPaymentsOfShift } from './debts.js';

// Smena (kassa kuni): kassir ochadi (boshlang'ich naqd), kun davomida to'lovlar shu smenaga yoziladi,
// kassaga pul kiritish/olish qayd etiladi, oxirida naqd sanaladi va Z-hisobot bilan yopiladi.
//   shifts/{id}        { number, status: open|closed, openedAtMs, openedById, openedByName, openingCash, auto,
//                        ops: [{ id, type: in|out, amount, reason, byName, atMs }],
//                        closedAtMs, closedById, closedByName, countedCash, expectedCash, diff, note, summary }
//   counters/shift     { openId, n }
//   settings/shift     { required } — true: smena ochilmasa to'lov olinmaydi; false: birinchi to'lov smenani o'zi ochadi
// To'lov olingan stol hisobi (tabs) va yetkazish buyurtmasi (orders) `shiftId` bilan belgilanadi.

const METHOD_LABEL = { naqd: 'Naqd', karta: 'Karta (terminal)', click: 'Click', payme: 'Payme', uzum: 'Uzum', boshqa: 'Boshqa' };
const newId = () => (1e13 - Date.now()).toString(36).padStart(9, '0') + crypto.randomBytes(3).toString('hex');
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

export const getShiftConfig = () => readSetting('shift', { required: false });
export const saveShiftConfig = (b) => writeSetting('shift', { required: Boolean(b?.required) });

const money = (v, what = 'Summa') => {
  const n = Math.round(Number(String(v ?? '').replace(/\s/g, '')));
  if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new AppError(400, `${what} noto‘g‘ri.`);
  return n;
};

async function openId(db) {
  const c = await db.collection('counters').doc('shift').get();
  return c.exists ? c.data().openId || '' : '';
}

export async function currentShiftId() {
  return openId(await needDb());
}

async function loadShift(db, id) {
  if (!/^[a-z0-9]{9,20}$/.test(String(id || ''))) throw new AppError(404, 'Smena topilmadi.');
  const snap = await db.collection('shifts').doc(id).get();
  if (!snap.exists) throw new AppError(404, 'Smena topilmadi.');
  return { ref: snap.ref, s: snap.data() };
}

async function createShift(db, actor, { openingCash = 0, auto = false } = {}) {
  return db.runTransaction(async (t) => {
    const cref = db.collection('counters').doc('shift');
    const c = await t.get(cref);
    const cur = c.exists ? c.data() : {};
    if (cur.openId) {
      const open = await t.get(db.collection('shifts').doc(cur.openId));
      if (open.exists && open.data().status === 'open') {
        if (auto) return cur.openId;
        throw new AppError(409, `Smena #${open.data().number} allaqachon ochiq (${open.data().openedByName || 'kassir'} ochgan).`);
      }
    }
    const id = newId();
    const number = (cur.n || 0) + 1;
    const now = Date.now();
    t.set(db.collection('shifts').doc(id), {
      number, status: 'open', openedAtMs: now, openedById: actor.id || '', openedByName: actor.name || '', openingCash, auto, ops: [],
    });
    t.set(cref, { openId: id, n: number });
    return id;
  });
}

export async function openShift(actor, body) {
  const db = await needDb();
  const id = await createShift(db, actor, { openingCash: money(body?.openingCash ?? 0, 'Boshlang‘ich naqd') });
  return shiftReport(id);
}

// To'lov olinayotganda: ochiq smena; bo'lmasa — sozlamaga qarab xato yoki o'zi ochiladi (boshlang'ich naqd 0)
export async function shiftForPayment(actor) {
  const db = await needDb();
  const id = await openId(db);
  if (id) {
    const s = await db.collection('shifts').doc(id).get();
    if (s.exists && s.data().status === 'open') return id;
  }
  if ((await getShiftConfig()).required) {
    throw Object.assign(new AppError(409, 'Smena ochilmagan. Avval kassada “Smena” bo‘limidan smenani oching.'), { code: 'shift' });
  }
  return createShift(db, actor, { auto: true });
}

export async function cashOp(actor, body) {
  const type = body?.type === 'out' ? 'out' : 'in';
  const amount = money(body?.amount);
  if (!amount) throw new AppError(400, 'Summani yozing.');
  const reason = str(body?.reason, 120);
  if (type === 'out' && !reason) throw new AppError(400, 'Kassadan olish sababini yozing (masalan: inkassatsiya, xarajat).');
  const db = await needDb();
  const id = await openId(db);
  if (!id) throw new AppError(409, 'Smena ochilmagan.');
  await db.runTransaction(async (t) => {
    const ref = db.collection('shifts').doc(id);
    const snap = await t.get(ref);
    if (!snap.exists || snap.data().status !== 'open') throw new AppError(409, 'Smena ochilmagan.');
    const ops = [...(snap.data().ops || []), { id: crypto.randomBytes(4).toString('hex'), type, amount, reason, byName: actor.name || '', atMs: Date.now() }].slice(-300);
    t.update(ref, { ops });
  });
  return shiftReport(id);
}

/* ───────── hisobot (X — smena davomida, Z — yopilganda) ───────── */
const add = (map, key, patch) => {
  const cur = map.get(key) || { count: 0, sum: 0 };
  map.set(key, { ...cur, ...patch(cur) });
};

export async function shiftReport(id) {
  const db = await needDb();
  const sid = id || (await openId(db));
  if (!sid) return null;
  const { s } = await loadShift(db, sid);
  const from = s.openedAtMs;
  const to = s.closedAtMs || Date.now();
  const [tabSnap, paidSnap, recent, openSnap] = await Promise.all([
    db.collection('tabs').where('shiftId', '==', sid).limit(3000).get(),
    db.collection('orders').where('shiftId', '==', sid).limit(3000).get(),
    db.collection('orders').orderBy('createdAtMs', 'desc').limit(2000).get(),
    s.status === 'open' ? db.collection('tabs').where('status', '==', 'open').limit(300).get() : null,
  ]);
  const tabs = tabSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.status === 'closed');
  const paidOrders = paidSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => o.payment);
  const orders = recent.docs.map((d) => ({ id: d.id, ...d.data() }));

  const methods = new Map();
  const waiters = new Map();
  let revenue = 0;
  let cashSales = 0;
  let checks = 0;
  let service = 0;
  let discount = 0;
  let discountCount = 0;
  const unpaid = { count: 0, sum: 0 };
  const debtGiven = { count: 0, sum: 0 };
  // qarzli to'lov: sotuv summasi to'liq tushum, kassaga esa faqat hozir berilgan qism (p.paid) tushadi
  const pay = (p) => {
    checks += 1;
    revenue += p.amount || 0;
    const debt = p.debt?.amount || 0;
    const got = (p.amount || 0) - debt;
    if (debt) {
      debtGiven.count += 1;
      debtGiven.sum += debt;
      add(methods, 'qarz', (c) => ({ label: 'Qarzga', count: c.count + 1, sum: c.sum + debt }));
    }
    if (!got) return;
    if (p.method === 'naqd') cashSales += got;
    add(methods, p.method || 'naqd', (c) => ({ label: METHOD_LABEL[p.method] || String(p.label || p.method).replace(/ \+ qarz$/, ''), count: c.count + 1, sum: c.sum + got }));
  };
  for (const t of tabs) {
    if (!t.payment) {
      if (t.cancelledAtMs) continue; // o'chirilgan chek — buyurtmalari "bekor qilingan"da ko'rinadi
      unpaid.count += 1;
      unpaid.sum += t.total || 0;
      continue;
    }
    pay(t.payment);
    service += t.service || 0;
    if (t.discountAmt) {
      discount += t.discountAmt;
      discountCount += 1;
    }
    add(waiters, t.waiterName || '—', (c) => ({ count: c.count + 1, sum: c.sum + (t.payment.amount || 0) }));
  }
  let delivery = 0;
  for (const o of paidOrders) {
    pay(o.payment);
    delivery += 1;
  }

  // sotilgan taomlar: shu smenada yopilgan hisoblar va to'langan yetkazishlar
  const tabIds = new Set(tabs.map((t) => t.id));
  const sold = new Map();
  for (const o of [...orders.filter((x) => x.status === 'qabul' && tabIds.has(x.tabId)), ...paidOrders]) {
    for (const i of liveItems(o.items)) add(sold, i.name, (c) => ({ count: c.count + (i.unit === 'kg' ? 1 : i.qty), sum: c.sum + (i.sum || 0) }));
  }
  const inWindow = (ms) => ms >= from && ms <= to;
  const cancelled = orders.filter((o) => o.status === 'bekor' && o.cancelledById && inWindow(o.cancelledAtMs || 0));
  const voids = orders.flatMap((o) => (o.items || []).flatMap((i) => (i.voids || []).filter((v) => inWindow(v.atMs || 0)).map((v) => ({ name: i.name, qty: v.qty, sum: v.sum || 0, reason: v.reason || '', byName: v.byName || '', number: o.number }))));

  // shu smenada olingan qarz to'lovlari (eski qarzlar): naqd qismi kassadagi pulga qo'shiladi
  const debtPays = await debtPaymentsOfShift(sid);
  const debtPaid = { count: debtPays.length, sum: debtPays.reduce((a, x) => a + (x.amount || 0), 0), cash: debtPays.filter((x) => x.method === 'naqd').reduce((a, x) => a + (x.amount || 0), 0) };
  const debtByMethod = new Map();
  for (const x of debtPays) add(debtByMethod, x.method, (c) => ({ label: x.label || METHOD_LABEL[x.method] || x.method, count: c.count + 1, sum: c.sum + (x.amount || 0) }));
  const ops = (s.ops || []).map((o) => ({ ...o, at: iso(o.atMs) }));
  const cashIn = ops.filter((o) => o.type === 'in').reduce((a, o) => a + o.amount, 0);
  const cashOut = ops.filter((o) => o.type === 'out').reduce((a, o) => a + o.amount, 0);
  const expectedCash = (s.openingCash || 0) + cashSales + debtPaid.cash + cashIn - cashOut;
  const sortSum = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.sum - a.sum);

  return {
    id: sid, number: s.number, status: s.status, auto: Boolean(s.auto),
    openedAt: iso(s.openedAtMs), openedByName: s.openedByName || '', closedAt: iso(s.closedAtMs), closedByName: s.closedByName || '',
    openingCash: s.openingCash || 0, ops, cashIn, cashOut,
    revenue, checks, avg: checks ? Math.round(revenue / checks) : 0, cashSales, service, discount, discountCount, delivery,
    methods: sortSum(methods).map((m) => ({ method: m.key, label: m.label, count: m.count, sum: m.sum })),
    waiters: sortSum(waiters).map((w) => ({ name: w.key, count: w.count, sum: w.sum })),
    items: sortSum(sold).slice(0, 25).map((i) => ({ name: i.key, qty: Math.round(i.count * 1000) / 1000, sum: i.sum })),
    unpaid,
    debtGiven,
    debtPaid: { ...debtPaid, methods: sortSum(debtByMethod).map((m) => ({ method: m.key, label: m.label, count: m.count, sum: m.sum })) },
    cancelled: { count: cancelled.length, sum: cancelled.reduce((a, o) => a + (o.total || 0), 0), list: cancelled.slice(0, 30).map((o) => ({ number: o.number, sum: o.total || 0, reason: o.cancelReason || '', byName: o.cancelledByName || '' })) },
    voided: { count: voids.length, sum: voids.reduce((a, v) => a + v.sum, 0), list: voids.slice(0, 40) },
    openTabs: openSnap ? openSnap.docs.length : 0,
    expectedCash, countedCash: s.countedCash ?? null, diff: s.diff ?? null, note: s.note || '',
  };
}

export async function closeShift(actor, body) {
  const db = await needDb();
  const id = await openId(db);
  if (!id) throw new AppError(409, 'Ochiq smena yo‘q.');
  const counted = money(body?.countedCash, 'Sanalgan naqd');
  const before = await shiftReport(id);
  const now = Date.now();
  await db.runTransaction(async (t) => {
    const cref = db.collection('counters').doc('shift');
    const c = await t.get(cref);
    const ref = db.collection('shifts').doc(id);
    const snap = await t.get(ref);
    if (!snap.exists || snap.data().status !== 'open') throw new AppError(409, 'Smena allaqachon yopilgan.');
    t.update(ref, {
      status: 'closed', closedAtMs: now, closedById: actor.id || '', closedByName: actor.name || '',
      countedCash: counted, expectedCash: before.expectedCash, diff: counted - before.expectedCash, note: str(body?.note, 300),
      summary: { revenue: before.revenue, checks: before.checks, cashSales: before.cashSales, methods: before.methods },
    });
    t.set(cref, { ...(c.exists ? c.data() : {}), openId: '' });
  });
  return shiftReport(id);
}

export async function listShifts(limit = 20) {
  const db = await needDb();
  const snap = await db.collection('shifts').orderBy('openedAtMs', 'desc').limit(Math.min(60, limit)).get();
  return snap.docs.map((d) => {
    const s = d.data();
    return {
      id: d.id, number: s.number, status: s.status, auto: Boolean(s.auto),
      openedAt: iso(s.openedAtMs), openedByName: s.openedByName || '', closedAt: iso(s.closedAtMs), closedByName: s.closedByName || '',
      revenue: s.summary?.revenue ?? null, checks: s.summary?.checks ?? null, countedCash: s.countedCash ?? null, diff: s.diff ?? null,
    };
  });
}

// Yengil: smena raqami va kim ochgani (stollar sahifasidagi belgi uchun)
export async function shiftBrief(id) {
  if (!id) return null;
  const db = await needDb();
  const snap = await db.collection('shifts').doc(id).get();
  if (!snap.exists) return null;
  const s = snap.data();
  return { id, number: s.number, status: s.status, openedAt: iso(s.openedAtMs), openedByName: s.openedByName || '', auto: Boolean(s.auto) };
}
