import crypto from 'node:crypto';
import { pulse } from './pulse.js';
import { getDb } from './firebase.js';
import { safeEqual } from './crypto.js';
import { applyStopChange } from './menu.js';
import { applyMisonStatus, applyChequeEvent } from './orders.js';
import { archiveCheque } from './backup.js';
import { getConfig } from './config.js';
import { staleMisonLive } from './mison-live.js';

// Mison webhook'lari (https://api.mison.uz/webhooks): POST JSON, imzo — X-Mison-Signature: sha256=<HMAC-SHA256(xom tana, maxfiy kalit)>
// 5 soniyada 2xx kutiladi, aks holda Mison 1, 5, 30 daqiqa, 2 va 6 soatdan keyin qayta yuboradi.

export function verifyMisonSignature(raw, header, secret) {
  if (!secret || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return safeEqual(String(header).trim().toLowerCase(), expected);
}

export async function handleMisonEvent(evt) {
  const event = String(evt?.event || '');
  let result = { ignored: true };
  // Cheklar har doim arxivga (Misonsiz rejimda ham — tarix yo'qolmasin)
  if (event === 'cheque.closed' || event === 'cheque.deleted') await archiveCheque(event, evt.data).catch((e) => console.error('[mison] chek arxivi:', e.message));
  if ((await getConfig()).posMode === 'own') result = { ignored: 'misonsiz rejim' };
  else if (event === 'ping') result = {};
  else if (event === 'order.status_changed') result = await applyMisonStatus(evt.data);
  else if (event === 'stop_list.changed') result = await applyStopChange(evt.data);
  else if (event === 'cheque.closed' || event === 'cheque.deleted') result = await applyChequeEvent(evt.data);
  // kassa/ofitsiant stollar xaritasidagi Mison hisoblari keyingi yangilanishda darhol qayta olinadi
  if (/^(cheque|occupancy)\./.test(event)) await staleMisonLive().catch(() => {});
  // xodim sahifalari faqat buyurtma/chek/stol o'zgarishida yangilanadi (ombor, mehmon, bron xabarlari — yo'q)
  if (/^(order|cheque|occupancy)\./.test(event)) await pulse().catch(() => {});
  const db = await getDb();
  if (db) await db.collection('settings').doc('mison_webhook').set({ lastEvent: event.slice(0, 60), lastAtMs: Date.now() }, { merge: true }).catch(() => {});
  return { event, ...result };
}

// Rad etilgan so'rov — admin panelda ko'rinadi
export async function noteMisonReject(reason) {
  const db = await getDb();
  if (db) await db.collection('settings').doc('mison_webhook').set({ lastRejectAtMs: Date.now(), lastReject: String(reason).slice(0, 200) }, { merge: true }).catch(() => {});
}

export async function lastMisonEvent() {
  const db = await getDb();
  if (!db) return null;
  const snap = await db.collection('settings').doc('mison_webhook').get().catch(() => null);
  return snap?.exists ? snap.data() : null;
}
