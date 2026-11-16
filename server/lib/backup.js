import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { posConfigured, fetchPosRaw, listPoints, listPaymentTypes, resolvePointId } from './pos.js';
import { getMenu, clearMenuMemory } from './menu.js';
import { getTables } from './tables.js';
import { copyRemote, mediaIds, mediaIdForUrl } from './media.js';
import { getOwnMenu, getOwnTables } from './ownpos.js';

// Mison zaxirasi: Mison'dan kelayotgan hamma narsa bizning bazada turadi.
//   mison_backup/meta      — oxirgi nusxa: vaqt, sonlar, to'lov turlari, filiallar, xatolar
//   mison_backup_raw/menu_N — Mison menyusining xom javobi (JSON, bo'laklarda) — keyin kerak bo'lsa
//   menu/current, menu/stop, menu/tables — sayt ishlatadigan nusxalar (menu.js, tables.js saqlaydi)
//   media/*                — rasmlar nusxasi (media.js)
//   mison_cheques/*        — Mison webhook'idan kelgan yopilgan/o'chirilgan cheklar
// Netlify funksiyasi ~10 soniyada tugashi kerak, shuning uchun ish bo'lib-bo'lib bajariladi:
// har chaqiruvda nusxa (30 daqiqada bir) + vaqt yetguncha rasmlar. Admin sahifasi tugaguncha qayta chaqiradi.

const SNAPSHOT_EVERY = 30 * 60_000;
const RAW_CHUNK = 700_000;

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

const metaRef = (db) => db.collection('mison_backup').doc('meta');
const isUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

async function imageUrls(db) {
  const cur = await db.collection('menu').doc('current').get();
  const own = await getOwnMenu();
  const urls = new Set();
  for (const m of [cur.exists ? cur.data() : null, own]) {
    if (!m) continue;
    for (const i of m.items || []) if (isUrl(i.image)) urls.add(i.image);
    for (const u of Object.values(m.categoryImages || {})) if (isUrl(u)) urls.add(u);
  }
  return [...urls];
}

async function snapshot(db, cfg) {
  const raw = await fetchPosRaw(cfg);
  const json = JSON.stringify(raw);
  const chunks = Math.max(1, Math.ceil(json.length / RAW_CHUNK));
  for (let n = 0; n < chunks; n++) await db.collection('mison_backup_raw').doc(`menu_${n}`).set({ data: json.slice(n * RAW_CHUNK, (n + 1) * RAW_CHUNK), n, of: chunks, atMs: Date.now() });
  const menu = await getMenu({ force: true });
  const tables = await getTables({ force: true });
  const pointId = await resolvePointId(cfg).catch(() => '');
  const paymentTypes = await listPaymentTypes(cfg, pointId).catch(() => []);
  const points = await listPoints(cfg).catch(() => []);
  return {
    snapshotAtMs: Date.now(), pointId,
    items: menu.items.length, categories: menu.categories.length,
    halls: tables.halls.length, tables: tables.halls.reduce((s, h) => s + h.tables.length, 0),
    rawBytes: json.length, rawChunks: chunks,
    paymentTypes: (paymentTypes || []).slice(0, 30).map((t) => ({ id: t.id, name: t.name, category: t.category })),
    points: (points || []).slice(0, 20).map((p) => ({ id: p.id, name: p.name })),
  };
}

export async function runBackup({ budgetMs = 7000, force = false } = {}) {
  const t0 = Date.now();
  const db = await needDb();
  const cfg = await getConfig();
  const snap = await metaRef(db).get();
  let meta = snap.exists ? snap.data() : {};
  const errors = [];

  if (posConfigured(cfg) && (force || Date.now() - (meta.snapshotAtMs || 0) > SNAPSHOT_EVERY)) {
    try {
      meta = { ...meta, ...(await snapshot(db, cfg)), lastError: '' };
    } catch (e) {
      errors.push(`Mison: ${e.message}`);
      meta.lastError = e.message.slice(0, 300);
      meta.lastErrorAtMs = Date.now();
    }
  }

  // Rasmlar: 3 tadan parallel, vaqt tugaguncha. 3 marta ochilmagan rasm o'tkazib yuboriladi.
  const failed = { ...(meta.failedImages || {}) };
  const urls = await imageUrls(db);
  const ids = await mediaIds();
  const pending = urls.filter((u) => !ids.has(mediaIdForUrl(u)) && (failed[mediaIdForUrl(u)] || 0) < 3);
  let copied = 0;
  for (let i = 0; i < pending.length && Date.now() - t0 < budgetMs; i += 3) {
    await Promise.all(pending.slice(i, i + 3).map(async (u) => {
      try {
        const r = await copyRemote(u);
        if (!r.skipped) copied++;
        delete failed[mediaIdForUrl(u)];
      } catch (e) {
        failed[mediaIdForUrl(u)] = (failed[mediaIdForUrl(u)] || 0) + 1;
        if (failed[mediaIdForUrl(u)] >= 3) errors.push(`Rasm ochilmadi: ${u.slice(0, 120)} (${e.message})`);
      }
    }));
  }
  const now = await mediaIds();
  const stored = urls.filter((u) => now.has(mediaIdForUrl(u))).length;
  const skipped = urls.filter((u) => !now.has(mediaIdForUrl(u)) && (failed[mediaIdForUrl(u)] || 0) >= 3).length;
  if (copied) clearMenuMemory(); // menyu yangi nusxa rasmlari bilan qayta yig'ilsin
  meta = { ...meta, failedImages: failed, imagesTotal: urls.length, imagesStored: stored, imagesFailed: skipped, lastRunAtMs: Date.now() };
  await metaRef(db).set(meta);
  return { ...statusOf(meta, cfg), copied, remaining: urls.length - stored - skipped, errors };
}

function statusOf(meta, cfg) {
  return {
    mode: cfg.posMode === 'own' ? 'own' : 'mison',
    misonConnected: Boolean(cfg.misonApiKey),
    snapshotAt: meta.snapshotAtMs ? new Date(meta.snapshotAtMs).toISOString() : '',
    items: meta.items || 0, categories: meta.categories || 0, halls: meta.halls || 0, tables: meta.tables || 0,
    rawBytes: meta.rawBytes || 0,
    imagesTotal: meta.imagesTotal || 0, imagesStored: meta.imagesStored || 0, imagesFailed: meta.imagesFailed || 0,
    paymentTypes: meta.paymentTypes || [], points: meta.points || [],
    cheques: meta.cheques || 0, lastChequeAt: meta.lastChequeAtMs ? new Date(meta.lastChequeAtMs).toISOString() : '',
    lastError: meta.lastError || '', lastErrorAt: meta.lastErrorAtMs ? new Date(meta.lastErrorAtMs).toISOString() : '',
  };
}

export async function backupStatus() {
  const db = await needDb();
  const cfg = await getConfig();
  const snap = await metaRef(db).get();
  const meta = snap.exists ? snap.data() : {};
  const [own, ownTables] = await Promise.all([getOwnMenu(), getOwnTables()]);
  return {
    ...statusOf(meta, cfg),
    own: {
      items: own?.items?.length || 0, categories: own?.categories?.length || 0, updatedAt: own?.updatedAt || '', importedAt: own?.importedAt || '',
      tables: ownTables?.halls?.reduce((s, h) => s + h.tables.length, 0) || 0,
    },
  };
}

// Mison webhook'idan kelgan chek — arxivga (hisobotlar va Misonsiz kelajak uchun)
export async function archiveCheque(event, data) {
  const db = await getDb();
  if (!db || !data) return;
  const id = String(data.id ?? data.cheque_id ?? data.external_id ?? `${Date.now()}`).replace(/[^\w-]/g, '').slice(0, 60) || `${Date.now()}`;
  const ref = db.collection('mison_cheques').doc(id);
  const existed = (await ref.get()).exists;
  await ref.set({ event, data, atMs: Date.now() }, { merge: true });
  if (!existed) {
    const m = await metaRef(db).get();
    await metaRef(db).set({ cheques: (m.exists ? m.data().cheques || 0 : 0) + 1, lastChequeAtMs: Date.now() }, { merge: true });
  }
}
