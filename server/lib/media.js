import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';

// Rasmlar Firestore "media" kolleksiyasida (Firebase Storage pullik Blaze tarifini talab qiladi).
// Ikki xil yozuv:
//   1) Admin yuklagan rasm (yangiliklar, menyu): media/{32 hex} — { data: Buffer, type, size } (≤ 900 KB,
//      brauzer yuklashdan oldin kichraytiradi). SVG qabul qilinmaydi — ichida skript bo'lishi mumkin.
//   2) Mison rasmlarining nusxasi: media/{24 hex} — { type, size, chunks, url } + media_chunks/{id}_{n} —
//      katta rasm bo'laklarga bo'linadi (Firestore hujjati ≤ 1 MB). media_index/main — nusxalar ro'yxati.
// Ko'rsatish: GET /api/media/{id} — CDN bir yilga keshlaydi.

const CHUNK = 700_000; // base64 belgi
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const idOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
export const mediaIdForUrl = (url) => idOf(`url:${url}`);
export const mediaPath = (id) => `/api/media/${id}`;

let indexMem = { ids: null, until: 0 };

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

export async function mediaIds() {
  if (indexMem.ids && Date.now() < indexMem.until) return indexMem.ids;
  const db = await getDb();
  if (!db) return new Set();
  const snap = await db.collection('media_index').doc('main').get().catch(() => null);
  const ids = new Set(snap?.exists ? snap.data().ids || [] : []);
  indexMem = { ids, until: Date.now() + 5 * 60_000 };
  return ids;
}

async function addToIndex(db, id) {
  const ids = await mediaIds();
  if (ids.has(id)) return;
  ids.add(id);
  await db.collection('media_index').doc('main').set({ ids: [...ids], atMs: Date.now() });
}

function sniffType(buf, declared) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(4, 12).toString().includes('ftypavif')) return 'image/avif';
  return TYPES.has(declared) ? declared : '';
}

export async function storeMedia(id, buf, { type = '', url = '' } = {}) {
  const t = sniffType(buf, type);
  if (!t) throw new AppError(400, 'Rasm emas (JPEG, PNG yoki WEBP kerak).');
  if (buf.length > MAX_BYTES) throw new AppError(413, 'Rasm 4 MB dan katta.');
  const db = await needDb();
  const b64 = buf.toString('base64');
  const chunks = Math.ceil(b64.length / CHUNK) || 1;
  for (let n = 0; n < chunks; n++) await db.collection('media_chunks').doc(`${id}_${n}`).set({ data: b64.slice(n * CHUNK, (n + 1) * CHUNK) });
  await db.collection('media').doc(id).set({ type: t, size: buf.length, chunks, url: url.slice(0, 500), atMs: Date.now() });
  await addToIndex(db, id);
  return { id, path: mediaPath(id), type: t, size: buf.length };
}

const UPLOAD_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'image/gif': (b) => b.subarray(0, 4).toString() === 'GIF8',
};

// Admin yuklagan rasm (yangiliklar, restoran, menyu)
export async function saveImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new AppError(400, 'Faqat JPG, PNG, WEBP yoki GIF rasm yuklang.');
  const [, type, b64] = m;
  const buf = Buffer.from(b64, 'base64');
  if (!UPLOAD_TYPES[type](buf)) throw new AppError(400, 'Fayl rasm emas yoki turi mos kelmaydi.');
  if (buf.length > 900_000) throw new AppError(413, 'Rasm 900 KB dan katta.');
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  const id = crypto.randomBytes(16).toString('hex');
  await db.collection('media').doc(id).set({ data: buf, type, size: buf.length, createdAt: new Date() });
  return { id, url: `/api/media/${id}` };
}

// Tashqi (Mison) rasmni nusxalash
export async function copyRemote(url, { timeout = 8000 } = {}) {
  const id = mediaIdForUrl(url);
  if ((await mediaIds()).has(id)) return { id, skipped: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return await storeMedia(id, buf, { type: (res.headers.get('content-type') || '').split(';')[0], url });
  } finally {
    clearTimeout(t);
  }
}

export async function readMedia(id) {
  if (!/^[a-f0-9]{24}$|^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  const db = await getDb();
  if (!db) return null;
  const meta = await db.collection('media').doc(id).get();
  if (!meta.exists) return null;
  const { type, chunks, data } = meta.data();
  if (data) return { type, body: Buffer.isBuffer(data) ? data : Buffer.from(data?.toUint8Array?.() || data || []) };
  const parts = await Promise.all(Array.from({ length: chunks }, (_, n) => db.collection('media_chunks').doc(`${id}_${n}`).get()));
  if (parts.some((p) => !p.exists)) return null;
  return { type, body: Buffer.from(parts.map((p) => p.data().data).join(''), 'base64') };
}

const SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
export async function serveMedia(id) {
  const m = await readMedia(id);
  if (!m) return new Response('Topilmadi', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  return new Response(m.body, {
    status: 200,
    headers: {
      'Content-Type': SAFE_TYPES.has(m.type) ? m.type : 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(m.body.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Netlify-CDN-Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// Menyudagi tashqi rasm manzillarini o'zimizdagi nusxaga almashtirish (nusxa bo'lsa)
export async function withLocalImages(menu) {
  const ids = await mediaIds();
  if (!ids.size) return menu;
  const local = (url) => {
    if (!url || url.startsWith('/api/media/')) return url;
    const id = mediaIdForUrl(url);
    return ids.has(id) ? mediaPath(id) : url;
  };
  return {
    ...menu,
    items: menu.items.map((i) => (i.image ? { ...i, image: local(i.image) } : i)),
    categoryImages: Object.fromEntries(Object.entries(menu.categoryImages || {}).map(([k, v]) => [k, local(v)])),
  };
}

export async function mediaStats() {
  const ids = await mediaIds();
  return { stored: ids.size };
}

export function clearMediaMemory() {
  indexMem = { ids: null, until: 0 };
}
