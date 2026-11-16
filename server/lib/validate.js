import { AppError } from './env.js';

// Admin paneldan keladigan barcha ma'lumot shu yerda tozalanadi.
// Havolalarda faqat xavfsiz sxemalar: javascript: kabi havolalar saytga tushmaydi.

export const str = (v, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const text = (v, max = 3000) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');
export const bool = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback);

export function num(v, min, max) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new AppError(400, `Son ${min} va ${max} oralig‘ida bo‘lsin.`);
  return n;
}

export function url(v, { label = 'Havola', relative = true, tel = false } = {}) {
  const s = str(v, 600);
  if (!s) return '';
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  if (relative && /^\/(?!\/)[^\s]*$/.test(s)) return s;
  if (relative && /^#[\w-]*$/.test(s)) return s;
  if (tel && /^tel:\+?[\d\s()-]{5,20}$/.test(s)) return s;
  throw new AppError(400, `${label} noto‘g‘ri: https://, / yoki # bilan boshlansin.`);
}

export function image(v, label = 'Rasm') {
  const s = str(v, 600);
  if (!s) return '';
  if (/^\/api\/media\/[a-f0-9]{32}$/.test(s) || /^https:\/\/[^\s]+$/i.test(s)) return s;
  throw new AppError(400, `${label} havolasi noto‘g‘ri.`);
}

export function list(v, max, mapItem) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).map(mapItem).filter(Boolean);
}

export const id = (prefix = 's') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
