import crypto from 'node:crypto';
import { env, AppError } from './env.js';
import { getFirebaseApp, localMode } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { livePut } from './live.js';

// "Qo'ng'iroq" — Firebase Realtime Database'dagi bitta raqam (rings/<maxfiy kanal>).
// Yangi chek paydo bo'lganda server shu raqamni o'zgartiradi; printer dasturi va kassa sahifasi unga
// doimiy ulanib turadi (SSE) va darhol cheklarni oladi. Shunday qilib Netlify'ga har necha soniyada
// so'rov yuborish shart emas — Netlify kreditlari tejaladi, chek esa 1 soniyada chiqadi.
// Kanalda hech qanday ma'lumot yo'q (faqat vaqt) — chek matni baribir serverdan, kalit bilan olinadi.
//   settings/ring: { url, channel, okAtMs, error }

// Server kompyuteri rejimida qo'ng'iroq shu serverning o'zida (lib/live.js) — har doim yoqiq, manzil nisbiy:
// sahifalar o'z saytiga, printer dasturi o'z manziliga qo'shib ulanadi.
export const LOCAL_RING = '/live';
async function localRing() {
  const r = await readSetting('ring', { url: '', channel: '', okAtMs: 0, error: '' });
  if (!/^[a-f0-9]{40}$/.test(r.channel || '')) {
    r.channel = crypto.randomBytes(20).toString('hex');
    await writeSetting('ring', { ...r, url: '', error: '' });
  }
  return { url: LOCAL_RING, channel: r.channel, okAtMs: Date.now(), error: '', local: true };
}
export const getRing = () => (localMode() ? localRing() : readSetting('ring', { url: '', channel: '', okAtMs: 0, error: '' }));

const URL_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/;
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
const okUrl = (u) => URL_RE.test(u) || (env('RTDB_TEST_URL') && u === cleanUrl(env('RTDB_TEST_URL')));

// Firebase loyihasining odatiy Realtime Database manzillari (qaysi mintaqada yaratilganiga qarab)
export function ringCandidates() {
  const test = cleanUrl(env('RTDB_TEST_URL'));
  if (test) return [test];
  const p = env('FIREBASE_PROJECT_ID').toLowerCase();
  if (!p) return [];
  return [
    `https://${p}-default-rtdb.firebaseio.com`,
    `https://${p}-default-rtdb.europe-west1.firebasedatabase.app`,
    `https://${p}-default-rtdb.asia-southeast1.firebasedatabase.app`,
    `https://${p}.firebaseio.com`,
  ];
}

// Xizmat hisobi (service account) tokeni — firebase-admin o'zi oladi, ~1 soat amal qiladi
let tokenCache = { value: '', until: 0 };
let tokenProvider = null; // faqat testlar uchun
export function __setTokenProvider(fn) {
  tokenProvider = fn;
  tokenCache = { value: '', until: 0 };
}
async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.until) return tokenCache.value;
  let t;
  if (tokenProvider) t = { access_token: await tokenProvider(), expires_in: 3600 };
  else {
    const app = await getFirebaseApp();
    if (!app?.options?.credential?.getAccessToken) throw new AppError(503, 'Firebase ulanmagan.');
    t = await app.options.credential.getAccessToken();
  }
  tokenCache = { value: t.access_token, until: Date.now() + Math.max(60, (t.expires_in || 3600) - 300) * 1000 };
  return tokenCache.value;
}

async function rtdb(url, path, { method = 'PUT', body, timeoutMs = 4000 } = {}) {
  if (url === LOCAL_RING) {
    if (/^rings\/[a-z0-9]+$/.test(path)) livePut(path, body);
    return '';
  }
  const res = await fetch(`${url}/${path}.json`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      msg = JSON.parse(text).error || msg;
    } catch {}
    throw Object.assign(new Error(`${res.status}: ${msg}`), { status: res.status });
  }
  return text;
}

// Faqat rings/<kanal> o'qiladi (kanal nomini bilgan qurilma), qolgan hammasi yopiq. Yozish — faqat server.
const RULES = { rules: { '.read': false, '.write': false, rings: { $ch: { '.read': '$ch.length >= 32' } } } };

// Admin: "Qo'ng'iroqni yoqish". Baza yaratilgan bo'lsa — qoidalarni o'zi yozadi va sinab ko'radi.
export async function setupRing(customUrl = '') {
  if (localMode()) return { ok: true, url: (await localRing()).url };
  const current = await getRing();
  const list = customUrl ? [cleanUrl(customUrl)] : [...new Set([current.url, ...ringCandidates()].filter(Boolean))];
  if (customUrl && !okUrl(list[0])) throw new AppError(400, 'Manzil https://…firebaseio.com yoki https://…firebasedatabase.app ko‘rinishida bo‘lishi kerak.');
  const channel = /^[a-f0-9]{40}$/.test(current.channel) ? current.channel : crypto.randomBytes(20).toString('hex');
  const errors = [];
  for (const url of list) {
    try {
      await rtdb(url, '.settings/rules', { body: RULES });
      await rtdb(url, `rings/${channel}`, { body: Date.now() });
      const next = { url, channel, okAtMs: Date.now(), error: '' };
      await writeSetting('ring', next);
      return { ok: true, url };
    } catch (e) {
      errors.push(`${url.replace(/^https:\/\//, '')} — ${e.status === 404 || /404|not found|ensure that you spelled/i.test(e.message) ? 'baza yo‘q' : e.message}`);
    }
  }
  await writeSetting('ring', { ...current, channel, error: errors.join('; ').slice(0, 500) });
  throw new AppError(409, 'Realtime Database topilmadi yoki ruxsat yo‘q. Firebase konsolida “Realtime Database” → “Create database” ni bosing (Locked mode), keyin shu tugmani yana bosing.');
}

export async function disableRing() {
  const current = await getRing();
  await writeSetting('ring', { ...current, url: '', okAtMs: 0, error: '' });
  return { ok: true };
}

// Printer dasturi va kassa sahifasi ulanadigan manzil (null — qo'ng'iroq yoqilmagan)
export async function ringInfo() {
  const r = await getRing();
  return r.url && r.channel ? { url: `${r.url}/rings/${r.channel}.json` } : null;
}

// Boshqa kanalga yozish (yurak urishi — lib/pulse.js)
export const ringRaw = (url, path, value) => rtdb(url, path, { body: value, timeoutMs: 2500 });

// Yangi chek → qo'ng'iroq. Xato bo'lsa ham chek navbatda qoladi (printer keyingi tekshiruvda oladi).
export async function ring() {
  const r = await getRing();
  if (!r.url || !r.channel) return false;
  try {
    await rtdb(r.url, `rings/${r.channel}`, { body: Date.now(), timeoutMs: 2500 });
    return true;
  } catch (e) {
    console.error('[ring]', e.message);
    return false;
  }
}

export async function ringStatus() {
  const r = await getRing();
  return { on: Boolean(r.url), url: r.url, okAt: r.okAtMs ? new Date(r.okAtMs).toISOString() : '', error: r.error || '', candidates: ringCandidates() };
}
