import { AppError, env } from './env.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { getBotInfo, loginBot } from './telegram.js';
import { randomToken, randomDigits, sha256, safeEqual } from './crypto.js';

// Telegram orqali kirish:
// 1) sayt so'rov yaratadi va botga havola beradi (t.me/bot?start=login_ID)
// 2) bot telefon raqamini so'raydi (birinchi marta) va 6 xonali kod yuboradi
// 3) mijoz kodni saytga kiritadi — shu brauzer va shu Telegram hisobi bitta odamniki ekani tasdiqlanadi
// Kod brauzerda kiritilgani uchun begona odam havolani yuborib, boshqaning hisobiga kira olmaydi.

const TTL = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const ref = (db, id) => db.collection('login_requests').doc(id);

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

export async function loginReady() {
  return Boolean(loginBot(await getConfig()).telegramBotToken);
}

export async function startLogin() {
  const cfg = loginBot(await getConfig());
  if (!cfg.telegramBotToken) throw new AppError(503, 'Telegram orqali kirish hali sozlanmagan.');
  let bot;
  try {
    bot = await getBotInfo(cfg);
  } catch (e) {
    console.error('[login] getMe:', e.message);
    throw new AppError(503, 'Telegram bot bilan bog‘lanib bo‘lmadi. Birozdan so‘ng urinib ko‘ring.');
  }
  const db = await needDb();
  const id = randomToken(16);
  const now = Date.now();
  await ref(db, id).set({ status: 'pending', tgId: '', attempts: 0, createdAt: new Date(), expiresAtMs: now + TTL });
  return { id, botUrl: `https://t.me/${bot.username}?start=login_${id}`, botUsername: bot.username, expiresIn: TTL / 1000 };
}

async function load(db, id) {
  if (!/^[\w-]{10,40}$/.test(String(id || ''))) return null;
  const snap = await ref(db, id).get();
  return snap.exists ? snap.data() : null;
}

export async function loginStatus(id) {
  const r = await load(await needDb(), id);
  if (!r) return 'expired';
  if (r.status !== 'used' && Date.now() > r.expiresAtMs) return 'expired';
  return r.status; // pending | contact | code_sent | used
}

// Bot: mijoz havolani ochdi. Natija: 'expired' | 'contact' (raqam kerak) | { code }
export async function attachTelegram(id, customer) {
  const db = await needDb();
  const r = await load(db, id);
  if (!r || r.status === 'used' || Date.now() > r.expiresAtMs) return 'expired';
  if (r.tgId && r.tgId !== customer.id) return 'expired'; // havola boshqa Telegram hisobida ochilgan
  await ref(db, id).update({ tgId: customer.id, status: 'contact' });
  if (!customer.phone) return 'contact';
  return { code: await issueCode(id) };
}

export async function issueCode(id) {
  const db = await needDb();
  const code = randomDigits(6);
  await ref(db, id).update({
    status: 'code_sent', codeHash: sha256(`${id}:${code}`), attempts: 0, expiresAtMs: Date.now() + TTL,
  });
  return code;
}

// Sayt: mijoz kodni kiritdi. Muvaffaqiyatli bo'lsa — Telegram ID
export async function verifyLogin(id, code) {
  const db = await needDb();
  const r = await load(db, id);
  const clean = String(code || '').replace(/\D/g, '');
  if (!r || r.status === 'used' || Date.now() > r.expiresAtMs) throw new AppError(410, 'Kod eskirgan. "Qaytadan boshlash"ni bosing.');
  if (r.status !== 'code_sent') throw new AppError(409, 'Avval Telegram’da botni ochib, raqamingizni yuboring.');
  if (r.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'Kod ko‘p marta noto‘g‘ri kiritildi. "Qaytadan boshlash"ni bosing.');
  if (clean.length !== 6 || !safeEqual(sha256(`${id}:${clean}`), r.codeHash)) {
    await ref(db, id).update({ attempts: (r.attempts || 0) + 1 });
    const left = MAX_ATTEMPTS - (r.attempts || 0) - 1;
    throw new AppError(400, left > 0 ? `Kod noto‘g‘ri. Yana ${left} marta urinish mumkin.` : 'Kod ko‘p marta noto‘g‘ri kiritildi. "Qaytadan boshlash"ni bosing.');
  }
  await ref(db, id).update({ status: 'used', usedAt: new Date() });
  return r.tgId;
}

/* ───────── Google Play tekshiruvchisi ───────── */
// Play ilovani tekshirganda xodim Telegram orqali kira olmaydi. Shuning uchun ilova ichida
// "Google Play sinovchisi" kirishi bor: PLAY_REVIEW_CODE kodi bilan sinov hisobiga kiradi.
// Sinov hisobi oddiy mijoz: buyurtmasi xodimga "SINOV — Google Play" nomi bilan keladi, uni rad etasiz.
export const REVIEW_ID = '7000000000001';
const reviewCode = () => env('PLAY_REVIEW_CODE').trim();
export const reviewLoginEnabled = () => reviewCode().length >= 8;

export async function reviewLogin(code) {
  if (!reviewLoginEnabled()) throw new AppError(404, 'Sinov kirishi o‘chirilgan.');
  if (!safeEqual(sha256(String(code || '').replace(/\s/g, '')), sha256(reviewCode()))) throw new AppError(400, 'Kod noto‘g‘ri.');
  const db = await needDb();
  const r = db.collection('customers').doc(REVIEW_ID);
  if (!(await r.get()).exists) {
    await r.set({
      tgId: REVIEW_ID, firstName: 'Google', lastName: 'Play', username: '', name: 'SINOV — Google Play', phone: '+998000000000',
      role: 'customer', sessionVersion: 0, review: true, createdAt: new Date(), updatedAt: new Date(),
    });
  }
  return REVIEW_ID;
}
