import { envBool, AppError } from './env.js';
import { getDb } from './firebase.js';
import { defaultRestaurant } from './restaurant.js';
import { demoRestaurant } from './demo.js';
import { str, text, url, image, list, num } from './validate.js';

// Restoran ma'lumoti: lib/restaurant.js (boshlang'ich) + Firestore settings/restaurant (admin panel).
let mem = { data: null, until: 0 };
const ref = (db) => db.collection('settings').doc('restaurant');

async function readStored() {
  const db = await getDb();
  if (!db) return null;
  try {
    const snap = await ref(db).get();
    return snap.exists ? snap.data() : null;
  } catch (e) {
    console.error('[info] Firestore:', e.message);
    return null;
  }
}

// Admin panelda saqlangan qiymat (bo'sh bo'lsa ham) ustun — admin maydonni tozalashi mumkin
function merge(base, stored) {
  const out = { ...base };
  for (const [k, v] of Object.entries(stored || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export async function getRestaurantInfo() {
  if (mem.data && Date.now() < mem.until) return mem.data;
  const base = { ...defaultRestaurant, ...(envBool('DEMO_MODE') ? demoRestaurant : {}) };
  const info = merge(base, await readStored());
  mem = { data: info, until: Date.now() + 60_000 };
  return info;
}

// Admin uchun: demo qiymatlarsiz, aynan saqlangan holat
export async function getRestaurantForAdmin() {
  return { ...defaultRestaurant, ...((await readStored()) || {}) };
}

export function sanitizeRestaurant(b) {
  const name = str(b.name, 80);
  if (!name) throw new AppError(400, 'Restoran nomini kiriting.');
  return {
    name,
    tagline: str(b.tagline, 200),
    logo: image(b.logo, 'Logo'),
    orderLabel: str(b.orderLabel, 40),
    orderingEnabled: typeof b.orderingEnabled === 'boolean' ? b.orderingEnabled : true,
    orderingNote: text(b.orderingNote, 300),
    orderUrl: url(b.orderUrl, { label: 'Buyurtma havolasi' }),
    about: text(b.about, 3000),
    phone: str(b.phone, 30),
    phone2: str(b.phone2, 30),
    telegram: str(b.telegram, 100),
    instagram: str(b.instagram, 100),
    hours: list(b.hours, 10, (h) => (h && (str(h.days, 60) || str(h.time, 60)) ? { days: str(h.days, 60), time: str(h.time, 60) } : null)),
    delivery: text(b.delivery, 600),
    payment: str(b.payment, 300),
    features: list(b.features, 20, (f) => str(f, 40) || null),
    banquet: text(b.banquet, 600),
    locations: list(b.locations, 20, (l) => {
      if (!l || !(str(l.address, 200) || str(l.name, 80))) return null;
      return {
        name: str(l.name, 80), address: str(l.address, 200), landmark: str(l.landmark, 150),
        phone: str(l.phone, 30), hours: str(l.hours, 80),
        lat: num(l.lat, -90, 90), lng: num(l.lng, -180, 180),
      };
    }),
    faq: list(b.faq, 30, (f) => (f && str(f.q, 200) && text(f.a, 1000) ? { q: str(f.q, 200), a: text(f.a, 1000) } : null)),
  };
}

export async function saveRestaurantInfo(body) {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  const clean = sanitizeRestaurant(body || {});
  await ref(db).set(clean, { merge: true });
  mem = { data: null, until: 0 };
  return clean;
}
