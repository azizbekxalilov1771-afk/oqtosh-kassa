import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { str } from './validate.js';

// O'z menyumiz va stollarimiz — "Misonsiz" rejim uchun. Mison'dagi nusxadan boshlanadi (ID'lar saqlanadi,
// shuning uchun eski QR stikerlar va buyurtmalar tarixi buzilmaydi), keyin admin paneldan tahrirlanadi.
//   own_menu/current — { items, categories, categoryImages, kind: 'own', updatedAt, importedAt }
//   own_menu/tables  — { halls: [{ id, name, tables: [{ id, name, capacity? }] }], updatedAt }

const MENU = ['own_menu', 'current'];
const TABLES = ['own_menu', 'tables'];
const MAX_DOC = 900_000;
let menuMem = null;
let tablesMem = null;

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

async function read([c, d]) {
  const db = await getDb();
  if (!db) return null;
  const snap = await db.collection(c).doc(d).get().catch(() => null);
  return snap?.exists ? snap.data() : null;
}

async function write([c, d], data) {
  const db = await needDb();
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > MAX_DOC) throw new AppError(413, `Menyu juda katta (${Math.round(size / 1000)} KB) — tavsiflarni qisqartiring.`);
  await db.collection(c).doc(d).set(data);
}

export async function getOwnMenu() {
  if (menuMem && Date.now() < menuMem.until) return menuMem.data;
  const data = await read(MENU);
  menuMem = { data, until: Date.now() + 30_000 };
  return data;
}

export async function getOwnTables() {
  if (tablesMem && Date.now() < tablesMem.until) return tablesMem.data;
  const data = await read(TABLES);
  tablesMem = { data, until: Date.now() + 30_000 };
  return data;
}

export function clearOwnMemory() {
  menuMem = null;
  tablesMem = null;
}

async function saveMenu(menu) {
  const data = { ...menu, kind: 'own', updatedAt: new Date().toISOString() };
  await write(MENU, data);
  menuMem = { data, until: Date.now() + 30_000 };
  return data;
}

/* ───────── Mison'dan nusxa olish ───────── */

export async function importFromMison({ menu = true, tables = true } = {}) {
  const db = await needDb();
  const out = {};
  if (menu) {
    const [cur, stop] = await Promise.all([db.collection('menu').doc('current').get(), db.collection('menu').doc('stop').get()]);
    if (!cur.exists || !cur.data().items?.length) throw new AppError(409, 'Mison menyusining nusxasi yo‘q. Avval “Hozir zaxiralash”ni bosing (Mison ulangan bo‘lsin).');
    const m = cur.data();
    const stopItems = stop.exists ? stop.data().items || {} : {};
    const items = m.items.map((i) => ({ ...i, available: stopItems[i.id] !== 0 && i.available !== false }));
    const saved = await saveMenu({ items, categories: m.categories || [], categoryImages: m.categoryImages || {}, importedAt: new Date().toISOString() });
    out.items = saved.items.length;
    out.categories = saved.categories.length;
  }
  if (tables) {
    const t = await db.collection('menu').doc('tables').get();
    if (!t.exists || !t.data().halls?.length) {
      if (!menu) throw new AppError(409, 'Mison stollarining nusxasi yo‘q.');
      out.tables = 0;
    } else {
      await saveTables(t.data().halls);
      out.tables = t.data().halls.reduce((s, h) => s + h.tables.length, 0);
    }
  }
  return out;
}

/* ───────── Menyu tahriri ───────── */

const money = (v) => {
  const n = Math.round(Number(String(v ?? '').replace(/\s/g, '')));
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new AppError(400, 'Narx noto‘g‘ri.');
  return n;
};
const imageOk = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\/api\/media\/([a-f0-9]{24}|[a-f0-9]{32})$/.test(s) || /^https:\/\/[^\s"'<>]+$/i.test(s)) return s.slice(0, 500);
  throw new AppError(400, 'Rasm manzili noto‘g‘ri.');
};

async function needMenu() {
  const m = await getOwnMenu();
  if (!m) throw new AppError(409, 'O‘z menyumiz hali yo‘q. Avval “Mison’dan nusxa olish”ni bosing yoki birinchi taomni qo‘shing.');
  return m;
}

export async function saveItem(id, body) {
  const m = (await getOwnMenu()) || { items: [], categories: [], categoryImages: {} };
  const name = str(body.name, 120);
  if (!name) throw new AppError(400, 'Taom nomini yozing.');
  const category = str(body.category, 60) || 'Boshqa';
  const patch = {
    name, category, price: money(body.price), description: str(body.description, 300), weight: str(body.weight, 30),
    image: imageOk(body.image), available: body.available !== false, perKg: Boolean(body.perKg),
  };
  if (!patch.weight) delete patch.weight;
  if (!patch.perKg) delete patch.perKg;
  let items = [...m.items];
  let item;
  if (!id || id === 'new') {
    item = { id: `o${crypto.randomInt(1e8, 1e9)}`, ...patch };
    items.push(item);
  } else {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw new AppError(404, 'Taom topilmadi.');
    item = { ...items[i], ...patch };
    if (!body.weight) delete item.weight;
    if (!body.perKg) delete item.perKg;
    items[i] = item;
  }
  const categories = m.categories.includes(category) ? m.categories : [...m.categories, category];
  items = sortByCategories(items, categories);
  await saveMenu({ ...m, items, categories });
  return item;
}

const sortByCategories = (items, categories) => {
  const pos = new Map(categories.map((c, i) => [c, i]));
  return items.map((x, i) => [x, i]).sort((a, b) => (pos.get(a[0].category) ?? 999) - (pos.get(b[0].category) ?? 999) || a[1] - b[1]).map(([x]) => x);
};

export async function deleteItem(id) {
  const m = await needMenu();
  const items = m.items.filter((x) => x.id !== id);
  if (items.length === m.items.length) throw new AppError(404, 'Taom topilmadi.');
  await saveMenu({ ...m, items });
  return { ok: true };
}

export async function setAvailable(id, available) {
  const m = await needMenu();
  const items = m.items.map((x) => (x.id === id ? { ...x, available: Boolean(available) } : x));
  await saveMenu({ ...m, items });
  return { ok: true };
}

// Bo'limlar: tartib, nomini o'zgartirish, rasm, bo'sh bo'limni o'chirish
export async function saveCategories({ order, rename, remove, image }) {
  const m = await needMenu();
  let { categories, items } = m;
  const categoryImages = { ...(m.categoryImages || {}) };
  if (rename?.from && rename?.to) {
    const to = str(rename.to, 60);
    if (!to) throw new AppError(400, 'Bo‘lim nomini yozing.');
    if (to !== rename.from && categories.includes(to)) throw new AppError(409, 'Bunday bo‘lim bor.');
    categories = categories.map((c) => (c === rename.from ? to : c));
    items = items.map((i) => (i.category === rename.from ? { ...i, category: to } : i));
    if (categoryImages[rename.from]) {
      categoryImages[to] = categoryImages[rename.from];
      delete categoryImages[rename.from];
    }
  }
  if (remove) {
    if (items.some((i) => i.category === remove)) throw new AppError(409, 'Bo‘limda taomlar bor — avval ularni o‘chiring yoki boshqa bo‘limga o‘tkazing.');
    categories = categories.filter((c) => c !== remove);
    delete categoryImages[remove];
  }
  if (image?.category) {
    const v = imageOk(image.url);
    if (v) categoryImages[image.category] = v;
    else delete categoryImages[image.category];
  }
  if (Array.isArray(order)) {
    const set = new Set(categories);
    const next = order.map((c) => String(c)).filter((c) => set.has(c));
    categories = [...next, ...categories.filter((c) => !next.includes(c))];
  }
  items = sortByCategories(items, categories);
  const saved = await saveMenu({ ...m, items, categories, categoryImages });
  return { categories: saved.categories };
}

/* ───────── Stollar ───────── */

export async function saveTables(halls) {
  if (!Array.isArray(halls) || !halls.length) throw new AppError(400, 'Kamida bitta zal bo‘lsin.');
  const seen = new Set();
  const clean = halls.slice(0, 20).map((h, hi) => {
    const name = str(h.name, 40) || `Zal ${hi + 1}`;
    const tables = (Array.isArray(h.tables) ? h.tables : []).slice(0, 200).map((t) => {
      const tname = str(t.name, 40);
      if (!tname) throw new AppError(400, `${name}: stol nomi bo‘sh.`);
      const id = /^[\w-]{1,40}$/.test(String(t.id || '')) ? String(t.id) : `t${crypto.randomInt(1e7, 1e8)}`;
      if (seen.has(id)) throw new AppError(400, 'Stol ID takrorlangan.');
      seen.add(id);
      return { id, name: tname, ...(Number(t.capacity) > 0 ? { capacity: Math.min(99, Math.round(Number(t.capacity))) } : {}) };
    });
    return { id: /^[\w-]{1,40}$/.test(String(h.id || '')) ? String(h.id) : `h${crypto.randomInt(1e6, 1e7)}`, name, tables };
  });
  const data = { halls: clean, updatedAt: new Date().toISOString() };
  await write(TABLES, data);
  tablesMem = { data, until: Date.now() + 30_000 };
  return data;
}
