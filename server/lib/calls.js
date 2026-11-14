import { AppError } from './env.js';
import { cached, ttlFor } from './pulse.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { sendMessage, loginBot, escapeHtml } from './telegram.js';
import { listStaff } from './customers.js';

// "Ofitsiantni chaqirish": mijoz stolidan bosadi → stol ofitsiantiga (hali yo'q bo'lsa — barcha ofitsiantlarga)
// Telegram xabari va ofitsiant sahifasida ovozli signal. Ofitsiant "Boraman" bosadi — mijoz buni ko'radi.
//   tabs/{id}.call = { kind: waiter|bill, atMs, ackAtMs, ackByName }

export const CALL_KINDS = { waiter: 'Ofitsiantni chaqiryapti', bill: 'Hisobni so‘rayapti' };
const LIVE_MS = 15 * 60_000;
const REPEAT_MS = 45_000;

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Ma’lumotlar bazasi ulanmagan.');
  return db;
}

export const callView = (c) => (c?.atMs && Date.now() - c.atMs < LIVE_MS
  ? { kind: c.kind, label: CALL_KINDS[c.kind] || CALL_KINDS.waiter, at: new Date(c.atMs).toISOString(), ack: Boolean(c.ackAtMs), ackByName: c.ackByName || '' }
  : null);

async function customerTab(db, customerId) {
  const st = await db.collection('table_state').where('customerId', '==', customerId).limit(1).get();
  if (st.empty) return null;
  const ref = db.collection('tabs').doc(st.docs[0].data().tabId);
  const snap = await ref.get();
  return snap.exists && snap.data().status === 'open' ? { ref, tab: snap.data() } : null;
}

async function notifyWaiters(tab, html) {
  const cfg = await getConfig();
  let ids = [];
  if (String(tab.waiterId || '').startsWith('tg:')) ids = [tab.waiterId.slice(3)];
  else {
    try {
      ids = (await listStaff()).filter((s) => s.role === 'waiter').map((s) => s.id);
    } catch (e) {
      return console.error('[calls] xodimlar:', e.message);
    }
  }
  await Promise.all(ids.map((id) => sendMessage(loginBot(cfg), id, html).catch((e) => console.error('[calls] Telegram:', e.message))));
}

export async function callWaiter(customer, kind) {
  const k = CALL_KINDS[kind] ? kind : 'waiter';
  const db = await needDb();
  const found = await customerTab(db, customer.id);
  if (!found) throw new AppError(409, 'Chaqiruv stol orqali ishlaydi — avval stolga buyurtma bering.');
  const { ref, tab } = found;
  const prev = tab.call;
  if (prev && !prev.ackAtMs && prev.kind === k && Date.now() - prev.atMs < REPEAT_MS) return { call: callView(prev), repeated: true };
  const call = { kind: k, atMs: Date.now(), ackAtMs: 0, ackByName: '' };
  await ref.update({ call, updatedAtMs: Date.now() });
  const label = (tab.tableLabels || []).join(' + ');
  await notifyWaiters(tab, `🔔 <b>${escapeHtml(label)}</b> — ${CALL_KINDS[k]}${tab.customerName ? ` (${escapeHtml(tab.customerName)})` : ''}`);
  return { call: callView(call) };
}

// Ofitsiant sahifasi uchun: javob berilmagan chaqiruvlar (o'z stollari + ofitsiantsiz stollar; kassir — hammasi)
export async function openCalls(actorId, { all = false, p = '' } = {}) {
  const rows = await cached(`open-tabs-calls|${p}`, ttlFor(p), async () => {
    const db = await needDb();
    const snap = await db.collection('tabs').where('status', '==', 'open').limit(200).get();
    return snap.docs.map((d) => ({ id: d.id, t: d.data() })).filter(({ t }) => t.call);
  });
  return rows
    .filter(({ t }) => t.call && !t.call.ackAtMs && Date.now() - t.call.atMs < LIVE_MS && (all || !t.waiterId || t.waiterId === actorId))
    .map(({ id, t }) => ({ tabId: id, tableLabel: (t.tableLabels || []).join(' + '), ...callView(t.call), mine: t.waiterId === actorId, waiterName: t.waiterName || '' }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function ackCall(tabId, actor) {
  if (!/^[a-z0-9]{9,20}$/.test(String(tabId || ''))) throw new AppError(404, 'Hisob topilmadi.');
  const db = await needDb();
  const ref = db.collection('tabs').doc(tabId);
  const snap = await ref.get();
  if (!snap.exists || !snap.data().call) throw new AppError(404, 'Chaqiruv topilmadi.');
  const t = snap.data();
  const call = { ...t.call, ackAtMs: Date.now(), ackByName: actor.name };
  // ofitsiantsiz stolga birinchi kelgan ofitsiant — shu stol ofitsianti
  await ref.update({ call, updatedAtMs: Date.now(), ...(!t.waiterId && !actor.cashier ? { waiterId: actor.id, waiterName: actor.name } : {}) });
  return { call: callView(call) };
}
