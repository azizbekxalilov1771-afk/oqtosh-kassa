import { readSetting, writeSetting } from './settings.js';
import { AppError } from './env.js';
import { str } from './validate.js';

// Chek ko'rinishi (admin → "Chek ko'rinishi"): oshxona cheki, kassa cheki (hisob/to'lov) va Mison'ga ketadigan izoh.
//   settings/receipt: { kitchen: {...}, bill: {...}, mison: {...} }

export const RECEIPT_DEFAULT = {
  kitchen: {
    title: '',            // bo'lim nomi o'rniga yoki ustiga (bo'sh — bo'lim nomi)
    itemSize: 'tall',     // taom qatori: normal | tall (baland) | big (katta)
    showNumber: true,     // #12
    showTime: true,
    showWaiter: true,
    showHall: false,      // zal nomi (stol nomidan tashqari)
    showComment: true,
    showMods: true,
    separateItems: false, // har taom orasida chiziq
    feed: 3,              // kesishdan oldin bo'sh qator
  },
  bill: {
    title: '',            // bo'sh — restoran nomi
    extra: '',            // sarlavha ostidagi qo'shimcha qatorlar (INN, Wi‑Fi paroli...), 3 qatorgacha
    showAddress: true,
    showPhone: true,
    showWaiter: true,
    showDate: true,
    showMods: true,
    showUnitPrice: true,  // "2 x 25 000"
    footer: '',           // bo'sh — "Qurilmalar"dagi yozuv
    showFiscalNote: true, // "To'lov uchun hisob. Fiskal chek kassada"
    showCheckNo: false,   // "Chek AB12 - Malika"
  },
  mison: {
    table: 'auto',        // auto (Mison stolni topa olmasa) | always | never
    number: true,         // "sayt #12"
    waiter: false,        // "yozdi: Sardor"
  },
};

const pick = (def, src) => {
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    const x = src?.[k];
    if (typeof v === 'boolean') out[k] = x === undefined ? v : Boolean(x);
    else if (typeof v === 'number') out[k] = Number.isFinite(Number(x)) ? Number(x) : v;
    else out[k] = x === undefined || x === null ? v : String(x);
  }
  return out;
};

export function normalizeReceipt(raw = {}) {
  const r = {
    kitchen: pick(RECEIPT_DEFAULT.kitchen, raw.kitchen),
    bill: pick(RECEIPT_DEFAULT.bill, raw.bill),
    mison: pick(RECEIPT_DEFAULT.mison, raw.mison),
  };
  if (!['normal', 'tall', 'big'].includes(r.kitchen.itemSize)) r.kitchen.itemSize = 'tall';
  r.kitchen.feed = Math.min(8, Math.max(1, Math.round(r.kitchen.feed)));
  r.kitchen.title = str(r.kitchen.title, 30);
  r.bill.title = str(r.bill.title, 40);
  r.bill.extra = String(r.bill.extra || '').split('\n').map((l) => str(l, 48)).filter(Boolean).slice(0, 3).join('\n');
  r.bill.footer = str(r.bill.footer, 120);
  if (!['auto', 'always', 'never'].includes(r.mison.table)) r.mison.table = 'auto';
  return r;
}

export async function getReceipt() {
  return normalizeReceipt(await readSetting('receipt', {}));
}

export async function saveReceipt(body) {
  if (!body || typeof body !== 'object') throw new AppError(400, 'Sozlama yo‘q.');
  const next = normalizeReceipt(body);
  await writeSetting('receipt', next);
  return next;
}

// Mison'ga ketadigan izoh: qisqa — Mison o'z chekida stol, mijoz va taomlarni baribir chiqaradi
export function misonComment(order, { tableFound = false, opts = RECEIPT_DEFAULT.mison } = {}) {
  const delivery = order.mode === 'delivery';
  const showTable = !delivery && order.mode !== 'saboy' && (opts.table === 'always' || (opts.table === 'auto' && !tableFound));
  const parts = delivery
    ? [order.address?.landmark && `mo‘ljal: ${order.address.landmark}`]
    : [order.takeaway || order.mode === 'saboy' ? 'SABOY' : '', showTable ? order.tableLabel || `Stol ${order.table}` : ''];
  if (opts.number) parts.push(`sayt #${order.number}`);
  if (opts.waiter && order.byStaff && order.createdByName) parts.push(order.createdByName);
  parts.push(order.comment);
  return parts.filter(Boolean).join(' · ').slice(0, 250);
}
