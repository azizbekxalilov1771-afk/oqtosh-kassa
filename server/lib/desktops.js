import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';

// Oqtosh Kassa dasturi (Setup.exe) o'rnatilgan kompyuterlar va ularni masofadan o'chirish / qayta yoqish.
// Har bir dastur o'zi uchun tasodifiy id + maxfiy kalit yaratadi va har 10 soniyada /api/desktop/ping qiladi.
// Admin panel → Qurilmalar → "Kompyuterlar": "O'chirish" bosilsa, buyruq shu hujjatga yoziladi va 3 daqiqa kutadi —
// kompyuter shu vaqt ichida olmasa, eskiradi (ertasi kuni yoqilganda o'zi o'chib qolmaydi).
//   desktops/{id}: { secretHash, name, version, main, server, os, ip, lastSeenMs, createdAtMs,
//                    command: { id, action: shutdown|restart|cancel, byName, atMs, expiresAtMs, delaySec, doneAtMs, result, error } }

const ID_RE = /^[a-f0-9]{32}$/;
const SECRET_RE = /^[a-f0-9]{64}$/;
const ONLINE_MS = 70_000;
const COMMAND_TTL = 3 * 60_000;
const ACTIONS = ['shutdown', 'restart', 'cancel'];
export const DELAYS = [5, 10, 30, 60]; // ekrandagi ogohlantirish, soniya (admin tanlaydi)
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v, n) => String(v ?? '').trim().slice(0, n);

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Ma’lumotlar bazasi ulanmagan.');
  return db;
}
const coll = (db) => db.collection('desktops');

async function own(db, body) {
  const id = String(body?.id || '');
  const secret = String(body?.secret || '');
  if (!ID_RE.test(id) || !SECRET_RE.test(secret)) throw new AppError(400, 'Kompyuter kaliti noto‘g‘ri.');
  const ref = coll(db).doc(id);
  const snap = await ref.get();
  if (snap.exists && snap.data().secretHash !== sha(secret)) throw new AppError(403, 'Kompyuter kaliti mos emas.');
  return { id, ref, snap, secret };
}

// Kompyuter → server (har 10 soniyada). Javob: bajarilmagan va eskirmagan buyruq (bo'lsa)
export async function desktopPing(body, ip = '') {
  const db = await needDb();
  const { ref, snap, secret } = await own(db, body);
  const now = Date.now();
  const info = {
    name: str(body.name, 60) || 'Kompyuter', version: str(body.version, 20), main: Boolean(body.main), server: Boolean(body.server),
    os: str(body.os, 60), ip: str(ip, 60), lastSeenMs: now,
  };
  if (!snap.exists) {
    await ref.set({ ...info, secretHash: sha(secret), createdAtMs: now });
    return { ok: true };
  }
  await ref.update(info);
  const c = snap.data().command;
  if (c && !c.doneAtMs && c.expiresAtMs > now) return { ok: true, command: { id: c.id, action: c.action, byName: c.byName || '', delaySec: c.delaySec || 10 } };
  return { ok: true };
}

// Kompyuter buyruqni oldi: started | cancelled | refused | error
export async function desktopAck(body) {
  const db = await needDb();
  const { ref, snap } = await own(db, body);
  if (!snap.exists) throw new AppError(404, 'Kompyuter topilmadi.');
  const c = snap.data().command;
  if (!c || c.id !== String(body.commandId || '')) return { ok: true };
  await ref.update({ command: { ...c, doneAtMs: Date.now(), result: str(body.result, 20), error: str(body.error, 200) } });
  return { ok: true };
}

const view = (id, d, now = Date.now()) => {
  const c = d.command || null;
  const pending = Boolean(c && !c.doneAtMs && c.expiresAtMs > now);
  return {
    id, name: d.name || 'Kompyuter', version: d.version || '', main: Boolean(d.main), server: Boolean(d.server), os: d.os || '',
    online: now - (d.lastSeenMs || 0) < ONLINE_MS, lastSeenAt: d.lastSeenMs ? new Date(d.lastSeenMs).toISOString() : null,
    command: c ? { action: c.action, byName: c.byName || '', at: new Date(c.atMs).toISOString(), pending, expired: !c.doneAtMs && c.expiresAtMs <= now, result: c.result || '', error: c.error || '' } : null,
  };
};

export async function listDesktops() {
  const db = await needDb();
  const snap = await coll(db).get();
  const now = Date.now();
  return snap.docs.map((d) => view(d.id, d.data(), now))
    .sort((a, b) => Number(b.online) - Number(a.online) || Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
}

// Admin: ids — bitta yoki bir nechta kompyuter; server kompyuteri va oflayn kompyuterlar o'tkazib yuboriladi
export async function commandDesktops(ids, action, byName, delaySec = 10) {
  const delay = DELAYS.includes(Number(delaySec)) ? Number(delaySec) : 10;
  if (!ACTIONS.includes(action)) throw new AppError(400, 'Buyruq noto‘g‘ri.');
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))].filter((x) => ID_RE.test(x)).slice(0, 100);
  if (!list.length) throw new AppError(400, 'Kompyuter tanlanmagan.');
  const db = await needDb();
  const now = Date.now();
  const sent = [];
  const skipped = [];
  for (const id of list) {
    const ref = coll(db).doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const d = snap.data();
    if (action !== 'cancel' && d.server) {
      skipped.push({ id, name: d.name, reason: 'server kompyuteri' });
      continue;
    }
    if (now - (d.lastSeenMs || 0) >= ONLINE_MS) {
      skipped.push({ id, name: d.name, reason: 'oflayn' });
      continue;
    }
    await ref.update({ command: { id: crypto.randomBytes(8).toString('hex'), action, byName: str(byName, 60), atMs: now, expiresAtMs: now + COMMAND_TTL, delaySec: delay, doneAtMs: 0, result: '', error: '' } });
    sent.push({ id, name: d.name });
  }
  return { sent, skipped };
}

export async function deleteDesktop(id) {
  if (!ID_RE.test(String(id))) throw new AppError(400, 'Kompyuter topilmadi.');
  const db = await needDb();
  await coll(db).doc(String(id)).delete();
  return { ok: true };
}
