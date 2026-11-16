import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { str } from './validate.js';

// Qarz (nasiya): kassada hisobning hammasi yoki bir qismi qarzga yoziladi — mijoz ismi va telefoni bilan.
// Sotuv summasi (payment.amount) to'liq tushum bo'lib qoladi; kassaga esa faqat hozir berilgan qism tushadi.
// Mijoz keyin qarzini (bo'lib ham) to'laydi — to'lov o'sha kungi smenaga yoziladi.
//   debts/{id}         { name, phone, amount, paid, left, status: open|closed, source: { kind: tab|order, id, label },
//                        createdAtMs, byName, byId, shiftId, payments: [{ amount, method, label, received, change, atMs, byName, shiftId }] }
//   debt_payments/{id} { debtId, name, phone, amount, method, label, shiftId, atMs, byName } — smena hisoboti uchun

const newId = () => (1e13 - Date.now()).toString(36).padStart(9, '0') + crypto.randomBytes(3).toString('hex');
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const sum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const money = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(String(v).replace(/\s/g, '').replace(',', '.'))));

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Ma’lumotlar bazasi ulanmagan.');
  return db;
}

// +998 90 123 45 67 → +998901234567
export function debtPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 9) d = `998${d}`;
  if (!/^998\d{9}$/.test(d)) throw new AppError(400, 'Telefon raqamini to‘liq yozing: +998 90 123 45 67');
  return `+${d}`;
}

// Kassa to'lovi qarz bilan: raw = { method, received, debt: { name, phone, paid } }
//   paid — hozir to'lanadigan qism (0 — hammasi qarzga). Qolgani qarzga yoziladi.
export function debtPayment(raw, total, actor, methods) {
  if (raw.qr) throw new AppError(400, 'QR to‘lovni qarz bilan birga ishlatib bo‘lmaydi.');
  const d = raw.debt || {};
  const name = str(d.name, 60);
  if (name.length < 2) throw new AppError(400, 'Qarzdorning ismini yozing.');
  const phone = debtPhone(d.phone);
  if (!(total > 0)) throw new AppError(400, 'Hisob summasi 0 — qarzga yozib bo‘lmaydi.');
  const paid = money(d.paid) ?? 0;
  if (!Number.isFinite(paid) || paid < 0 || paid >= total) {
    throw new AppError(400, `Hozir to‘lanadigan summa 0 dan ${sum(total - 1)} so‘mgacha bo‘lsin (hammasi to‘lansa — qarzsiz yoping).`);
  }
  const debt = { amount: total - paid, name, phone };
  const atMs = Date.now();
  if (!paid) return { method: 'qarz', label: 'Qarz', amount: total, paid: 0, received: 0, change: 0, debt, atMs, byName: actor.name };
  if (raw.method && !methods[raw.method]) throw new AppError(400, 'Bu to‘lov turi o‘chirilgan. Sahifani yangilang.');
  const method = methods[raw.method] ? raw.method : Object.keys(methods)[0] || 'naqd';
  const got = money(raw.received) ?? paid;
  if (!Number.isFinite(got) || got < 0 || got > 1e9) throw new AppError(400, 'Berilgan summa noto‘g‘ri.');
  if (method === 'naqd' && got < paid) throw new AppError(400, `Berilgan pul kam: ${sum(paid - got)} so‘m yetmaydi.`);
  return {
    method, label: `${methods[method] || method} + qarz`, amount: total, paid,
    received: method === 'naqd' ? got : paid, change: method === 'naqd' ? got - paid : 0, debt, atMs, byName: actor.name,
  };
}

// Hisob yopilayotganda (yoki yetkazish to'lanayotganda) qarz yozuvi ochiladi → payment.debt.id
export async function recordDebt(payment, source, shiftId, actor) {
  if (!payment?.debt) return payment;
  const db = await needDb();
  const id = newId();
  const now = Date.now();
  await db.collection('debts').doc(id).set({
    name: payment.debt.name, phone: payment.debt.phone, amount: payment.debt.amount, paid: 0, left: payment.debt.amount, status: 'open',
    source: { kind: source.kind, id: source.id, label: str(source.label, 80) }, createdAtMs: now, byName: actor.name || '', byId: actor.id || '',
    shiftId: shiftId || '', payments: [],
  });
  return { ...payment, debt: { ...payment.debt, id } };
}

const view = (id, d) => ({
  id, name: d.name, phone: d.phone, amount: d.amount, paid: d.paid || 0, left: d.left ?? d.amount, status: d.status,
  source: d.source || {}, createdAt: iso(d.createdAtMs), byName: d.byName || '', closedAt: iso(d.closedAtMs),
  payments: (d.payments || []).map((p) => ({ amount: p.amount, method: p.method, label: p.label, change: p.change || 0, at: iso(p.atMs), byName: p.byName || '' })),
});

// Qarzdorlar ro'yxati: status — open | closed | all; q — ism yoki telefon bo'yicha qidiruv
export async function listDebts({ status = 'open', q = '' } = {}) {
  const db = await needDb();
  const st = ['open', 'closed', 'all'].includes(status) ? status : 'open';
  const snap = st === 'all'
    ? await db.collection('debts').orderBy('createdAtMs', 'desc').limit(1000).get()
    : await db.collection('debts').where('status', '==', st).limit(1000).get();
  let items = snap.docs.map((x) => view(x.id, x.data())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const text = String(q || '').trim().toLowerCase();
  const digits = text.replace(/\D/g, '');
  if (text) items = items.filter((d) => d.name.toLowerCase().includes(text) || (digits.length >= 3 && d.phone.replace(/\D/g, '').includes(digits)));
  const open = items.filter((d) => d.status === 'open');
  return { items: items.slice(0, 300), total: { count: open.length, left: open.reduce((a, d) => a + d.left, 0) } };
}

// Bitta telefon bo'yicha ochiq qarz (qarz yozishdan oldin kassirga ko'rsatiladi)
export async function debtOfPhone(phone) {
  let p;
  try {
    p = debtPhone(phone);
  } catch {
    return { count: 0, left: 0 };
  }
  const db = await needDb();
  const snap = await db.collection('debts').where('phone', '==', p).limit(200).get();
  const open = snap.docs.map((x) => x.data()).filter((d) => d.status === 'open');
  return { count: open.length, left: open.reduce((a, d) => a + (d.left ?? d.amount), 0), name: open[0]?.name || '' };
}

// Qarz to'lovi: { amount, method, received } — smenaga yoziladi (naqd bo'lsa kassadagi pul hisobiga qo'shiladi)
export async function payDebt(id, body, actor, { methods, shiftId }) {
  const db = await needDb();
  const amount = money(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, 'To‘lov summasini yozing.');
  const method = String(body?.method || 'naqd');
  if (method === 'qarz' || !methods[method]) throw new AppError(400, 'To‘lov turini tanlang.');
  const got = method === 'naqd' ? money(body?.received) ?? amount : amount;
  if (!Number.isFinite(got) || got < amount) throw new AppError(400, `Berilgan pul kam: ${sum(amount - (got || 0))} so‘m yetmaydi.`);
  const ref = db.collection('debts').doc(String(id));
  const now = Date.now();
  const entry = { amount, method, label: methods[method], received: got, change: got - amount, atMs: now, byName: actor.name || '', shiftId };
  let saved;
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new AppError(404, 'Qarz topilmadi.');
    const d = snap.data();
    const left = d.left ?? d.amount;
    if (d.status !== 'open' || left <= 0) throw new AppError(409, 'Bu qarz allaqachon yopilgan.');
    if (amount > left) throw new AppError(400, `Qarz ${sum(left)} so‘m — undan ko‘p olib bo‘lmaydi.`);
    const next = { paid: (d.paid || 0) + amount, left: left - amount, payments: [...(d.payments || []), entry].slice(-100) };
    if (next.left === 0) Object.assign(next, { status: 'closed', closedAtMs: now });
    t.update(ref, next);
    saved = { ...d, ...next };
  });
  await db.collection('debt_payments').doc(newId()).set({ debtId: String(id), name: saved.name, phone: saved.phone, amount, method, label: methods[method], shiftId, atMs: now, byName: actor.name || '' });
  return { debt: view(String(id), saved), change: entry.change };
}

// Smena hisoboti uchun: shu smenada olingan qarz to'lovlari
export async function debtPaymentsOfShift(shiftId) {
  const db = await getDb();
  if (!db || !shiftId) return [];
  const snap = await db.collection('debt_payments').where('shiftId', '==', shiftId).limit(2000).get().catch(() => null);
  return snap ? snap.docs.map((x) => x.data()) : [];
}
