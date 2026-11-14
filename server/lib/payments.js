import crypto from 'node:crypto';
import { AppError } from './env.js';
import { readSetting, writeSetting } from './settings.js';
import { str } from './validate.js';

// Kassadagi to'lov turlari: admin panel → "To'lovlar". Naqd, Karta, Click, Payme, Uzum doim ro'yxatda
// (yoqib/o'chirish va nomini o'zgartirish mumkin), qo'shimcha turlar (Humo, Uzcard, bank o'tkazmasi...) qo'shiladi.
//   settings/payments { methods: [{ key, label, kind, on }] }
// Click/Payme/Uzum kalitlari — settings/integrations'da shifrlangan holda (config.js FIELDS).

const BUILTIN = [
  { key: 'naqd', label: 'Naqd', kind: 'cash' },
  { key: 'karta', label: 'Karta (terminal)', kind: 'card' },
  { key: 'click', label: 'Click', kind: 'click' },
  { key: 'payme', label: 'Payme', kind: 'payme' },
  { key: 'uzum', label: 'Uzum', kind: 'uzum' },
];
const BUILTIN_KEYS = new Set(BUILTIN.map((m) => m.key));

export async function getPayments() {
  const s = await readSetting('payments', {});
  const stored = Array.isArray(s.methods) ? s.methods : [];
  const out = [];
  for (const m of stored) {
    const b = BUILTIN.find((x) => x.key === m.key);
    if (b) out.push({ ...b, label: m.label || b.label, on: m.on !== false });
    else if (/^x[a-f0-9]{6}$/.test(m.key || '') && m.label) out.push({ key: m.key, label: m.label, kind: 'other', on: m.on !== false });
  }
  for (const b of BUILTIN) if (!out.some((m) => m.key === b.key)) out.push({ ...b, on: true });
  return out;
}

export async function savePayments(body) {
  const list = Array.isArray(body?.methods) ? body.methods.slice(0, 20) : [];
  const methods = [];
  for (const m of list) {
    const label = str(m?.label, 40);
    if (BUILTIN_KEYS.has(m?.key)) methods.push({ key: m.key, label: label || BUILTIN.find((b) => b.key === m.key).label, on: m.on !== false });
    else if (label) methods.push({ key: /^x[a-f0-9]{6}$/.test(m?.key || '') ? m.key : `x${crypto.randomBytes(3).toString('hex')}`, label, on: m.on !== false });
  }
  for (const b of BUILTIN) if (!methods.some((m) => m.key === b.key)) methods.push({ key: b.key, label: b.label, on: true });
  if (!methods.some((m) => m.on)) throw new AppError(400, 'Kamida bitta to‘lov turi yoqilgan bo‘lsin.');
  await writeSetting('payments', { methods });
  return getPayments();
}

// Kassaning to'lov oynasi uchun: faqat yoqilganlari
export const kassaMethods = async () => (await getPayments()).filter((m) => m.on).map(({ key, label, kind }) => ({ key, label, kind }));
// to'lovni tekshirish uchun: { key: label } (faqat yoqilganlar)
export const methodLabels = async () => Object.fromEntries((await kassaMethods()).map((m) => [m.key, m.label]));
