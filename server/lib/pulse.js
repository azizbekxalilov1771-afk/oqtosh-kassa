import { getRing, ringRaw } from './doorbell.js';
import { getDb } from './firebase.js';

// "Yurak urishi" — buyurtma, stol hisobi, chaqiruv yoki chek o'zgarganda Firebase Realtime Database'dagi
// bitta raqam (rings/<kanal>s) yangilanadi. Kassa, ofitsiant va kuryer sahifalari unga ulanib turadi (SSE) va
// faqat o'zgarish bo'lganda serverdan yangi ma'lumot so'raydi. Shunday qilib:
//   • Firestore o'qishlari (bepul limit — kuniga 50 000) o'nlab barobar kamayadi;
//   • Netlify so'rovlari (kreditlar) ham kamayadi;
//   • yangi buyurtma ekranda 1–2 soniyada paydo bo'ladi (12 soniya kutmasdan).
// Kanalda hech qanday ma'lumot yo'q — faqat vaqt. Printer qo'ng'irog'idan alohida kanal: printer har o'zgarishda uyg'onmaydi.

const SUFFIX = 's';

// Sahifalar ulanadigan manzil (null — Realtime Database yoqilmagan, sahifa oddiy tekshiruvda qoladi)
export async function pulseInfo() {
  const r = await getRing();
  return r.url && r.channel ? { url: `${r.url}/rings/${r.channel}${SUFFIX}.json` } : null;
}

// Server ichidagi qisqa kesh uchun: shu nusxada oxirgi o'zgarish vaqti
let localAt = 0;
export const localPulseAt = () => localAt;

// Shu nusxadagi qisqa keshni eskirgan deb belgilash (admin sozlamani o'zgartirdi va h.k.)
export function invalidateLocal() {
  localAt = Date.now();
}

// Realtime Database o'chiq bo'lsa ham kesh to'g'ri ishlashi uchun: o'zgarish vaqti Firestore'dagi bitta
// hujjatda ham turadi (settings/live_pulse). Sahifa p yubormasa — server shu hujjatni (3 soniya xotirada) o'qiydi:
// o'zgarish bo'lmagan so'rov = 1 ta o'qish (oldin — yuzlab).
let fsMem = { at: 0, v: '' };
export async function serverPulseKey() {
  if (Date.now() - fsMem.at < 3000) return fsMem.v;
  const db = await getDb();
  if (!db) return '';
  const snap = await db.collection('settings').doc('live_pulse').get().catch(() => null);
  fsMem = { at: Date.now(), v: String(snap?.data()?.at || '') };
  return fsMem.v;
}

export async function pulse() {
  localAt = Date.now();
  fsMem = { at: Date.now(), v: String(localAt) };
  const db = await getDb();
  if (db) await db.collection('settings').doc('live_pulse').set({ at: localAt }).catch((e) => console.error('[pulse]', e.message));
  const r = await getRing();
  if (!r.url || !r.channel) return false;
  try {
    await ringRaw(r.url, `rings/${r.channel}${SUFFIX}`, localAt);
    return true;
  } catch (e) {
    console.error('[pulse]', e.message);
    return false;
  }
}

// Kesh muddati: sahifa "yurak urishi" qiymatini (p) yuborsa — ma'lumot shu qiymat o'zgarmaguncha to'g'ri
// (har o'zgarishda yangi p keladi), shuning uchun uzoqroq; p yo'q bo'lsa (Realtime Database o'chiq) — bir necha soniya.
export const ttlFor = (p, long = 120_000, short = 5000) => (p ? long : short);

// Qisqa kesh: bir vaqtda bir nechta qurilma bir xil narsani so'rasa — Firestore bir marta o'qiladi.
// Kalitga sahifa ko'rgan "yurak urishi" qiymati (p) qo'shiladi: o'zgarishdan keyin birinchi so'rov yangisini oladi.
const store = new Map();
export async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < ttlMs && hit.at >= localAt) return hit.promise;
  const promise = Promise.resolve().then(fn);
  store.set(key, { at: now, promise });
  promise.catch(() => store.delete(key));
  if (store.size > 300) for (const [k, v] of store) if (now - v.at > 60_000) store.delete(k);
  return promise;
}
