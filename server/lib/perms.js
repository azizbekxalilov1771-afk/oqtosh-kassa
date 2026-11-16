import { AppError } from './env.js';
import { readSetting, writeSetting } from './settings.js';
import { requireCustomer } from './session.js';
import { getDb } from './firebase.js';
import { STAFF_ROLES } from './customers.js';

// Xodim ruxsatlari: lavozim bo'yicha standart (admin o'zgartiradi) + har bir xodimga alohida qo'shish/olib tashlash.
//   settings/permissions  { roles: { waiter: { 'tab.pay': false, ... }, cashier: {...}, courier: {...} } }
//   customers/{id}.perms  { 'tab.discount': true, 'order.cancel': false } — faqat lavozimdan farqli belgilar
// Ro'yxatga keyin yangi ruxsat qo'shilsa, saqlangan sozlamada u bo'lmaydi — lavozim standarti ishlaydi.

export const PERMS = [
  { group: 'Sahifalar', items: [
    ['page.ofitsiant', 'Ofitsiant sahifasi'],
    ['page.kassa', 'Kassa sahifasi'],
    ['page.kuryer', 'Kuryer sahifasi'],
    ['page.ombor', 'Ombor sahifasi'],
  ] },
  { group: 'Buyurtmalar', items: [
    ['order.create', 'Buyurtma kiritish (stol, saboy)'],
    ['order.accept', 'Mijoz buyurtmasini qabul qilish / rad etish'],
    ['order.void', 'Taomni hisobdan olib tashlash'],
    ['order.cancel', 'Buyurtmani butunlay bekor qilish (Mison’dan ham)'],
    ['kitchen.reprint', 'Oshxona chekini qayta chiqarish'],
  ] },
  { group: 'Stol hisobi', items: [
    ['bill.print', 'Hisob chekini chiqarish'],
    ['tab.pay', 'To‘lov olish (stol hisobi va yetkazish)'],
    ['tab.close', 'To‘lovsiz yopish (“Mijoz ketdi”)'],
    ['tab.discount', 'Chegirma berish'],
    ['tab.service', 'Xizmat foizini o‘zgartirish'],
    ['tab.move', 'Stolni boshqa stolga ko‘chirish'],
    ['tab.merge', 'Stollarni birlashtirish'],
    ['tab.split', 'Hisobni bo‘lish (bitta stolda ikki chek)'],
    ['tab.waiter', 'Ofitsiantni almashtirish'],
    ['tab.history', 'Yopilgan hisoblar tarixi'],
  ] },
  { group: 'Smena va hisobot', items: [
    ['shift.open', 'Smena ochish'],
    ['shift.cash', 'Kassaga pul kiritish / kassadan olish'],
    ['shift.close', 'Smenani yopish (Z-hisobot)'],
    ['reports.view', 'Smena hisobotini ko‘rish (X-hisobot)'],
    ['wages.view', 'Xodimlar ish haqi hisobini ko‘rish'],
    ['wages.manage', 'Ish haqi stavkalarini o‘zgartirish'],
  ] },
  { group: 'Yetkazib berish', items: [
    ['delivery.manage', 'Yetkazishlarni boshqarish (kassada)'],
    ['delivery.take', 'Yetkazishni olish va “yetkazildi” (kuryer)'],
  ] },
  { group: 'Ombor', items: [
    ['stock.receive', 'Mahsulot kirimi (kelgan mahsulot)'],
    ['stock.count', 'Kunlik qoldiqni (astatka) yozish'],
    ['stock.suppliers', 'Ta’minotchi qo‘shish / tahrirlash'],
    ['stock.products', 'Mahsulot qo‘shish / tahrirlash'],
    ['stock.reports', 'Ombor hisobotini ko‘rish'],
  ] },
];
export const PERM_KEYS = PERMS.flatMap((g) => g.items.map(([k]) => k));
export const PERM_LABEL = Object.fromEntries(PERMS.flatMap((g) => g.items));

export const ROLE_DEFAULTS = {
  waiter: ['page.ofitsiant', 'order.create', 'order.accept', 'kitchen.reprint', 'bill.print', 'tab.close'],
  cashier: PERM_KEYS.filter((k) => k !== 'page.ombor' && !k.startsWith('stock.') && k !== 'wages.manage'),
  courier: ['page.kuryer', 'delivery.take'],
  storekeeper: ['page.ombor', 'stock.receive', 'stock.count', 'stock.suppliers', 'stock.products', 'stock.reports'],
};

// lavozimning to'liq xaritasi: { key: true|false } (saqlanmagan kalitlar — standartdan)
function roleMap(stored, role) {
  const def = new Set(ROLE_DEFAULTS[role] || []);
  const own = stored?.[role] || {};
  return Object.fromEntries(PERM_KEYS.map((k) => [k, typeof own[k] === 'boolean' ? own[k] : def.has(k)]));
}

export async function getRolePerms() {
  const s = await readSetting('permissions', {});
  return Object.fromEntries(STAFF_ROLES.map((r) => [r, roleMap(s.roles, r)]));
}

const cleanMap = (m, { allowNull = false } = {}) => {
  const out = {};
  for (const k of PERM_KEYS) {
    const v = m?.[k];
    if (typeof v === 'boolean') out[k] = v;
    else if (allowNull && v === null) out[k] = null;
  }
  return out;
};

export async function saveRolePerms(body) {
  const cur = await readSetting('permissions', {});
  const roles = { ...(cur.roles || {}) };
  for (const r of STAFF_ROLES) if (body?.roles?.[r]) roles[r] = { ...roleMap(cur.roles, r), ...cleanMap(body.roles[r]) };
  // kassir kassaga kira olmay qolsa — hech kim smena yopa olmaydi; eng kamida bitta lavozimda kassa sahifasi qolsin
  if (!STAFF_ROLES.some((r) => roleMap(roles, r)['page.kassa'])) throw new AppError(400, 'Kamida bitta lavozimda “Kassa sahifasi” yoqilgan bo‘lsin.');
  await writeSetting('permissions', { roles });
  return getRolePerms();
}

// Xodimning o'z belgilari: true — qo'shilgan, false — olib tashlangan, null — lavozimdagidek
export async function saveStaffPerms(id, perms) {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  const ref = db.collection('customers').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists || !STAFF_ROLES.includes(snap.data().role)) throw new AppError(404, 'Xodim topilmadi.');
  const next = { ...(snap.data().perms || {}) };
  for (const [k, v] of Object.entries(cleanMap(perms, { allowNull: true }))) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  // lavozimdagi bilan bir xil bo'lgan belgilarni saqlamaymiz (lavozim o'zgarsa, xodim ham ergashadi)
  const base = (await getRolePerms())[snap.data().role];
  for (const k of Object.keys(next)) if (next[k] === base[k]) delete next[k];
  await ref.update({ perms: next, updatedAt: new Date() });
  return { id: snap.id, perms: next, effective: PERM_KEYS.filter((k) => (typeof next[k] === 'boolean' ? next[k] : base[k])) };
}

export async function permsFor(c) {
  if (!STAFF_ROLES.includes(c?.role)) return [];
  const base = (await getRolePerms())[c.role];
  const own = c.perms || {};
  return PERM_KEYS.filter((k) => (typeof own[k] === 'boolean' ? own[k] : base[k]));
}

// Sahifaga kirish: ro'yxatdagi sahifalardan kamida bittasi ochiq bo'lsin. Qaytgan xodimda `can` (Set) bor.
export async function requireStaffAccess(request, pages) {
  const c = await requireCustomer(request);
  if (!STAFF_ROLES.includes(c.role)) throw new AppError(403, 'Bu sahifa faqat xodimlar uchun. Admin sizni “Xodimlar” bo‘limida qo‘shishi kerak.');
  c.can = new Set(await permsFor(c));
  if (!pages.some((p) => c.can.has(p))) {
    throw new AppError(403, `Sizga ${pages.map((p) => `“${PERM_LABEL[p]}”`).join(' yoki ')} ochilmagan. Admin “Xodimlar → Ruxsatlar” bo‘limida beradi.`);
  }
  return c;
}

// Amalga ruxsat. code 'perm' — sahifa yopilmaydi, faqat shu amal rad etiladi.
export function need(staff, key) {
  if (staff?.can?.has(key)) return;
  throw Object.assign(new AppError(403, `Sizda bu amalga ruxsat yo‘q: ${PERM_LABEL[key] || key}. Admin “Xodimlar → Ruxsatlar” bo‘limida beradi.`), { code: 'perm' });
}

export function needAny(staff, keys) {
  if (keys.some((k) => staff?.can?.has(k))) return;
  need(staff, keys[0]);
}
