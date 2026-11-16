import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { normalizePhone, STAFF_ROLES, getCustomer } from './customers.js';
import { str } from './validate.js';
import { hmacHex, sha256 } from './crypto.js';

// Xodimlar uchun ikkinchi kirish yo'li: telefon raqami + parol, faqat restoran Wi‑Fi'sidan.
// Telefon qaysi Wi‑Fi'ga ulanganini sayt bilmaydi — lekin bir routerdagi hamma qurilmalar internetga
// bitta umumiy manzil (IP) bilan chiqadi. Shu manzil "ishxona tarmog'i" deb saqlanadi:
//  • admin panelda "Shu tarmoqni qo'shish" (admin kompyuteri = kassa kompyuteri restoranda turadi);
//  • chek printeri qilib tanlangan kassa kompyuterining manzili o'zi qo'shiladi va provayder
//    manzilni almashtirsa ham bir necha daqiqada yangilanadi.
// settings/workplace: { enabled, networks: [{ ip, label, auto, lastSeenMs, addedAtMs }] }

const DEFAULT = { enabled: false, networks: [] };
export const PW_SESSION_HOURS = 16; // bir smena
const MAX_FAILS = 5; // 4 xonali PIN: 5 ta xatodan keyin 15 daqiqa qulf
const LOCK_MS = 15 * 60_000;

export const getWorkplace = () => readSetting('workplace', DEFAULT);

/* ───────── IP manzillar ───────── */

export function normalizeIp(ip) {
  let v = String(ip || '').trim().toLowerCase();
  if (v.startsWith('::ffff:') && v.includes('.')) v = v.slice(7);
  return v;
}

function expand6(ip) {
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  if (!ip.includes('::') && a.length !== 8) return null;
  const parts = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => p.padStart(4, '0'));
}

export function validIp(ip) {
  const v = normalizeIp(ip);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split('.').every((n) => Number(n) <= 255);
  return v.includes(':') && Boolean(expand6(v));
}

// IPv4 — aynan bir xil; IPv6 — bir router ichida qurilmalar /64 tarmog'ini bo'lishadi
export function sameNetwork(a, b) {
  const x = normalizeIp(a);
  const y = normalizeIp(b);
  if (!x || !y) return false;
  if (x.includes(':') && y.includes(':')) {
    const ex = expand6(x);
    const ey = expand6(y);
    return Boolean(ex && ey && ex.slice(0, 4).join(':') === ey.slice(0, 4).join(':'));
  }
  return x === y;
}

export async function isWorkplaceIp(ip) {
  const w = await getWorkplace();
  return (w.networks || []).some((n) => sameNetwork(n.ip, ip));
}

// Kassa kompyuteri (chek printeri) so'rov yuborganda — uning tarmog'ini avtomatik eslab qolish
export async function noteStationIp(ip) {
  const v = normalizeIp(ip);
  if (!validIp(v)) return;
  const w = await getWorkplace();
  const now = Date.now();
  const nets = [...(w.networks || [])];
  const hit = nets.find((n) => n.auto && sameNetwork(n.ip, v));
  if (hit && now - (hit.lastSeenMs || 0) < 30 * 60_000) return;
  if (hit) hit.lastSeenMs = now;
  else nets.push({ ip: v, label: 'Kassa kompyuteri', auto: true, lastSeenMs: now, addedAtMs: now });
  // avtomatik manzillardan faqat oxirgi 3 tasi va 30 kun ichida ko'ringanlari qoladi
  const autos = nets.filter((n) => n.auto && now - (n.lastSeenMs || 0) < 30 * 86_400_000).sort((a, b) => b.lastSeenMs - a.lastSeenMs).slice(0, 3);
  await writeSetting('workplace', { ...w, networks: [...nets.filter((n) => !n.auto), ...autos] });
}

/* ───────── Parol ───────── */

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`;

function checkPassword(password, stored) {
  const [kind, salt, hex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const got = Buffer.from(hashPassword(password, salt).split('$')[2], 'hex');
  const want = Buffer.from(hex, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Xodim PIN'i — 4 xonali raqam (kassa va telefonda tez teriladi). Oson taxmin qilinadiganlari rad etiladi.
const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '1212', '2580', '1122', '1010', '2020']);

// PIN — xodimning yagona kaliti: telefon raqamisiz, faqat 4 ta raqam bilan kiriladi. Shuning uchun
// restoranda ikkita xodimda bir xil PIN bo'lmaydi. Qidirish uchun PIN'ning maxfiy izi (pinKey, HMAC)
// saqlanadi; PIN'ning o'zi — scrypt (pwHash). Iz kaliti almashsa (pinTag mos kelmasa) — eski usulda tekshiriladi.
const pinKeyOf = (pin) => hmacHex('staff-pin', `pin:${pin}`);
const pinTag = () => hmacHex('staff-pin', 'tag').slice(0, 8);
const keyed = (c) => Boolean(c.pinKey) && c.pinTag === pinTag();
const pinFields = (pin) => ({ pwHash: hashPassword(pin), pinKey: pinKeyOf(pin), pinTag: pinTag() });

async function staffDocs(db) {
  const snaps = await Promise.all(STAFF_ROLES.map((r) => db.collection('customers').where('role', '==', r).limit(300).get()));
  return snaps.flatMap((s) => s.docs);
}

// Shu PIN qaysi xodim(lar)niki — izi bor hisoblar tez, eskilari (izsiz) scrypt bilan tekshiriladi
async function pinOwners(db, pin, exceptId = '', docs = null) {
  const key = pinKeyOf(pin);
  const out = [];
  for (const d of docs || (await staffDocs(db))) {
    if (d.id === exceptId) continue;
    const c = d.data();
    if (!c.pwHash) continue;
    if (keyed(c) ? c.pinKey === key : checkPassword(pin, c.pwHash)) out.push(d);
  }
  return out;
}

async function uniquePin(db, pin, exceptId) {
  if ((await pinOwners(db, pin, exceptId)).length) throw new AppError(409, 'Bu PIN boshqa xodimda band — boshqasini yozing yoki bo‘sh qoldiring (o‘zi yaratiladi).');
  return pin;
}

async function genPassword(db, exceptId = '') {
  const docs = await staffDocs(db);
  for (let i = 0; i < 200; i++) {
    const v = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
    if (!WEAK.has(v) && !(await pinOwners(db, v, exceptId, docs)).length) return v;
  }
  throw new AppError(409, 'Bo‘sh PIN topilmadi — o‘zingiz yozing.');
}

function validPassword(p) {
  const v = String(p || '').trim();
  if (!/^\d{4}$/.test(v)) throw new AppError(400, 'PIN — aniq 4 ta raqam.');
  if (WEAK.has(v)) throw new AppError(400, 'Bu PIN juda oson (1234, 0000 kabi). Boshqasini tanlang.');
  return v;
}

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

// Admin: xodimga PIN berish (bo'sh bo'lsa — 4 xonali o'zi yaratiladi). PIN faqat shu javobda ko'rinadi.
export async function setStaffPassword(id, password) {
  const c = await getCustomer(id);
  if (!c) throw new AppError(404, 'Xodim topilmadi.');
  if (!STAFF_ROLES.includes(c.role)) throw new AppError(409, 'Avval xodim qiling (ofitsiant, kassir yoki kuryer).');
  const db = await needDb();
  const pw = password ? await uniquePin(db, validPassword(password), c.id) : await genPassword(db, c.id);
  // eski parol bilan ochilgan sessiyalar yopiladi (Telegram orqali kirgani qoladi)
  await db.collection('customers').doc(c.id).update({ ...pinFields(pw), pwVersion: (c.pwVersion || 0) + 1, pwSetAtMs: Date.now(), pwFails: 0, pwLockUntilMs: 0, updatedAt: new Date() });
  return { password: pw, name: c.name || c.firstName || c.phone };
}

export async function clearStaffPassword(id) {
  const c = await getCustomer(id);
  if (!c) throw new AppError(404, 'Xodim topilmadi.');
  const db = await needDb();
  await db.collection('customers').doc(c.id).update({ pwHash: '', pinKey: '', pinTag: '', pwVersion: (c.pwVersion || 0) + 1, pwSetAtMs: 0, updatedAt: new Date() });
  return { ok: true };
}

// Admin: xodimni ismi bilan qo'shish (darhol PIN bilan). Telefon ixtiyoriy — yozilsa va shu raqamli hisob bo'lsa, o'sha xodim qilinadi.
export async function createPasswordStaff({ phone, name, role, pin }) {
  if (!STAFF_ROLES.includes(role)) throw new AppError(400, 'Lavozimni tanlang.');
  const p = String(phone || '').trim() ? normalizePhone(phone) : '';
  if (p && p.length < 8) throw new AppError(400, 'Telefon raqamini to‘liq yozing (+998 90 123 45 67) yoki bo‘sh qoldiring.');
  const clean = str(name, 80);
  if (pin) validPassword(pin);
  const db = await needDb();
  const exists = p ? await db.collection('customers').where('phone', '==', p).limit(1).get() : { empty: true, docs: [] };
  if (exists.empty && clean.length < 2) throw new AppError(400, 'Xodimning ismini yozing.');
  const selfId = exists.empty ? '' : exists.docs[0].id;
  const pw = pin ? await uniquePin(db, pin, selfId) : await genPassword(db, selfId);
  if (!exists.empty) {
    const doc = exists.docs[0];
    const c = doc.data();
    await doc.ref.update({ role, name: clean.length >= 2 ? clean : c.name || c.firstName || p, ...pinFields(pw), pwVersion: (c.pwVersion || 0) + 1, pwSetAtMs: Date.now(), pwFails: 0, pwLockUntilMs: 0, updatedAt: new Date() });
    return { item: { id: doc.id, name: clean.length >= 2 ? clean : c.name || c.firstName || p, phone: p, username: c.username || '', role, hasPassword: true }, password: pw };
  }
  // Telegram ID'lardan farqlanadigan 15 xonali ID
  const id = `9${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}${String(crypto.randomInt(0, 1e5)).padStart(5, '0')}`;
  await db.collection('customers').doc(id).set({
    tgId: '', firstName: clean, lastName: '', username: '', name: clean, phone: p, role, sessionVersion: 0,
    ...pinFields(pw), pwSetAtMs: Date.now(), pwFails: 0, pwLockUntilMs: 0, noTelegram: true, createdAt: new Date(), updatedAt: new Date(),
  });
  return { item: { id, name: clean, phone: p, username: '', role, hasPassword: true }, password: pw };
}

// Xodim: telefon + 4 xonali PIN bilan kirish.
// Admin "faqat restoran Wi‑Fi'sidan" yoqqan bo'lsa — ofitsiant va kassir faqat ishxona tarmog'idan (kuryer yo'lda — undan tashqari).
export async function passwordLogin(ip, { phone, password }) {
  const w = await getWorkplace();
  const p = normalizePhone(phone);
  if (p.length < 8 || !password) throw new AppError(400, 'Telefon raqami va PIN’ni yozing.');
  const db = await needDb();
  const snap = await db.collection('customers').where('phone', '==', p).limit(5).get();
  const doc = snap.docs.find((d) => STAFF_ROLES.includes(d.data().role) && d.data().pwHash);
  const wrong = new AppError(400, 'Telefon raqami yoki PIN noto‘g‘ri.');
  if (!doc) throw wrong;
  const c = doc.data();
  const now = Date.now();
  if (w.enabled && c.role !== 'courier' && !(await isWorkplaceIp(ip))) {
    throw new AppError(403, `Faqat restoran Wi‑Fi’siga ulanganda kirish mumkin. Wi‑Fi’ni yoqing (mobil internet emas).${ip ? ` Tarmoq: ${normalizeIp(ip)}` : ''}`);
  }
  if ((c.pwLockUntilMs || 0) > now) throw new AppError(429, `PIN ko‘p marta noto‘g‘ri kiritildi. ${Math.ceil((c.pwLockUntilMs - now) / 60000)} daqiqadan so‘ng urinib ko‘ring yoki adminga ayting.`);
  if (!checkPassword(password, c.pwHash)) {
    const fails = (c.pwFails || 0) + 1;
    await doc.ref.update(fails >= MAX_FAILS ? { pwFails: 0, pwLockUntilMs: now + LOCK_MS } : { pwFails: fails });
    throw wrong;
  }
  if (c.pwFails || c.pwLockUntilMs) await doc.ref.update({ pwFails: 0, pwLockUntilMs: 0 });
  return { id: doc.id, ...c };
}

// Xodim: faqat 4 xonali PIN bilan kirish (telefon raqamisiz). PIN kimniki bo'lsa — o'sha xodim kiradi.
// Xato urinishlar qurilma tarmog'i (IP) bo'yicha sanaladi: restoran Wi‑Fi'sida hamma bitta manzilda bo'lgani
// uchun u yerda chegara kengroq (15 ta xato → 3 daqiqa), tashqaridan qattiqroq (5 ta xato → 15 daqiqa).
export async function pinLogin(ip, { pin }) {
  const v = String(pin ?? '').trim();
  if (!/^\d{4}$/.test(v)) throw new AppError(400, 'PIN — 4 ta raqam.');
  const db = await needDb();
  const w = await getWorkplace();
  const onSite = await isWorkplaceIp(ip);
  const guard = db.collection('pin_guard').doc(sha256(`ip:${normalizeIp(ip) || '-'}`).slice(0, 32));
  const now = Date.now();
  const g = (await guard.get()).data() || {};
  if ((g.lockUntilMs || 0) > now) throw new AppError(429, `PIN ko‘p marta noto‘g‘ri terildi. ${Math.ceil((g.lockUntilMs - now) / 60000)} daqiqadan so‘ng urinib ko‘ring.`);
  const fail = async (err) => {
    const limit = onSite ? 15 : MAX_FAILS;
    const fresh = now - (g.firstFailMs || 0) < LOCK_MS;
    const fails = (fresh ? g.fails || 0 : 0) + 1;
    await guard.set(fails >= limit ? { fails: 0, firstFailMs: 0, lockUntilMs: now + (onSite ? 3 * 60_000 : LOCK_MS) } : { fails, firstFailMs: fresh && g.firstFailMs ? g.firstFailMs : now, lockUntilMs: 0 });
    throw err;
  };
  const owners = await pinOwners(db, v);
  if (!owners.length) return fail(new AppError(400, 'PIN noto‘g‘ri.'));
  if (owners.length > 1) throw new AppError(409, 'Bu PIN bir nechta xodimda bor. Admin har biriga alohida PIN bersin (Admin → Xodimlar).');
  const doc = owners[0];
  const c = doc.data();
  if (w.enabled && c.role !== 'courier' && !onSite) {
    return fail(new AppError(403, `Faqat restoran Wi‑Fi’siga ulanganda kirish mumkin. Wi‑Fi’ni yoqing (mobil internet emas).${ip ? ` Tarmoq: ${normalizeIp(ip)}` : ''}`));
  }
  const patch = keyed(c) ? {} : { pinKey: pinKeyOf(v), pinTag: pinTag() }; // eski PIN — izi yoziladi
  if (c.pwFails || c.pwLockUntilMs) Object.assign(patch, { pwFails: 0, pwLockUntilMs: 0 });
  if (Object.keys(patch).length) await doc.ref.update(patch);
  if (g.fails) await guard.set({ fails: 0, firstFailMs: 0, lockUntilMs: 0 });
  return { id: doc.id, ...c, ...patch };
}

/* ───────── Admin: ishxona tarmog'i ───────── */

export async function workplaceForAdmin(ip) {
  const w = await getWorkplace();
  const current = normalizeIp(ip);
  return {
    enabled: Boolean(w.enabled),
    currentIp: current,
    currentAllowed: (w.networks || []).some((n) => sameNetwork(n.ip, current)),
    networks: (w.networks || []).map((n) => ({
      ip: n.ip, label: n.label || '', auto: Boolean(n.auto),
      lastSeenAt: n.lastSeenMs ? new Date(n.lastSeenMs).toISOString() : '', addedAt: n.addedAtMs ? new Date(n.addedAtMs).toISOString() : '',
    })),
  };
}

export async function saveWorkplace({ enabled }, ip) {
  const w = await getWorkplace();
  if (enabled && !(w.networks || []).length) throw new AppError(409, 'Avval ishxona tarmog‘ini qo‘shing: restoran Wi‑Fi’siga ulangan kompyuterdan “Shu tarmoqni qo‘shish”ni bosing.');
  await writeSetting('workplace', { ...w, enabled: Boolean(enabled) });
  return workplaceForAdmin(ip);
}

export async function addNetwork({ ip: manual, label }, requestIp) {
  const v = normalizeIp(manual || requestIp);
  if (!validIp(v)) throw new AppError(400, 'Internet manzili (IP) noto‘g‘ri.');
  const w = await getWorkplace();
  const nets = (w.networks || []).filter((n) => !sameNetwork(n.ip, v) || n.auto);
  nets.push({ ip: v, label: str(label, 40) || 'Restoran Wi‑Fi', auto: false, lastSeenMs: 0, addedAtMs: Date.now() });
  await writeSetting('workplace', { ...w, networks: nets });
  return workplaceForAdmin(requestIp);
}

export async function removeNetwork(ip, requestIp) {
  const v = normalizeIp(decodeURIComponent(String(ip || '')));
  const w = await getWorkplace();
  const nets = (w.networks || []).filter((n) => normalizeIp(n.ip) !== v);
  await writeSetting('workplace', { ...w, networks: nets, enabled: nets.length ? w.enabled : false });
  return workplaceForAdmin(requestIp);
}
