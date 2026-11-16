import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { str } from './validate.js';

// Mijozlar va xodimlar: customers/{telegramId}. Telegram ID — o'zgarmas va noyob kalit.
// role: 'customer' (standart), xodimlar (admin paneldan beriladi): 'waiter' ofitsiant, 'cashier' kassir, 'courier' kuryer.

export const ROLES = { customer: 'Mijoz', waiter: 'Ofitsiant', cashier: 'Kassir', courier: 'Kuryer', storekeeper: 'Omborchi' };
export const STAFF_ROLES = ['waiter', 'cashier', 'courier', 'storekeeper'];

export const normalizePhone = (p) => {
  const digits = String(p || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
};

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

const ref = (db, id) => db.collection('customers').doc(String(id));

export async function getCustomer(id) {
  if (!id) return null;
  const snap = await ref(await needDb(), id).get();
  return snap.exists ? { id: String(id), ...snap.data() } : null;
}

// Botga yozgan Telegram foydalanuvchisi ma'lumotini yangilash (yangi bo'lsa yaratish)
export async function upsertFromTelegram(from) {
  const db = await needDb();
  const r = ref(db, from.id);
  const snap = await r.get();
  const base = {
    tgId: String(from.id),
    firstName: str(from.first_name, 64),
    lastName: str(from.last_name, 64),
    username: str(from.username, 64),
    updatedAt: new Date(),
  };
  if (snap.exists) {
    await r.update(base);
    return { id: String(from.id), ...snap.data(), ...base };
  }
  const doc = { ...base, name: str([from.first_name, from.last_name].filter(Boolean).join(' '), 80), phone: '', role: 'customer', sessionVersion: 0, createdAt: new Date() };
  await r.set(doc);
  return { id: String(from.id), ...doc };
}

export async function updateCustomer(id, patch) {
  await ref(await needDb(), id).update({ ...patch, updatedAt: new Date() });
}

// Mijozga ko'rsatiladigan profil (guest — stol QR orqali faqat telefon raqami bilan kirgan, Telegram'siz)
export const publicProfile = (c) => ({
  id: c.id, name: c.name || c.firstName || '', phone: c.phone || '', username: c.username || '',
  role: ROLES[c.role] ? c.role : 'customer', ...(c.guest ? { guest: true } : {}),
});

// Stol QR orqali buyurtma: faqat telefon raqami (Telegram tasdiqlashsiz). Har safar yangi "mehmon" hisobi —
// boshqa birov shu raqamni yozsa ham avvalgi buyurtmalarni ko'ra olmaydi. Buyurtmani baribir ofitsiant
// stolga kelib tasdiqlaydi. Keyin shu raqam Telegram orqali tasdiqlansa — bu buyurtmalar o'sha profilda ko'rinadi.
export async function createGuest({ phone, name } = {}) {
  const p = normalizePhone(phone);
  if (!/^\+998\d{9}$/.test(p)) throw new AppError(400, 'Telefon raqamini to‘liq yozing: +998 90 123 45 67.');
  const db = await needDb();
  const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const doc = { guest: true, phone: p, name: str(name, 60), role: 'customer', sessionVersion: 0, createdAt: new Date() };
  await ref(db, id).set(doc);
  return { id, ...doc };
}

export async function renameCustomer(id, name) {
  const clean = str(name, 80);
  if (clean.length < 2) throw new AppError(400, 'Ismingizni yozing.');
  await updateCustomer(id, { name: clean });
  return clean;
}

/* ───────── Admin: xodimlar ───────── */
export async function listStaff() {
  const db = await needDb();
  const snaps = await Promise.all(STAFF_ROLES.map((r) => db.collection('customers').where('role', '==', r).limit(200).get()));
  return snaps.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...publicProfile({ id: d.id, ...d.data() }), hasPassword: Boolean(d.data().pwHash), noTelegram: Boolean(d.data().noTelegram), perms: d.data().perms || {} })));
}

export async function countCustomers() {
  const db = await getDb();
  if (!db) return null;
  try {
    const q = db.collection('customers');
    if (typeof q.count === 'function') return (await q.count().get()).data().count;
    return (await q.limit(10000).get()).size;
  } catch {
    return null;
  }
}

export async function setRoleByPhone(phone, role) {
  if (!ROLES[role]) throw new AppError(400, 'Rol noto‘g‘ri.');
  const p = normalizePhone(phone);
  if (p.length < 8) throw new AppError(400, 'Telefon raqamini to‘liq yozing: +998 90 123 45 67');
  const db = await needDb();
  const snap = await db.collection('customers').where('phone', '==', p).limit(1).get();
  if (snap.empty) throw new AppError(404, 'Bu raqam bilan hali hech kim kirmagan. Xodim avval saytga Telegram orqali bir marta kirsin, keyin qo‘shing.');
  const doc = snap.docs[0];
  await doc.ref.update({ role, updatedAt: new Date() });
  return { id: doc.id, ...publicProfile({ id: doc.id, ...doc.data(), role }) };
}

export async function setRoleById(id, role) {
  if (!ROLES[role]) throw new AppError(400, 'Rol noto‘g‘ri.');
  const c = await getCustomer(id);
  if (!c) throw new AppError(404, 'Foydalanuvchi topilmadi.');
  await updateCustomer(id, { role });
  return { ...publicProfile({ ...c, role }) };
}
