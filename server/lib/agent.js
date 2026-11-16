import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb, localMode } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { safeEqual } from './crypto.js';
import { str } from './validate.js';
import { ring, ringInfo } from './doorbell.js';
import { getConfig } from './config.js';
import { sendOrdersChat, escapeHtml } from './telegram.js';
import { billTicket, ascii } from './escpos.js';
import { billFmt } from './receipt-settings.js';
import { env } from './env.js';

// Printer dasturi (kassa kompyuterida ishlaydigan kichik Windows dasturi).
// Brauzer Wi‑Fi tarmoqni ko'ra olmaydi va printerga to'g'ridan-to'g'ri yoza olmaydi — shuning uchun
// tarmoqdagi chek printerlarini shu dastur qidiradi (9100-port), ro'yxatini saytga yuboradi va
// oshxona/kassa cheklarini printerlarga chiqaradi.
//   settings/agent        { keyHash, keyHint, createdAtMs }      — faqat admin yozadi
//   agent_status/main     { host, user, version, ips, subnets, lastSeenMs, helloAtMs, scanAskMs, scanAtMs }
//   printers/{id}         { type: net|win, ip, port, mac, model, winName, winPort, driver, winHost, label, paper, lastSeenMs, ... }
//   agent_jobs/{id}       { printerId, kind, title, station, data(base64 ESC/POS), copies, status, tries, ... }

const ONLINE_MS = 5 * 60_000;
const PRINTER_SEEN_MS = 75 * 60_000;
const KITCHEN_TTL = 20 * 60_000;
const BILL_TTL = 30 * 60_000;
const MAX_TRIES = 4;
const POLL = { ring: 120, active: 15, idle: 60 }; // soniya

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const getAgentKey = () => readSetting('agent', { keyHash: '', keyHint: '', createdAtMs: 0 });

/* ───────── Kalit ───────── */

// Yangi kalit: eski fayl ishlashdan to'xtaydi (faqat eng oxirgi yuklangan fayl ishlaydi)
export async function newAgentKey() {
  const key = `oqa_${crypto.randomBytes(24).toString('base64url')}`;
  await writeSetting('agent', { keyHash: sha(key), keyHint: key.slice(4, 10), createdAtMs: Date.now() });
  return key;
}

// Kompyuter dasturi (Oqtosh Kassa) uchun ulash kodi: admin panelda ko'rsatiladi, dasturda kiritiladi (10 daqiqa, bir marta)
const PAIR_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function newPairCode() {
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes].map((b) => PAIR_ALPHA[b % PAIR_ALPHA.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expiresAtMs = Date.now() + 10 * 60_000;
  await writeSetting('agent_pair', { codeHash: sha(raw), expiresAtMs, tries: 0 });
  return { code, expiresAt: new Date(expiresAtMs).toISOString() };
}

export async function pairWithCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = await readSetting('agent_pair', { codeHash: '', expiresAtMs: 0, tries: 0 });
  if (!p.codeHash || Date.now() > p.expiresAtMs) throw new AppError(410, 'Kod eskirgan. Admin panel → Tayyorlash joylari → “Kompyuter dasturini ulash”ni qayta bosing.');
  if ((p.tries || 0) >= 5) throw new AppError(429, 'Ko‘p noto‘g‘ri urinish. Yangi kod oling.');
  if (raw.length !== 8 || !safeEqual(sha(raw), p.codeHash)) {
    await writeSetting('agent_pair', { ...p, tries: (p.tries || 0) + 1 });
    throw new AppError(403, 'Kod noto‘g‘ri.');
  }
  await writeSetting('agent_pair', { codeHash: '', expiresAtMs: 0, tries: 0 });
  return { key: await newAgentKey() };
}

export async function revokeAgent() {
  await writeSetting('agent', { keyHash: '', keyHint: '', createdAtMs: 0 });
  return { ok: true };
}

export async function requireAgent(request) {
  const key = String(request.headers.get('x-oq-agent') || '');
  const a = await getAgentKey();
  if (!key || !a.keyHash || !safeEqual(sha(key), a.keyHash)) throw new AppError(401, 'Printer dasturi kaliti eskirgan. Admin panel → Tayyorlash joylari → dasturni qayta yuklab oling.');
  return a;
}

/* ───────── Holat ───────── */

const statusRef = (db) => db.collection('agent_status').doc('main');
async function readStatus(db) {
  const s = await statusRef(db).get();
  return s.exists ? s.data() : {};
}

const printerId = (p) => (p.type === 'win'
  ? `win-${crypto.createHash('sha1').update(String(p.name).toLowerCase()).digest('hex').slice(0, 12)}`
  : p.mac ? `net-${p.mac}` : `ip-${String(p.ip).replace(/\./g, '-')}${Number(p.port) && Number(p.port) !== 9100 ? `-${Number(p.port)}` : ''}`);

const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const cleanMac = (m) => {
  const v = String(m || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return v.length === 12 && v !== '000000000000' && v !== 'FFFFFFFFFFFF' ? v : '';
};
const portOf = (p) => {
  const n = Math.round(Number(p) || 9100);
  return n > 0 && n < 65536 ? n : 9100;
};

export function printerView(id, p, now = Date.now()) {
  const auto = p.type === 'win'
    ? `${p.winName}${p.winHost ? ` (${p.winHost})` : ''}`
    : `${p.model ? `${p.model.slice(0, 40)} · ` : ''}${p.ip}${p.port && p.port !== 9100 ? `:${p.port}` : ''}`;
  return {
    id, type: p.type, label: p.label || '', name: p.label || auto, auto,
    ip: p.ip || '', port: p.port || 9100, mac: p.mac || '', model: p.model || '', winName: p.winName || '', driver: p.driver || '', winHost: p.winHost || '',
    paper: p.paper === 58 ? 58 : 80, manual: Boolean(p.manual),
    found: now - (p.lastSeenMs || 0) < PRINTER_SEEN_MS, lastSeenAt: p.lastSeenMs ? new Date(p.lastSeenMs).toISOString() : '',
    lastPrintAt: p.lastPrintMs ? new Date(p.lastPrintMs).toISOString() : '',
    lastError: p.lastErrorMs > (p.lastPrintMs || 0) ? p.lastError || '' : '', lastErrorAt: p.lastErrorMs ? new Date(p.lastErrorMs).toISOString() : '',
  };
}

// Windows PowerShell ba'zan ro'yxatni {"value":[...],"Count":n} ko'rinishida yuboradi; bitta qiymat — ro'yxatsiz
const list = (v) => (Array.isArray(v) ? v : Array.isArray(v?.value) ? v.value : v && typeof v === 'object' ? [v] : typeof v === 'string' && v ? [v] : []);

// Dastur salomi: kompyuter haqida ma'lumot va topilgan printerlar ro'yxati
export async function agentHello(body) {
  const db = await needDb();
  const now = Date.now();
  const status = {
    host: str(body?.host, 60), user: str(body?.user, 60), version: str(body?.version, 20),
    ips: list(body?.ips).map(String).filter((ip) => IP_RE.test(ip)).slice(0, 8),
    subnets: list(body?.subnets).map(String).filter((s) => /^\d+\.\d+\.\d+$/.test(s)).slice(0, 8),
    lastSeenMs: now, helloAtMs: now, winRaw: body?.winRaw !== false,
  };
  if (body?.scanned) status.scanAtMs = now;
  await statusRef(db).set(status, { merge: true });

  if (body?.scanned) {
    const col = db.collection('printers');
    const existing = new Map((await col.limit(200).get()).docs.map((d) => [d.id, d.data()]));
    const own = new Set(status.ips);
    for (const raw of list(body.printers).slice(0, 60)) {
      let p;
      if (raw?.type === 'win') {
        const name = str(raw.name, 120);
        if (!name) continue;
        const host = IP_RE.test(String(raw.host || '')) ? String(raw.host) : '';
        p = { type: 'win', winName: name, winPort: str(raw.port, 80), driver: str(raw.driver, 120), winHost: host, offline: Boolean(raw.offline) };
      } else {
        const ip = String(raw?.ip || '');
        if (!IP_RE.test(ip) || own.has(ip)) continue;
        p = { type: 'net', ip, port: portOf(raw.port), mac: cleanMac(raw.mac), model: str(raw.model, 120) };
      }
      const id = printerId({ ...p, name: p.winName });
      const old = existing.get(id);
      // avval MAC'siz (faqat IP bilan) yozilgan bo'lsa — nom va sozlamalari yangi yozuvga o'tadi
      let carry = {};
      if (!old && p.type === 'net' && p.mac) {
        const legacyId = printerId({ type: 'net', ip: p.ip, port: p.port });
        const legacy = existing.get(legacyId);
        if (legacy && !legacy.mac) {
          carry = { label: legacy.label || '', paper: legacy.paper || 80, manual: Boolean(legacy.manual) };
          await col.doc(legacyId).delete().catch(() => {});
          await movePrinterRefs(legacyId, id);
        }
      }
      await col.doc(id).set({ ...carry, ...p, lastSeenMs: now, ...(old ? {} : { foundAtMs: now }) }, { merge: true });
    }
  }
  return agentReply(db, await readStatus(db));
}

async function agentReply(db, status) {
  const r = await ringInfo();
  const known = (await db.collection('printers').limit(200).get()).docs.map((d) => d.data()).filter((p) => p.type === 'net');
  return {
    ok: true,
    ring: r ? r.url : '',
    poll: r ? POLL.ring : POLL.active,
    idlePoll: r ? POLL.ring : POLL.idle,
    scan: (status.scanAskMs || 0) > (status.scanAtMs || 0),
    probe: known.map((p) => ({ ip: p.ip, port: p.port || 9100 })).slice(0, 40),
    // server kompyuterida printer dasturi serverga to'g'ridan-to'g'ri (127.0.0.1) ulanadi — internet manziliga o'tkazilmaydi
    ...(!localMode() && /^https:\/\//.test(env('PUBLIC_SITE_URL')) ? { site: env('PUBLIC_SITE_URL').replace(/\/+$/, '') } : {}),
  };
}

export async function agentStatus() {
  const db = await needDb();
  const [key, s] = await Promise.all([getAgentKey(), readStatus(db)]);
  const now = Date.now();
  return {
    installed: Boolean(key.keyHash), keyHint: key.keyHint || '', keyAt: key.createdAtMs ? new Date(key.createdAtMs).toISOString() : '',
    online: Boolean(key.keyHash) && now - (s.lastSeenMs || 0) < ONLINE_MS && (s.lastSeenMs || 0) > (key.createdAtMs || 0),
    lastSeenAt: s.lastSeenMs ? new Date(s.lastSeenMs).toISOString() : '', host: s.host || '', version: s.version || '',
    ips: s.ips || [], subnets: s.subnets || [], winRaw: s.winRaw !== false,
    scanning: (s.scanAskMs || 0) > (s.scanAtMs || 0) && now - s.scanAskMs < 5 * 60_000,
    scanAt: s.scanAtMs ? new Date(s.scanAtMs).toISOString() : '',
  };
}

export async function askScan() {
  const db = await needDb();
  await statusRef(db).set({ scanAskMs: Date.now() }, { merge: true });
  await ring();
  return agentStatus();
}

/* ───────── Printerlar (admin) ───────── */

export async function listPrinters() {
  const db = await needDb();
  const snap = await db.collection('printers').limit(200).get();
  const now = Date.now();
  return snap.docs.map((d) => printerView(d.id, d.data(), now))
    .sort((a, b) => Number(b.found) - Number(a.found) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export async function getPrinter(id) {
  if (!id) return null;
  const db = await needDb();
  const snap = await db.collection('printers').doc(String(id)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function addManualPrinter(body) {
  const ip = String(body?.ip || '').trim();
  if (!IP_RE.test(ip)) throw new AppError(400, 'IP manzil noto‘g‘ri. Masalan: 192.168.1.100');
  const port = portOf(body?.port);
  const db = await needDb();
  const id = printerId({ type: 'net', ip, port });
  await db.collection('printers').doc(id).set({ type: 'net', ip, port, mac: '', model: '', manual: true, label: str(body?.label, 40), paper: Number(body?.paper) === 58 ? 58 : 80, foundAtMs: Date.now() }, { merge: true });
  await statusRef(db).set({ scanAskMs: Date.now() }, { merge: true });
  await ring();
  return { id };
}

export async function updatePrinter(id, body) {
  const db = await needDb();
  const ref = db.collection('printers').doc(String(id || ''));
  if (!(await ref.get()).exists) throw new AppError(404, 'Printer topilmadi.');
  const patch = {};
  if (body?.label !== undefined) patch.label = str(body.label, 40);
  if (body?.paper !== undefined) {
    if (![58, 80].includes(Number(body.paper))) throw new AppError(400, 'Qog‘oz eni 80 yoki 58 mm.');
    patch.paper = Number(body.paper);
  }
  await ref.update(patch);
  return { ok: true };
}

// Sozlamalardagi (tayyorlash joylari, kassa printeri) eski ID'ni yangisiga almashtirish
let refMover = async () => {};
export function onPrinterMoved(fn) {
  refMover = fn;
}
async function movePrinterRefs(from, to) {
  await refMover(from, to).catch((e) => console.error('[agent] printer ko‘chirish:', e.message));
}

export async function deletePrinter(id) {
  const db = await needDb();
  await db.collection('printers').doc(String(id || '')).delete();
  await movePrinterRefs(String(id || ''), '');
  return { ok: true };
}

/* ───────── Cheklar navbati ───────── */

// Printerga chek: data — ESC/POS baytlari (base64). Dasturga qo'ng'iroq qilinadi.
export async function queueAgentJob({ printerId: pid, kind, title, station = '', data, copies = 1, orderId = '', tabId = '', byName = '' }, { doRing = true } = {}) {
  const db = await needDb();
  const now = Date.now();
  const job = {
    printerId: pid, kind, title: str(title, 80), station: str(station, 40), data, copies: Math.min(5, Math.max(1, Math.round(copies) || 1)),
    status: 'new', tries: 0, orderId, tabId, byName: str(byName, 60), createdAtMs: now,
    expiresAtMs: now + (kind === 'kitchen' ? KITCHEN_TTL : BILL_TTL),
  };
  const ref = await db.collection('agent_jobs').add(job);
  if (doRing) await ring();
  return ref.id;
}

export const ringNow = ring;

export async function agentOnline() {
  const db = await needDb();
  const [key, s] = await Promise.all([getAgentKey(), readStatus(db)]);
  return Boolean(key.keyHash) && Date.now() - (s.lastSeenMs || 0) < ONLINE_MS;
}

// Dastur: navbatdagi cheklar (printer manzili har safar yangidan — IP o'zgargan bo'lsa ham to'g'ri boradi)
export async function agentJobs() {
  const db = await needDb();
  const now = Date.now();
  const status = await readStatus(db);
  if (now - (status.lastSeenMs || 0) > 60_000) await statusRef(db).set({ lastSeenMs: now }, { merge: true });
  const snap = await db.collection('agent_jobs').where('status', '==', 'new').limit(40).get();
  const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((j) => j.expiresAtMs > now && !(j.retryAfterMs > now))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const printers = new Map();
  const out = [];
  for (const j of jobs) {
    if (!printers.has(j.printerId)) printers.set(j.printerId, await getPrinter(j.printerId));
    const p = printers.get(j.printerId);
    if (!p) {
      await db.collection('agent_jobs').doc(j.id).update({ status: 'error', error: 'printer o‘chirilgan', doneAtMs: now }).catch(() => {});
      continue;
    }
    out.push({
      id: j.id, title: ascii(j.title || ''), copies: j.copies || 1, data: j.data,
      printer: p.type === 'win' ? { type: 'win', name: p.winName } : { type: 'net', ip: p.ip, port: p.port || 9100, mac: p.mac || '' },
    });
  }
  return { ...(await agentReply(db, status)), jobs: out };
}

export async function agentFinish(jobId, body) {
  const db = await needDb();
  const ref = db.collection('agent_jobs').doc(String(jobId || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new AppError(404, 'Chek topilmadi.');
  const j = snap.data();
  const now = Date.now();
  const pref = db.collection('printers').doc(j.printerId);
  if (body?.status === 'done') {
    await ref.update({ status: 'done', doneAtMs: now, error: '' });
    await pref.set({ lastPrintMs: now }, { merge: true }).catch(() => {});
    return { ok: true };
  }
  const error = str(body?.error, 200) || 'printer javob bermadi';
  const tries = (j.tries || 0) + 1;
  const final = body?.status === 'error' || tries >= MAX_TRIES || j.expiresAtMs <= now;
  await ref.update(final ? { status: 'error', error, tries, doneAtMs: now } : { tries, error, retryAfterMs: now + 20_000 });
  await pref.set({ lastError: error, lastErrorMs: now }, { merge: true }).catch(() => {});
  if (final) await alertFailed(j, error);
  return { ok: true, final };
}

// Chek chiqmadi — buyurtmalar guruhiga ogohlantirish (oshxona buyurtmani bilmay qolmasin)
async function alertFailed(j, error) {
  try {
    const cfg = await getConfig();
    const p = await getPrinter(j.printerId);
    const name = p ? printerView(p.id, p).name : 'printer';
    await sendOrdersChat(cfg, `⚠️ <b>Chek chiqmadi</b>${j.station ? ` — ${escapeHtml(j.station)}` : ''}\n${escapeHtml(j.title || '')}\nPrinter: ${escapeHtml(name)}\nSabab: ${escapeHtml(error)}\n\nPrinter yoqilganini va qog‘oz borligini tekshiring.`);
  } catch (e) {
    console.error('[agent] ogohlantirish:', e.message);
  }
}

export async function recentAgentJobs(limit = 20) {
  const db = await needDb();
  const snap = await db.collection('agent_jobs').orderBy('createdAtMs', 'desc').limit(80).get();
  const now = Date.now();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // 3 kundan eski cheklarni tozalash
  await Promise.all(all.filter((j) => now - j.createdAtMs > 3 * 86_400_000).slice(0, 40).map((j) => db.collection('agent_jobs').doc(j.id).delete().catch(() => {})));
  return all.filter((j) => now - j.createdAtMs <= 3 * 86_400_000).slice(0, limit).map((j) => ({
    id: j.id, kind: j.kind, title: j.title || '', station: j.station || '', printerId: j.printerId, byName: j.byName || '',
    createdAt: new Date(j.createdAtMs).toISOString(),
    status: j.status === 'new' && j.expiresAtMs <= now ? 'expired' : j.status === 'new' && j.tries ? 'retry' : j.status,
    error: j.error || '', tries: j.tries || 0,
  }));
}

/* ───────── Kassa cheklari printer dasturi orqali ───────── */

const widthOf = (p) => (p?.paper === 58 ? 32 : 48);

export async function queueBill(printer, kind, data, { brand, footer, byName = '', number = '' }) {
  const title = kind === 'test' ? 'Sinov cheki' : kind === 'order' ? `Buyurtma #${data.number}` : kind === 'paidorder' ? `To‘lov · yetkazish #${data.number}`
    : kind === 'shift' ? `${data.status === 'closed' ? 'Z' : 'X'}-hisobot · smena #${data.number}` : `${kind === 'paid' ? 'To‘lov' : 'Hisob'} · ${data.tableLabel || ''}`;
  const id = await queueAgentJob({
    printerId: printer.id, kind, title, station: 'Kassa', byName, tabId: data?.id && (kind === 'tab' || kind === 'paid') ? data.id : '',
    data: billTicket({ kind, data, brand, footer, width: widthOf(printer), number, byName, fmt: await billFmt() }),
  });
  return { id, station: { name: printerView(printer.id, printer).name, online: await agentOnline() } };
}

export async function testPrinter(id, { brand, footer, station = '' } = {}) {
  const p = await getPrinter(id);
  if (!p) throw new AppError(404, 'Printer topilmadi.');
  const v = printerView(p.id, p);
  const r = await queueBill(p, 'test', { printerName: `${v.name}${p.type === 'net' && v.label ? ` (${p.ip})` : ''}`, station }, { brand, footer, byName: 'Admin', number: 'SINOV' });
  return { ...r, online: r.station.online };
}
