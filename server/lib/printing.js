import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { getRestaurantInfo } from './info.js';
import { getTabForStaff } from './tabs.js';
import { getOrderForStaff } from './orders.js';
import { str } from './validate.js';
import { noteStationIp } from './workplace.js';
import { kassaPrinter, getKitchen } from './kitchen.js';
import { queueBill } from './agent.js';
import { ringInfo, ring } from './doorbell.js';
import { getReceipt } from './receipt-settings.js';

// Qurilmalar va chek printeri.
//  devices/{id}    — xodimlar kirgan brauzerlar (telefon, planshet, kompyuter). ID brauzerda saqlanadi
//                    va har so'rovda X-Oq-Device sarlavhasi bilan keladi.
//  settings/printing — { stationId, paper, footer }: admin tanlagan asosiy kassa kompyuteri.
//  print_jobs/{id} — telefondan bosilgan chek. Kassa kompyuteridagi sahifa navbatni olib, printerga chiqaradi.
// Admin "Tayyorlash joylari"da kassa printerini (printer dasturi orqali) tanlagan bo'lsa — hisob va to'lov
// cheklari o'sha printerga ESC/POS bilan boradi, brauzerdagi "chek printeri" esa ishlatilmaydi.

const ONLINE_MS = 3 * 60_000;
const JOB_TTL = 30 * 60_000;
export const PAPERS = [80, 58];
const DEFAULT_PRINTING = { stationId: '', paper: 80, footer: 'Rahmat! Yana kutib qolamiz.' };
const PAGES = { kassa: 'Kassa', ofitsiant: 'Ofitsiant', kuryer: 'Kuryer' };

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

export const getPrinting = () => readSetting('printing', DEFAULT_PRINTING);

export function deviceIdOf(request) {
  const v = String(request.headers.get('x-oq-device') || '');
  return /^[A-Za-z0-9_-]{16,40}$/.test(v) ? v : '';
}

// User-Agent'dan qisqa nom: "Android telefon · Chrome", "Windows kompyuter · Chrome"
export function describeDevice(ua = '') {
  const tablet = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
  const phone = !tablet && /Mobi|iPhone|Android/.test(ua);
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? (tablet ? 'Android planshet' : 'Android telefon')
      : /Windows/.test(ua) ? 'Windows kompyuter' : /Mac OS X/.test(ua) ? 'Mac kompyuter'
        : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux kompyuter' : 'Qurilma';
  const model = /Android [\d.]+; ([^;)]+)\)/.exec(ua)?.[1]?.trim();
  const app = /OqtoshApp\//.test(ua) ? 'Oqtosh ilova' : /YaBrowser\//.test(ua) ? 'Yandex' : /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const name = [model && model !== 'K' ? `${os} (${model})` : os, app].filter(Boolean).join(' · ');
  return { kind: tablet ? 'tablet' : phone ? 'phone' : 'computer', name };
}

// Xodim so'rovi kelganda qurilmani "ko'rildi" deb belgilash (har qurilma uchun ~1 daqiqada bir yozuv)
const seen = new Map();
export async function touchDevice(request, staff, ip = '') {
  const id = deviceIdOf(request);
  if (!id) return;
  const now = Date.now();
  // kassa kompyuteri (chek printeri) — uning internet manzili "ishxona tarmog'i" bo'lib yangilanib turadi
  if (ip && id === (await getPrinting()).stationId) await noteStationIp(ip).catch((e) => console.error('[workplace]', e.message));
  const key = `${id}:${staff.id}`;
  if (now - (seen.get(key) || 0) < 50_000) return;
  seen.set(key, now);
  if (seen.size > 2000) seen.clear();
  try {
    const db = await getDb();
    if (!db) return;
    const ua = String(request.headers.get('user-agent') || '').slice(0, 300);
    const page = String(request.headers.get('x-oq-page') || '');
    const d = describeDevice(ua);
    await db.collection('devices').doc(id).set({
      ua, kind: d.kind, auto: d.name, page: PAGES[page] ? page : '',
      staffId: String(staff.id), staffName: staff.name || staff.firstName || '', role: staff.role || '', lastSeenMs: now,
    }, { merge: true });
  } catch (e) {
    console.error('[devices] touch:', e.message);
  }
}

const deviceView = (id, d, stationId, now = Date.now()) => ({
  id, name: d.name || d.auto || 'Qurilma', auto: d.auto || '', custom: Boolean(d.name), kind: d.kind || 'computer',
  staffName: d.staffName || '', role: d.role || '', page: d.page || '', pageLabel: PAGES[d.page] || '',
  lastSeenAt: d.lastSeenMs ? new Date(d.lastSeenMs).toISOString() : '', online: now - (d.lastSeenMs || 0) < ONLINE_MS,
  station: id === stationId, lastPrintAt: d.lastPrintMs ? new Date(d.lastPrintMs).toISOString() : '',
});

async function stationInfo(db, printing) {
  if (!printing.stationId) return null;
  const snap = await db.collection('devices').doc(printing.stationId).get();
  return snap.exists ? deviceView(snap.id, snap.data(), printing.stationId) : null;
}

/* ───────── Xodim sahifalari ───────── */

// /api/staff/orders javobiga: shu qurilma chek printerimi, printer umuman tanlanganmi
export async function printInfo(request) {
  const [p, kassa, k] = await Promise.all([getPrinting(), kassaPrinter().catch(() => null), getKitchen().catch(() => ({}))]);
  const kitchen = Boolean(k.enabled);
  if (kassa) return { configured: true, station: false, agent: true, kitchen };
  const id = deviceIdOf(request);
  const station = Boolean(id && id === p.stationId);
  if (!station) return { configured: Boolean(p.stationId), station: false, kitchen };
  // kassa kompyuteri: navbatda chek bormi (alohida so'rovsiz) va "qo'ng'iroq" manzili
  const db = await getDb();
  const snap = db ? await db.collection('print_jobs').where('status', '==', 'new').limit(20).get().catch(() => null) : null;
  const now = Date.now();
  const pending = Boolean(snap?.docs.some((d) => d.data().stationId === id && d.data().expiresAtMs > now));
  return { configured: true, station: true, pending, kitchen, ring: (await ringInfo())?.url || '' };
}

const jobView = (id, j) => ({
  id, kind: j.kind, data: j.data, paper: j.paper, footer: j.footer, brand: j.brand, fmt: j.fmt || {},
  byName: j.byName || '', createdAt: new Date(j.createdAtMs).toISOString(), number: id.slice(-4).toUpperCase(),
});

export async function brandOf() {
  const info = await getRestaurantInfo();
  const loc = (info.locations || [])[0] || {};
  return { name: info.name || 'Restoran', phone: info.phone || loc.phone || '', address: loc.address || '' };
}

async function createJob(db, kind, data, by) {
  const printing = await getPrinting();
  const kassa = await kassaPrinter();
  if (kassa) return queueBill(kassa, kind, data, { brand: await brandOf(), footer: printing.footer || '', byName: by.name || '', number: Date.now().toString(36).slice(-4).toUpperCase() });
  if (!printing.stationId) throw new AppError(409, 'Chek printeri tanlanmagan. Admin panel → Qurilmalar bo‘limida asosiy kassa kompyuterini tanlang.');
  const now = Date.now();
  const job = {
    kind, data, status: 'new', stationId: printing.stationId, paper: PAPERS.includes(printing.paper) ? printing.paper : 80,
    footer: printing.footer || '', brand: await brandOf(), byId: by.id, byName: by.name || '', createdAtMs: now, expiresAtMs: now + JOB_TTL,
    fmt: (await getReceipt().catch(() => null))?.bill || {},
  };
  const ref = await db.collection('print_jobs').add(job);
  await ring();
  const station = await stationInfo(db, printing);
  return { id: ref.id, station: station ? { name: station.name, online: station.online } : { name: 'Kassa kompyuteri', online: false } };
}

// Printer hali tanlanmagan bo'lsa: kassir kompyuterdan birinchi marta chek bossa — shu kompyuter asosiy printer bo'ladi
async function ensureStation(db, request, staff) {
  const printing = await getPrinting();
  if (printing.stationId || (await kassaPrinter()) || !request || !(staff?.can ? staff.can.has('page.kassa') : staff?.role === 'cashier')) return;
  const id = deviceIdOf(request);
  if (!id) return;
  const d = await db.collection('devices').doc(id).get();
  const kind = d.exists ? d.data().kind : describeDevice(String(request.headers.get('user-agent') || '')).kind;
  if (kind !== 'computer') return;
  if (!d.exists) await touchDevice(request, staff);
  await savePrinting({ stationId: id });
}

// Telefondan "Chek chiqarish": stol hisobi yoki bitta buyurtma (masalan, yetkazib berish)
export async function requestPrint(body, actor, { request, staff } = {}) {
  const db = await needDb();
  await ensureStation(db, request, staff).catch((e) => console.error('[printing] avto-printer:', e.message));
  const r = await requestPrintJob(db, body, actor);
  if (await kassaPrinter()) return { ...r, self: false, agent: true };
  // shu qurilmaning o'zi printer — sahifa navbatni darhol oladi
  return { ...r, self: Boolean(request && deviceIdOf(request) && deviceIdOf(request) === (await getPrinting()).stationId) };
}

async function requestPrintJob(db, body, actor) {
  if (body?.tabId) {
    const tab = await getTabForStaff(String(body.tabId));
    if (!tab.rounds.some((o) => o.status === 'qabul')) throw new AppError(409, 'Hisobda qabul qilingan buyurtma yo‘q — chekka chiqadigan narsa yo‘q.');
    const job = await createJob(db, 'tab', tab, actor);
    // stollar sahifasida "chek chiqqan" rangi uchun
    await db.collection('tabs').doc(tab.id).update({ billPrintedAtMs: Date.now(), billPrintedByName: actor.name || '' }).catch(() => {});
    return job;
  }
  if (body?.orderId) {
    const order = await getOrderForStaff(String(body.orderId));
    return createJob(db, 'order', order, actor);
  }
  throw new AppError(400, 'Qaysi chek chiqarilishini tanlang.');
}

// To'lov qilindi — "TO'LANDI" cheki (printer tanlangan bo'lsa). Virtual kassa ulanganda shu yerdan fiskal chek ham chiqadi.
//   kind: 'paid' (stol hisobi), 'paidorder' (yetkazish), 'shift' (X/Z hisobot)
export async function printDoc(kind, data, actor, { request, staff } = {}) {
  const db = await needDb();
  await ensureStation(db, request, staff).catch((e) => console.error('[printing] avto-printer:', e.message));
  const printing = await getPrinting();
  if (await kassaPrinter()) {
    const r = await createJob(db, kind, data, actor);
    return { printed: true, station: r.station, self: false, agent: true };
  }
  if (!printing.stationId) return { printed: false, reason: 'printer tanlanmagan' };
  const r = await createJob(db, kind, data, actor);
  return { printed: true, station: r.station, self: Boolean(request && deviceIdOf(request) === printing.stationId) };
}
export const printPaid = (tab, actor, opts) => printDoc('paid', tab, actor, opts);

// Kassa kompyuteri: navbatdagi cheklar (faqat tanlangan qurilmaga)
export async function stationJobs(request) {
  const printing = await getPrinting();
  const id = deviceIdOf(request);
  if (!id || id !== printing.stationId || (await kassaPrinter())) return { station: false, jobs: [] };
  const db = await needDb();
  const snap = await db.collection('print_jobs').where('status', '==', 'new').limit(20).get();
  const now = Date.now();
  const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((j) => j.stationId === id && j.expiresAtMs > now)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((j) => jobView(j.id, j));
  return { station: true, jobs };
}

export async function finishJob(request, jobId, body) {
  const printing = await getPrinting();
  const id = deviceIdOf(request);
  if (!id || id !== printing.stationId) throw new AppError(403, 'Bu qurilma chek printeri emas.');
  const db = await needDb();
  const ref = db.collection('print_jobs').doc(String(jobId || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new AppError(404, 'Chek topilmadi.');
  const ok = body?.status !== 'error';
  await ref.update({ status: ok ? 'done' : 'error', error: ok ? '' : str(body?.error, 200), doneAtMs: Date.now() });
  if (ok) await db.collection('devices').doc(id).set({ lastPrintMs: Date.now() }, { merge: true });
  return { ok: true };
}

/* ───────── Admin: Qurilmalar ───────── */

const KIND_LABEL = { tab: 'Stol hisobi', order: 'Buyurtma', test: 'Sinov cheki', paid: 'To‘lov cheki', paidorder: 'To‘lov cheki (yetkazish)', shift: 'Smena hisoboti' };

export async function listDevicesForAdmin() {
  const db = await needDb();
  const printing = await getPrinting();
  const [ds, js] = await Promise.all([
    db.collection('devices').limit(300).get(),
    db.collection('print_jobs').orderBy('createdAtMs', 'desc').limit(60).get(),
  ]);
  const now = Date.now();
  const items = ds.docs.map((d) => deviceView(d.id, d.data(), printing.stationId, now))
    .sort((a, b) => Number(b.station) - Number(a.station) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const jobs = js.docs.map((d) => ({ id: d.id, ...d.data() }));
  // eski cheklarni tozalash (3 kundan oshgan)
  const old = jobs.filter((j) => now - j.createdAtMs > 3 * 86_400_000);
  await Promise.all(old.slice(0, 40).map((j) => db.collection('print_jobs').doc(j.id).delete().catch(() => {})));
  const recent = jobs.filter((j) => now - j.createdAtMs <= 3 * 86_400_000).slice(0, 12).map((j) => ({
    id: j.id, kind: KIND_LABEL[j.kind] || j.kind,
    title: j.kind === 'tab' || j.kind === 'paid' ? j.data?.tableLabel : j.kind === 'order' || j.kind === 'paidorder' ? `#${j.data?.number}` : j.kind === 'shift' ? `Smena #${j.data?.number}` : '',
    byName: j.byName || '', createdAt: new Date(j.createdAtMs).toISOString(),
    status: j.status === 'new' && j.expiresAtMs <= now ? 'expired' : j.status, error: j.error || '',
  }));
  return {
    items,
    printing: { stationId: printing.stationId, paper: printing.paper, footer: printing.footer },
    station: items.find((d) => d.station) || null,
    queue: recent.filter((j) => j.status === 'new').length,
    jobs: recent,
  };
}

export async function savePrinting(body) {
  const current = await getPrinting();
  const next = { ...current };
  if (body.stationId !== undefined) {
    const id = String(body.stationId || '');
    if (id) {
      const db = await needDb();
      if (!(await db.collection('devices').doc(id).get()).exists) throw new AppError(404, 'Qurilma topilmadi.');
    }
    next.stationId = id;
  }
  if (body.paper !== undefined) {
    const paper = Number(body.paper);
    if (!PAPERS.includes(paper)) throw new AppError(400, 'Qog‘oz eni 80 yoki 58 mm bo‘ladi.');
    next.paper = paper;
  }
  if (body.footer !== undefined) next.footer = str(body.footer, 160);
  await writeSetting('printing', next);
  return next;
}

export async function renameDevice(id, name) {
  const db = await needDb();
  const ref = db.collection('devices').doc(String(id || ''));
  if (!(await ref.get()).exists) throw new AppError(404, 'Qurilma topilmadi.');
  await ref.update({ name: str(name, 60) });
  return { ok: true };
}

export async function deleteDevice(id) {
  const db = await needDb();
  const printing = await getPrinting();
  await db.collection('devices').doc(String(id || '')).delete();
  if (printing.stationId === id) await writeSetting('printing', { ...printing, stationId: '' });
  return { ok: true };
}

export async function testPrint(adminEmail) {
  const db = await needDb();
  const printing = await getPrinting();
  const station = await stationInfo(db, printing);
  return createJob(db, 'test', { deviceName: station?.name || '', printerName: 'Kassa printeri' }, { id: `admin:${adminEmail}`, name: 'Admin' });
}
