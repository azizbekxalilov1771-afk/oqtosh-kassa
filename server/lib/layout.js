import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { str, text, url, image, list, bool, id } from './validate.js';

// Landing sahifadagi bo'limlar tartibi. Logo (birinchi qism) har doim tepada.
// builtin — tayyor bo'limlar; text / gallery / banner — admin ochadigan yangi bo'limlar.

export const BUILTIN = {
  news: 'Yangiliklar',
  about: 'Restoran haqida',
  contact: 'Bog‘lanish',
  locations: 'Manzillar',
};
export const CUSTOM_TYPES = ['text', 'gallery', 'banner'];

const defaults = () => Object.entries(BUILTIN).map(([key, title]) => ({ id: key, type: 'builtin', key, title, visible: true, nav: true }));

let mem = { data: null, until: 0 };
const ref = (db) => db.collection('settings').doc('layout');

// Saqlangan ro'yxatda bo'lmagan tayyor bo'limlar oxiriga qo'shiladi
function complete(sections) {
  const out = Array.isArray(sections) ? [...sections] : [];
  for (const d of defaults()) if (!out.some((s) => s.type === 'builtin' && s.key === d.key)) out.push(d);
  return out;
}

export async function getSections() {
  if (mem.data && Date.now() < mem.until) return mem.data;
  let stored = null;
  const db = await getDb();
  if (db) {
    try {
      const snap = await ref(db).get();
      stored = snap.exists ? snap.data().sections : null;
    } catch (e) {
      console.error('[layout] Firestore:', e.message);
    }
  }
  const sections = complete(stored);
  mem = { data: sections, until: Date.now() + 60_000 };
  return sections;
}

function sanitizeSection(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'builtin') {
    if (!BUILTIN[s.key]) return null;
    return { id: s.key, type: 'builtin', key: s.key, title: str(s.title, 60) || BUILTIN[s.key], visible: bool(s.visible, true), nav: bool(s.nav, true) };
  }
  if (!CUSTOM_TYPES.includes(s.type)) return null;
  const title = str(s.title, 80);
  if (!title) throw new AppError(400, 'Har bir yangi bo‘limga sarlavha yozing.');
  const base = {
    id: /^s_[a-z0-9]{4,12}$/.test(s.id) ? s.id : id('s'),
    type: s.type, title,
    visible: bool(s.visible, true), nav: bool(s.nav, false),
  };
  if (s.type === 'text') {
    return { ...base, text: text(s.text, 4000), image: image(s.image), imageSide: s.imageSide === 'left' ? 'left' : 'right',
      buttonLabel: str(s.buttonLabel, 40), buttonUrl: url(s.buttonUrl, { label: 'Tugma havolasi', tel: true }) };
  }
  if (s.type === 'gallery') {
    return { ...base, text: text(s.text, 600), images: list(s.images, 24, (img) => image(img) || null) };
  }
  return { ...base, text: text(s.text, 1000), buttonLabel: str(s.buttonLabel, 40), buttonUrl: url(s.buttonUrl, { label: 'Tugma havolasi', tel: true }) };
}

export async function saveSections(sections) {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  if (!Array.isArray(sections)) throw new AppError(400, 'Bo‘limlar ro‘yxati kerak.');
  if (sections.length > 40) throw new AppError(400, 'Bo‘limlar soni 40 tadan oshmasin.');
  const seen = new Set();
  const clean = complete(sections.map(sanitizeSection).filter((s) => s && !seen.has(s.id) && seen.add(s.id)));
  await ref(db).set({ sections: clean });
  mem = { data: null, until: 0 };
  return clean;
}
