import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { getMenu } from './menu.js';
import { str } from './validate.js';
import { kitchenTicket } from './escpos.js';
import { getReceipt } from './receipt-settings.js';
import { getPrinter, queueAgentJob, ringNow, onPrinterMoved } from './agent.js';

// Tayyorlash joylari (oshxona bo'limlari): Salat, Issiq ovqat, Somsa, Shashlik...
// Buyurtma qabul qilinganda har taom o'z bo'limiga boradi va o'sha bo'limning printeridan chiqadi.
// Taom qaysi bo'limga borishini menyu kategoriyasi belgilaydi; alohida taomni boshqa bo'limga ham bog'lash mumkin.
//   settings/kitchen: { enabled, stations: [...], otherStationId, kassaPrinterId, sources: { qr, staff, delivery },
//                       skip: { categories, items } — oshxonaga chiqmaydigan (masalan, tayyor ichimliklar) }

const DEFAULT = { enabled: false, stations: [], otherStationId: '', kassaPrinterId: '', sources: { qr: true, staff: true, delivery: true }, skip: { categories: [], items: [] } };
export const getKitchen = () => readSetting('kitchen', DEFAULT);

const SUGGEST = [
  { name: 'Salat', re: /salat|салат|salad|закуск|zakuska|gazak/i },
  { name: 'Somsa', re: /somsa|самс|samsa|tandir|тандыр|non\b|выпеч|pishiriq/i },
  { name: 'Shashlik', re: /shashl|шашл|kabob|kebab|кебаб|mangal|мангал|grill|гриль/i },
  { name: 'Bar', re: /ichimlik|напит|drink|choy|чай|kofe|кофе|coffee|sharbat|сок|juice|bar\b|бар\b|limonad|лимонад/i },
];

// Birinchi marta: menyu kategoriyalaridan taxminiy bo'limlar (admin keyin o'zgartiradi)
export function suggestStations(categories) {
  const used = new Set();
  const out = SUGGEST.map((s) => {
    const cats = categories.filter((c) => !used.has(c) && s.re.test(c));
    cats.forEach((c) => used.add(c));
    return { name: s.name, categories: cats };
  }).filter((s) => s.categories.length || s.name !== 'Bar');
  out.splice(1, 0, { name: 'Issiq ovqat', categories: categories.filter((c) => !used.has(c)) });
  return out.map((s, i) => ({ id: `st${i + 1}`, name: s.name, printerId: '', categories: s.categories, items: [], copies: 1, beep: false, on: true }));
}

const cleanStation = (s, i) => ({
  id: /^[a-z0-9]{2,12}$/.test(String(s?.id || '')) ? String(s.id) : `st${crypto.randomBytes(3).toString('hex')}`,
  name: str(s?.name, 30) || `Bo‘lim ${i + 1}`,
  printerId: str(s?.printerId, 60),
  categories: (Array.isArray(s?.categories) ? s.categories : []).map((c) => str(c, 80)).filter(Boolean).slice(0, 60),
  items: (Array.isArray(s?.items) ? s.items : []).map((c) => str(c, 40)).filter(Boolean).slice(0, 200),
  copies: Math.min(3, Math.max(1, Math.round(Number(s?.copies)) || 1)),
  beep: Boolean(s?.beep),
  on: s?.on !== false,
});

export async function kitchenForAdmin() {
  const [k, menu] = await Promise.all([getKitchen(), getMenu().catch(() => ({ items: [], categories: [] }))]);
  const categories = menu.categories || [];
  const stations = k.stations?.length ? k.stations : suggestStations(categories);
  return {
    ...k, stations, suggested: !k.stations?.length,
    otherStationId: k.stations?.length ? k.otherStationId : stations.find((s) => s.name === 'Issiq ovqat')?.id || '',
    menu: { categories, items: (menu.items || []).map((i) => ({ id: String(i.id), name: i.name, category: i.category || '' })) },
  };
}

export async function saveKitchen(body) {
  const current = await getKitchen();
  const next = { ...DEFAULT, ...current };
  if (body.stations !== undefined) {
    if (!Array.isArray(body.stations) || body.stations.length > 12) throw new AppError(400, 'Ko‘pi bilan 12 ta tayyorlash joyi.');
    const ids = new Set();
    next.stations = body.stations.map(cleanStation).map((s) => {
      while (ids.has(s.id)) s.id = `st${crypto.randomBytes(3).toString('hex')}`;
      ids.add(s.id);
      return s;
    });
  }
  if (body.otherStationId !== undefined) next.otherStationId = str(body.otherStationId, 20);
  if (next.otherStationId && !next.stations.some((s) => s.id === next.otherStationId)) next.otherStationId = '';
  if (body.kassaPrinterId !== undefined) {
    const id = str(body.kassaPrinterId, 60);
    if (id && !(await getPrinter(id))) throw new AppError(404, 'Printer topilmadi.');
    next.kassaPrinterId = id;
  }
  for (const s of next.stations) if (s.printerId && body.stations && !(await getPrinter(s.printerId))) s.printerId = '';
  if (body.skip) {
    const arr = (v, n) => (Array.isArray(v) ? v : []).map((c) => str(c, n)).filter(Boolean).slice(0, 300);
    next.skip = { categories: arr(body.skip.categories, 80), items: arr(body.skip.items, 40) };
  }
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  if (body.sources) next.sources = { qr: body.sources.qr !== false, staff: body.sources.staff !== false, delivery: body.sources.delivery !== false };
  await writeSetting('kitchen', next);
  return next;
}

// Printer o'chirilsa yoki IP'dan MAC'ga o'tsa — sozlamalardagi havolalar ham yangilanadi
onPrinterMoved(async (from, to) => {
  const k = await getKitchen();
  let changed = false;
  const stations = (k.stations || []).map((s) => {
    if (s.printerId !== from) return s;
    changed = true;
    return { ...s, printerId: to };
  });
  const kassaPrinterId = k.kassaPrinterId === from ? to : k.kassaPrinterId;
  if (kassaPrinterId !== k.kassaPrinterId) changed = true;
  if (changed) await writeSetting('kitchen', { ...k, stations, kassaPrinterId });
});

// Kassa cheklari (hisob, to'lov) printer dasturi orqali chiqadigan printer
export async function kassaPrinter() {
  const k = await getKitchen();
  return k.kassaPrinterId ? getPrinter(k.kassaPrinterId) : null;
}

// Buyurtma taomlarini bo'limlarga ajratish
export function splitByStation(items, k, catOf) {
  const live = (k.stations || []).filter((s) => s.on !== false);
  const groups = new Map();
  const put = (s, it) => {
    if (!groups.has(s.id)) groups.set(s.id, { station: s, items: [] });
    groups.get(s.id).items.push(it);
  };
  const skip = k.skip || {};
  for (const it of items) {
    const id = String(it.id);
    // 1) alohida bog'langan taom  2) "chiqmasin" taom  3) "chiqmasin" kategoriya  4) kategoriya  5) boshqa taomlar joyi
    let targets = live.filter((s) => s.items?.includes(id));
    if (!targets.length && skip.items?.includes(id)) continue;
    if (!targets.length) {
      const cat = catOf(id);
      if (skip.categories?.includes(cat)) continue;
      targets = live.filter((s) => s.categories?.includes(cat));
    }
    if (!targets.length && k.otherStationId) targets = live.filter((s) => s.id === k.otherStationId);
    for (const s of targets) put(s, it);
  }
  return [...groups.values()];
}

// Qabul qilingan buyurtma → oshxona cheklari. source: qr | staff | delivery. Xato buyurtmani to'xtatmaydi.
// cancel — buyurtma bekor qilindi: faqat avval chek chiqqan joylarga "BEKOR QILINDI" cheki
export async function printKitchen(order, orderId, { source = 'qr', force = false, cancel = false } = {}) {
  try {
    const k = await getKitchen();
    if (!k.enabled && !force) return { printed: 0 };
    if (!force && k.sources && k.sources[source] === false) return { printed: 0 };
    const fmt = (await getReceipt().catch(() => null))?.kitchen || {};
    const menu = await getMenu().catch(() => ({ items: [] }));
    const cat = new Map((menu.items || []).map((i) => [String(i.id), i.category || '']));
    const groups = splitByStation(order.items || [], k, (id) => cat.get(id) || '');
    const sent = [];
    const missing = [];
    for (const g of groups) {
      if (cancel && !(order.kitchenStations || []).includes(g.station.name)) continue;
      const printer = g.station.printerId ? await getPrinter(g.station.printerId) : null;
      if (!printer) {
        missing.push(g.station.name);
        continue;
      }
      const where = order.mode === 'delivery' ? 'Yetkazish' : order.tableLabel || `Stol ${order.table || ''}`;
      await queueAgentJob({
        printerId: printer.id, kind: 'kitchen', station: g.station.name, title: `${cancel ? 'BEKOR ' : ''}#${order.number} · ${where}`,
        data: kitchenTicket({ station: g.station.name.toUpperCase(), order, items: g.items, width: printer.paper === 58 ? 32 : 48, beep: g.station.beep || cancel, reprint: force && !cancel, cancel, fmt }),
        copies: g.station.copies || 1, orderId, tabId: order.tabId || '', byName: order.acceptedByName || order.createdByName || '',
      }, { doRing: false });
      sent.push(g.station.name);
    }
    if (sent.length) await ringNow();
    if ((sent.length || missing.length) && !orderId.startsWith('__') && !cancel) {
      const db = await getDb();
      await db?.collection('orders').doc(orderId).update({ kitchenAtMs: Date.now(), kitchenStations: sent, ...(missing.length ? { kitchenMissing: missing } : {}) }).catch(() => {});
    }
    return { printed: sent.length, stations: sent, missing };
  } catch (e) {
    console.error('[kitchen]', e.message);
    return { printed: 0, error: e.message };
  }
}
