import crypto from 'node:crypto';
import { env, AppError } from './env.js';
import { normalizedPrivateKey } from './firebase.js';

// Admin paneldan kiritilgan maxfiy kalitlar (Groq, Telegram, Mison) Firestore'ga AES-256-GCM bilan
// shifrlangan holda yoziladi. Shifr kaliti: SECRETS_KEY yoki u bo'lmasa Firebase private key'dan olinadi —
// ikkala saytda ham bir xil bo'lgani uchun admin shifrlagan kalitni ommaviy sayt o'qiy oladi.
// Firebase kaliti yoki SECRETS_KEY almashtirilsa, kalitlarni admin panelda qayta kiritish kerak.

function key() {
  const source = env('SECRETS_KEY') || normalizedPrivateKey();
  if (!source) return null;
  return crypto.createHash('sha256').update(`oqtosh-secrets:v1:${source}`).digest();
}

export function encrypt(text) {
  const k = key();
  if (!k) throw new AppError(503, 'Shifrlash kaliti yo‘q: FIREBASE_PRIVATE_KEY yoki SECRETS_KEY sozlanmagan.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

// Maqsadga bog'langan HMAC kaliti (sessiya, webhook va h.k. uchun alohida)
function subkey(purpose) {
  const k = key();
  if (!k) throw new AppError(503, 'Maxfiy kalit yo‘q: FIREBASE_PRIVATE_KEY yoki SECRETS_KEY sozlanmagan.');
  return crypto.createHmac('sha256', k).update(`purpose:${purpose}`).digest();
}

// Zaxira nusxalarini shifrlash kaliti (server kompyuteri rejimi) — o'sha kalitlarsiz ochib bo'lmaydi
export const backupKey = () => subkey('backup:v1');

// Qidirish uchun maxfiy iz (masalan, xodim PIN'i) — kalitsiz tiklab bo'lmaydi
export const hmacHex = (purpose, data) => crypto.createHmac('sha256', subkey(purpose)).update(String(data)).digest('hex');

export const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const randomDigits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Imzolangan token: base64url(JSON).imzo — mijoz sessiyasi uchun
export function signToken(payload, purpose = 'session') {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', subkey(purpose)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token, purpose = 'session') {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  let expected;
  try {
    expected = crypto.createHmac('sha256', subkey(purpose)).update(body).digest('base64url');
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function decrypt(box) {
  const k = key();
  if (!k || !box || box.v !== 1) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // kalit almashgan — admin panelda "qayta kiriting" deb ko'rsatiladi
  }
}
