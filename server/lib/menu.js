import { envBool } from './env.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { posConfigured, fetchPosRaw, fetchStopList, normalizeMenu, applyStopList, resolvePointId } from './pos.js';
import { demoMenu } from './demo.js';
import { getMenuConfig, applyMenuConfig } from './menuconfig.js';
import { getOwnMenu } from './ownpos.js';
import { withLocalImages } from './media.js';

// Tartib: xotira → Firestore (yangi bo'lsa) → Mison POS → Firestore (eski nusxa) → demo.
// Firestore serverless funksiyalar orasida umumiy kesh, POS ishlamay qolsa ham menyu ko'rinadi.
// Mison tavsiyasi: menyu — taxminan soatiga bir, stop-list — 1–2 daqiqada bir. Shuning uchun stop-list
// alohida keshlanadi (menu/stop) va saqlangan menyu ustiga qo'yiladi; Mison webhook'i uni darhol yangilaydi.

const STOP_TTL = 2 * 60_000;
let mem = { data: null, until: 0 };
let stopMem = null;
const ref = (db) => db.collection('menu').doc('current');
const stopRef = (db) => db.collection('menu').doc('stop');

async function readDoc(get) {
  const db = await getDb();
  if (!db) return null;
  try {
    const snap = await get(db).get();
    return snap.exists ? snap.data() : null;
  } catch (e) {
    console.error('[menu] Firestore o‘qishda xato:', e.message);
    return null;
  }
}

async function writeDoc(get, data) {
  const db = await getDb();
  if (!db) return;
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > 900_000) return console.warn(`[menu] ${size} bayt — Firestore hujjat chegarasidan katta, keshlanmadi`);
  try {
    await get(db).set(data);
  } catch (e) {
    console.error('[menu] Firestore yozishda xato:', e.message);
  }
}

async function saveStop(stop) {
  stopMem = stop;
  await writeDoc(stopRef, stop);
}

// Yangi stop-list: xotira → Firestore → Mison. Mison javob bermasa — oxirgi ma'lum holat.
async function currentStop(cfg) {
  const fresh = (s) => s && Date.now() - s.atMs < STOP_TTL && (!cfg.misonPointId || !s.pointId || s.pointId === cfg.misonPointId);
  if (fresh(stopMem)) return stopMem;
  const saved = await readDoc(stopRef);
  if (fresh(saved)) return (stopMem = saved);
  try {
    const { pointId, items } = await fetchStopList(cfg);
    const stop = { pointId, items, atMs: Date.now() };
    await saveStop(stop);
    return stop;
  } catch (e) {
    console.warn('[menu] stop-list:', e.message);
    return saved || stopMem;
  }
}

const pack = (r) => ({ items: r.items, categories: r.categories, categoryImages: r.categoryImages || {}, kind: r.kind || '', updatedAt: r.updatedAt });

export async function getMenu({ force = false } = {}) {
  if (!force && mem.data && Date.now() < mem.until) return mem.data;
  const cfg = await getConfig();
  const ttl = (Number(cfg.menuCacheMinutes) || 30) * 60_000;
  let result = null;
  let posError = '';

  // Misonsiz rejim: o'z menyumiz (yo'q bo'lsa — Mison'ning oxirgi nusxasi)
  if (cfg.posMode === 'own') {
    const own = await getOwnMenu();
    if (own?.items?.length) result = { ...own, source: 'own' };
  }

  const cached = force || result ? null : await readDoc(ref);
  if (cached?.updatedAt && Date.now() - Date.parse(cached.updatedAt) < ttl) result = { ...cached, source: 'cache' };

  if (!result && posConfigured(cfg)) {
    try {
      const raw = await fetchPosRaw(cfg);
      const menu = normalizeMenu(raw, cfg);
      if (!menu.items.length) throw new Error('POS javobidan taom topilmadi — admin paneldagi "Tekshirish" bilan javob tuzilmasini ko‘ring');
      result = { ...menu, updatedAt: new Date().toISOString(), source: 'pos' };
      await writeDoc(ref, pack(result));
      if (Array.isArray(raw.stop_list)) {
        const items = Object.fromEntries(raw.stop_list.filter((x) => x && Number.isFinite(Number(x.quantity))).map((x) => [String(x.product_id), Number(x.quantity)]));
        await saveStop({ pointId: raw.point_id || '', items, atMs: Date.now() });
      }
    } catch (e) {
      posError = e.message;
      console.error('[menu]', e.message);
    }
  }

  const fallback = cached || (force || cfg.posMode === 'own' ? await readDoc(ref) : null);
  if (!result && fallback?.items?.length) result = { ...fallback, source: 'cache', stale: true };

  // Keshdan olingan Mison menyusiga eng yangi stop-list
  if (result && result.source === 'cache' && result.kind === 'mison' && posConfigured(cfg)) {
    const stop = await currentStop(cfg);
    if (stop?.items) result = { ...result, items: applyStopList(result.items, stop.items), stopAt: new Date(stop.atMs).toISOString() };
  }

  if (!result && envBool('DEMO_MODE')) result = { ...demoMenu, updatedAt: new Date().toISOString(), source: 'demo' };
  if (!result) result = { items: [], categories: [], updatedAt: null, source: 'none' };

  // Muvaffaqiyatsiz holatda POS'ni har so'rovda urmaslik uchun qisqa kesh
  // 1 daqiqa: admin "Menyuni yangilash" bossa, ommaviy sayt ham tez orada yangisini ko'radi
  // Og'irlik bo'yicha sotiladigan taomlar (admin panel → Menyu)
  if (result.items.length) result = { ...result, items: applyMenuConfig(result.items, await getMenuConfig()) };
  // Rasmlar: o'zimizdagi nusxa bo'lsa — o'shandan (Mison o'chsa ham ko'rinadi)
  if (result.items.length) result = await withLocalImages(result).catch(() => result);
  mem = { data: result, until: Date.now() + 60_000 };
  return posError ? { ...result, posError } : result;
}

// Mison webhook "stop_list.changed": faqat o'zgargan taomlar keladi
export async function applyStopChange(data) {
  const cfg = await getConfig();
  if (!posConfigured(cfg)) return { ignored: 'mison ulanmagan' };
  const pointId = await resolvePointId(cfg).catch(() => '');
  if (data?.point_id && pointId && String(data.point_id) !== pointId) return { ignored: 'boshqa filial' };
  const base = stopMem || (await readDoc(stopRef)) || { items: {} };
  const items = { ...(base.items || {}) };
  let changed = 0;
  for (const it of data?.items || []) {
    if (!it || it.product_id === undefined || it.product_id === null) continue;
    const id = String(it.product_id);
    const q = it.quantity === null || it.quantity === undefined ? null : Number(it.quantity);
    if (it.is_available === false || q === 0) items[id] = 0;
    else if (q > 0) items[id] = q;
    else delete items[id];
    changed++;
  }
  await saveStop({ pointId: pointId || String(data?.point_id || ''), items, atMs: Date.now() });
  clearMenuMemory();
  return { changed };
}

export function clearMenuMemory() {
  mem = { data: null, until: 0 };
}

export function clearStopMemory() {
  stopMem = null;
}
