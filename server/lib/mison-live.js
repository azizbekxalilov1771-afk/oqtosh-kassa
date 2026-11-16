import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { posConfigured, fetchOpenCheques } from './pos.js';

// Mison kassasida hozir ochiq cheklar (stollar bandligi va hisoblari) — kassa va ofitsiant stollar xaritasi uchun.
// Netlify kreditini tejash: Mison'dan ko'pi bilan daqiqada bir marta olinadi. Natija Firestore'da umumiy keshda
// (menu/mison_live) turadi — bir nechta qurilma va sayt nusxalari bitta javobdan foydalanadi.
// Kalitda "Доступ к отчётам" yo'q bo'lsa (403) — 10 daqiqada bir qayta tekshiriladi.

const TTL = 60_000;
const MEM_TTL = 20_000;
const BACKOFF = { ruxsat: 10 * 60_000, error: 2 * 60_000 };
let mem = null;
let inflight = null;
const ref = (db) => db.collection('menu').doc('mison_live');

const empty = { cheques: [], onlineEnabled: true, shiftOpen: true, lastSyncAt: '' };

async function refresh(cfg, db) {
  const now = Date.now();
  let data;
  try {
    data = { ...(await fetchOpenCheques(cfg)), error: '', atMs: now, nextMs: now + TTL };
  } catch (e) {
    const error = e.status === 403 || e.status === 402 ? 'ruxsat' : String(e.message || e).slice(0, 160);
    if (error !== 'ruxsat') console.warn('[mison] ochiq cheklar:', error);
    data = { ...empty, error, atMs: now, nextMs: now + (error === 'ruxsat' ? BACKOFF.ruxsat : BACKOFF.error) };
  }
  if (db) await ref(db).set(data).catch((e) => console.warn('[mison] ochiq cheklar keshlanmadi:', e.message));
  return data;
}

// → { cheques: [...], onlineEnabled, shiftOpen, lastSyncAt, error, atMs } yoki null (Mison ulanmagan / Misonsiz rejim)
export async function misonLive() {
  const cfg = await getConfig();
  if (!posConfigured(cfg)) return null;
  const now = Date.now();
  if (mem && now - mem.readMs < MEM_TTL && now < mem.data.nextMs) return mem.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const db = await getDb();
    let saved = null;
    if (db) {
      const snap = await ref(db).get().catch(() => null);
      saved = snap?.exists ? snap.data() : null;
    }
    const data = saved && Date.now() < (saved.nextMs || 0) ? saved : await refresh(cfg, db);
    mem = { data, readMs: Date.now() };
    return data;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Mison webhook: chek ochildi/yopildi/o'zgardi yoki stollar bandligi o'zgardi — keyingi so'rovda darhol yangilanadi
export async function staleMisonLive() {
  mem = null;
  const db = await getDb();
  if (db) await ref(db).set({ nextMs: 0 }, { merge: true }).catch(() => {});
}

// Mison kaliti yoki filial o'zgarganda — kesh tozalanadi (keyingi so'rovda darhol yangidan olinadi)
export async function resetMisonLive() {
  mem = null;
  const db = await getDb();
  if (db) await ref(db).delete().catch(() => {});
}

// Bizning sayt yuborgan buyurtmalar Mison'da external_id = buyurtma ID bilan turadi — ular stol hisobida allaqachon bor
export const ourExternalId = (v) => /^(?=.*[a-z])[a-z0-9]{9,20}$/.test(String(v || ''));
