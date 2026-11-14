import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { getRestaurantInfo } from './info.js';
import { str, text, image, bool } from './validate.js';

// Yangiliklar: Firestore "news" kolleksiyasi (admin panel) → bo'lmasa lib/restaurant.js dagi news.

let mem = { data: null, until: 0 };

function toIsoDate(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return '';
}

const view = (n, id) => ({
  id: id || '',
  title: String(n.title || '').slice(0, 140),
  text: String(n.text || '').slice(0, 4000),
  date: toIsoDate(n.date),
  image: typeof n.image === 'string' ? n.image : '',
  published: n.published !== false,
});

async function readAll(db) {
  const snap = await db.collection('news').orderBy('date', 'desc').limit(100).get();
  return snap.docs.map((d) => view(d.data(), d.id));
}

export async function getNews() {
  if (mem.data && Date.now() < mem.until) return mem.data;
  let items = null;
  const db = await getDb();
  if (db) {
    try {
      const all = await readAll(db);
      if (all.length) items = all.filter((n) => n.published && n.title);
    } catch (e) {
      console.error('[news] Firestore:', e.message);
    }
  }
  if (!items) {
    const info = await getRestaurantInfo();
    items = (info.news || []).filter((n) => n?.title).map((n, i) => view(n, `local-${i}`));
  }
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  mem = { data: items.slice(0, 12), until: Date.now() + 60_000 };
  return mem.data;
}

/* ───────── Admin ───────── */
async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

function sanitize(b) {
  const title = str(b?.title, 140);
  if (!title) throw new AppError(400, 'Sarlavhani yozing.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b?.date || '') ? b.date : new Date().toISOString().slice(0, 10);
  return { title, text: text(b?.text, 4000), date, image: image(b?.image), published: bool(b?.published, true) };
}

export async function listNewsAdmin() {
  return readAll(await needDb());
}

export async function createNews(body) {
  const db = await needDb();
  const doc = { ...sanitize(body), createdAt: new Date() };
  const ref = await db.collection('news').add(doc);
  mem = { data: null, until: 0 };
  return view(doc, ref.id);
}

export async function updateNews(id, body) {
  const db = await needDb();
  const ref = db.collection('news').doc(id);
  if (!(await ref.get()).exists) throw new AppError(404, 'Yangilik topilmadi.');
  const doc = { ...sanitize(body), updatedAt: new Date() };
  await ref.set(doc, { merge: true });
  mem = { data: null, until: 0 };
  return view(doc, id);
}

export async function deleteNews(id) {
  const db = await needDb();
  await db.collection('news').doc(id).delete();
  mem = { data: null, until: 0 };
}
