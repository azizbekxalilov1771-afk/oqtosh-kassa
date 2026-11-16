import { getDb } from './firebase.js';

// Kichik sozlama hujjatlari (settings/<name>) — xotirada 60 soniya keshlanadi
const mem = new Map();
export async function readSetting(name, fallback = {}) {
  const m = mem.get(name);
  if (m && Date.now() - m.at < 60_000) return m.value;
  const db = await getDb();
  let value = fallback;
  if (db) {
    const snap = await db.collection('settings').doc(name).get().catch(() => null);
    if (snap?.exists) value = { ...fallback, ...snap.data() };
  }
  mem.set(name, { value, at: Date.now() });
  return value;
}
export async function writeSetting(name, value) {
  const db = await getDb();
  if (!db) throw Object.assign(new Error('Firebase ulanmagan.'), { status: 503, expose: true });
  await db.collection('settings').doc(name).set(value);
  mem.set(name, { value, at: Date.now() });
  return value;
}
