import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { posConfigured, resolvePointId, listTables, tableKey } from './pos.js';
import { getOwnTables } from './ownpos.js';

// Mison POS'dagi zallar va stollar (GET /reservations/halls). Kalitda stollar (bron) ruxsati bo'lishi kerak.
// Mison tavsiyasi: taxminan soatiga bir yangilash. Firestore'da umumiy kesh (menu/tables), xotirada 10 daqiqa.
const TTL = 60 * 60_000;
const MEM_TTL = 10 * 60_000;
let mem = null;
const ref = (db) => db.collection('menu').doc('tables');

function group(flat) {
  const halls = [];
  const byKey = new Map();
  for (const t of flat) {
    const key = `${t.hallId}|${t.hall}`;
    if (!byKey.has(key)) {
      const h = { id: String(t.hallId ?? ''), name: t.hall || 'Zal', tables: [] };
      byKey.set(key, h);
      halls.push(h);
    }
    byKey.get(key).tables.push({ id: String(t.id), name: t.name.slice(0, 40), ...(Number(t.capacity) > 0 ? { capacity: Number(t.capacity) } : {}) });
  }
  return halls;
}

export async function getTables({ force = false } = {}) {
  if (!force && mem && Date.now() - mem.checkedMs < MEM_TTL) return mem;
  const cfg = await getConfig();
  // Misonsiz rejim: o'z stollarimiz
  if (cfg.posMode === 'own') {
    const own = await getOwnTables();
    if (own?.halls?.length) return (mem = { halls: own.halls, pointId: '', atMs: Date.parse(own.updatedAt) || 0, error: '', own: true, checkedMs: Date.now() });
  }
  const db = await getDb();
  let saved = null;
  if (db) {
    const snap = await ref(db).get().catch(() => null);
    saved = snap?.exists ? snap.data() : null;
  }
  // Mison ulanmagan (yoki Misonsiz rejim, lekin o'z stollar hali yo'q) — oxirgi saqlangan ro'yxat
  if (!posConfigured(cfg)) return saved?.halls?.length ? (mem = { ...saved, error: '', checkedMs: Date.now() }) : { halls: [], error: '' };
  const fresh = !force && saved && Date.now() - saved.atMs < TTL && (!cfg.misonPointId || saved.pointId === cfg.misonPointId);
  if (fresh) return (mem = { ...saved, checkedMs: Date.now() });
  try {
    const pointId = await resolvePointId(cfg);
    const data = { halls: group(await listTables(cfg, pointId)), pointId, atMs: Date.now(), error: '' };
    if (db) await ref(db).set(data).catch((e) => console.warn('[tables] keshlanmadi:', e.message));
    return (mem = { ...data, checkedMs: Date.now() });
  } catch (e) {
    const error = e.status === 403 ? 'ruxsat' : e.message;
    if (e.status !== 403) console.warn('[tables]', e.message);
    // Xato bo'lsa — eski ro'yxat; qayta urinish 1 daqiqadan keyin
    const data = saved?.halls?.length ? { ...saved, error } : { halls: [], pointId: '', atMs: 0, error };
    mem = { ...data, checkedMs: Date.now() - MEM_TTL + 60_000 };
    return data;
  }
}

export const hasTables = (t) => t.halls.some((h) => h.tables.length);
export function clearTablesMemory() {
  mem = null;
}

// Saytda ko'rinadigan nom: "Stol 5" (nom faqat raqam bo'lsa), aks holda Mison'dagidek; zal bir nechta bo'lsa — zal bilan
export function tableLabel(halls, hall, table) {
  const name = /^\d+$/.test(table.name) ? `Stol ${table.name}` : table.name;
  return halls.length > 1 && hall.name ? `${hall.name} · ${name}` : name;
}

// ID yoki nom bo'yicha (eski "?stol=5" stikerlar uchun — nom aniq bitta stolga mos kelsa)
export function findTable(t, { id, name } = {}) {
  for (const h of t.halls) for (const x of h.tables) if (id !== undefined && id !== null && id !== '' && x.id === String(id)) return { hall: h, table: x };
  if (name) {
    const want = tableKey(name);
    const hits = t.halls.flatMap((h) => h.tables.filter((x) => tableKey(x.name) === want).map((x) => ({ hall: h, table: x })));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

export const publicTables = (t) => ({
  halls: t.halls.map((h) => ({ id: h.id, name: h.name, tables: h.tables.map((x) => ({ ...x, label: tableLabel(t.halls, h, x) })) })),
});
