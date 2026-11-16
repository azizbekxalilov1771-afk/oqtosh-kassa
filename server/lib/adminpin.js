import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { hmacHex, safeEqual } from './crypto.js';
import { adminEmails } from './auth.js';
import { isOwnerEmail } from './owners.js';
import { str } from './validate.js';

// Admin va egasi (owner) uchun PIN bilan kirish — faqat avval email bilan kirilgan, ishonchli qurilmada.
// Windows Hello'dagi PIN kabi: PIN qurilmaga bog'langan; boshqa kompyuterda bu PIN ishlamaydi.
//   1) Email + parol (yoki Google) bilan kiriladi → "Bu qurilmada PIN bilan kirish" → PIN (4–6 raqam) o'rnatiladi.
//      Server qurilmaga tasodifiy kalit beradi (brauzerda saqlanadi), bazada faqat uning va PIN'ning xeshi.
//   2) Keyingi safar shu qurilmada — faqat PIN. 5 marta xato → shu qurilmadagi PIN o'chadi, yana email bilan kiriladi.
//   3) Sessiya 12 soat; admin "Owner kirishi"da qurilmani o'chirsa — darhol amal qilmaydi.
//   admin_pins/{deviceId}: { email, salt, pinHash, tokenHash, label, ua, createdAtMs, lastUsedAtMs, fails }

const COL = 'admin_pins';
const SESSION_MS = 12 * 3_600_000;
const MAX_FAILS = 5;
const MAX_DEVICES = 10;
const PREFIX = 'oqa1.';

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Ma’lumotlar bazasi ulanmagan.');
  return db;
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pinHash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const b64u = (s) => Buffer.from(s).toString('base64url');

function checkPin(pin) {
  const p = String(pin ?? '');
  if (!/^\d{4,6}$/.test(p)) throw new AppError(400, 'PIN 4–6 ta raqamdan iborat bo‘lsin.');
  const easy = /^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p);
  if (easy) throw new AppError(400, 'Bu PIN juda oson (1111, 1234…). Boshqasini tanlang.');
  return p;
}
const allowed = async (email) => adminEmails().includes(email) || (await isOwnerEmail(email));
const resetErr = (msg) => Object.assign(new AppError(401, msg), { code: 'pin-reset' });

// Email bilan kirgan admin/egasi shu qurilmaga PIN o'rnatadi → { deviceId, deviceToken }
export async function setupPin(user, { pin, label, ua } = {}) {
  const email = String(user?.email || '').toLowerCase();
  if (!email || !(await allowed(email))) throw new AppError(403, 'PIN faqat admin va egasi uchun.');
  const p = checkPin(pin);
  const db = await needDb();
  const deviceId = crypto.randomBytes(12).toString('hex');
  const deviceToken = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  // bir emailga ko'pi bilan 10 qurilma — eng eskisi o'chadi
  const mine = (await db.collection(COL).where('email', '==', email).get()).docs.sort((a, b) => (a.data().createdAtMs || 0) - (b.data().createdAtMs || 0));
  for (const d of mine.slice(0, Math.max(0, mine.length - MAX_DEVICES + 1))) await d.ref.delete();
  await db.collection(COL).doc(deviceId).set({
    email, salt, pinHash: pinHash(p, salt), tokenHash: sha(deviceToken), label: str(label, 40) || 'Qurilma', ua: str(ua, 160),
    createdAtMs: now, lastUsedAtMs: now, fails: 0,
  });
  return { deviceId, deviceToken };
}

function signSession(payload) {
  const body = b64u(JSON.stringify(payload));
  return `${PREFIX}${body}.${hmacHex('admin-pin-session', body)}`;
}

// PIN bilan kirish → 12 soatlik sessiya kaliti
export async function pinLoginAdmin({ deviceId, deviceToken, pin } = {}) {
  const id = String(deviceId || '');
  if (!/^[a-f0-9]{24}$/.test(id) || typeof deviceToken !== 'string' || deviceToken.length < 20) throw resetErr('Bu qurilmada PIN o‘rnatilmagan. Email bilan kiring.');
  const db = await needDb();
  const ref = db.collection(COL).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw resetErr('Bu qurilmadagi PIN o‘chirilgan. Email bilan kiring.');
  const d = snap.data();
  if (!safeEqual(sha(deviceToken), d.tokenHash)) throw resetErr('Bu qurilmadagi PIN o‘chirilgan. Email bilan kiring.');
  if (!/^\d{4,6}$/.test(String(pin ?? '')) || !safeEqual(pinHash(pin, d.salt), d.pinHash)) {
    const fails = (d.fails || 0) + 1;
    if (fails >= MAX_FAILS) {
      await ref.delete();
      throw resetErr('PIN 5 marta xato terildi — bu qurilmada PIN o‘chirildi. Email bilan kiring.');
    }
    await ref.update({ fails });
    throw Object.assign(new AppError(401, `PIN noto‘g‘ri. Yana ${MAX_FAILS - fails} ta urinish qoldi.`), { code: 'pin-bad' });
  }
  if (!(await allowed(d.email))) {
    await ref.delete();
    throw new AppError(403, 'Bu hisobga endi ruxsat yo‘q.');
  }
  const now = Date.now();
  await ref.update({ fails: 0, lastUsedAtMs: now });
  return { token: signSession({ e: d.email, d: id, x: now + SESSION_MS }), email: d.email, expiresAt: new Date(now + SESSION_MS).toISOString() };
}

// Admin API: "oqa1." bilan boshlanadigan kalit — PIN sessiyasi (Firebase ID token o'rnida)
export const isPinSession = (token) => String(token || '').startsWith(PREFIX);
const seen = new Map(); // deviceId → tekshirilgan vaqt (har so'rovda bazani o'qimaslik uchun, 30 soniya)
export async function verifyPinSession(token) {
  const [body, sig] = String(token).slice(PREFIX.length).split('.');
  if (!body || !sig || !safeEqual(sig, hmacHex('admin-pin-session', body))) throw new AppError(401, 'Sessiya tugagan. Qaytadan kiring.');
  let p;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(401, 'Sessiya tugagan. Qaytadan kiring.');
  }
  if (!p?.e || !p?.d || !(p.x > Date.now())) throw new AppError(401, 'Sessiya tugagan. Qaytadan kiring.');
  if (!(seen.get(p.d) > Date.now() - 30_000)) {
    const snap = await (await needDb()).collection(COL).doc(p.d).get();
    if (!snap.exists || snap.data().email !== p.e) throw resetErr('Bu qurilmadagi PIN o‘chirilgan. Email bilan kiring.');
    seen.set(p.d, Date.now());
  }
  return { email: p.e, email_verified: true, uid: `pin:${p.d}`, pin: true, deviceId: p.d };
}

// Qurilmaning o'zi PIN'ni o'chiradi ("Chiqish va PIN'ni unutish")
export async function forgetPin({ deviceId, deviceToken } = {}) {
  const id = String(deviceId || '');
  if (!/^[a-f0-9]{24}$/.test(id)) return { ok: true };
  const db = await needDb();
  const snap = await db.collection(COL).doc(id).get();
  if (snap.exists && safeEqual(sha(String(deviceToken || '')), snap.data().tokenHash)) await snap.ref.delete();
  seen.delete(id);
  return { ok: true };
}

export async function listPinDevices() {
  const db = await needDb();
  const snap = await db.collection(COL).limit(200).get();
  return snap.docs.map((d) => ({ id: d.id, email: d.data().email, label: d.data().label || '', ua: d.data().ua || '', createdAt: new Date(d.data().createdAtMs || 0).toISOString(), lastUsedAt: d.data().lastUsedAtMs ? new Date(d.data().lastUsedAtMs).toISOString() : '' }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export async function revokePinDevice(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) throw new AppError(404, 'Qurilma topilmadi.');
  await (await needDb()).collection(COL).doc(id).delete();
  seen.delete(id);
  return { ok: true };
}
