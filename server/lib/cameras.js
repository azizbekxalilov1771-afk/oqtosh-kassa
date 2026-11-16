import { AppError } from './env.js';
import { readSetting, writeSetting } from './settings.js';

// Kassa kompyuteridagi Oqtosh Kassa dasturi yuborgan kameralar ro'yxati (settings/cameras).
// Faqat nomlar va "kabina = stol" — IP, parol, rasm saytga kelmaydi. Owner "kabina nazorati" shundan foydalanadi.
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const PLACES = ['table', 'kassa', 'zal'];

export async function saveAgentCameras(body) {
  if (!Array.isArray(body?.cameras)) throw new AppError(400, 'Kameralar ro‘yxati kerak.');
  const items = body.cameras.slice(0, 200).map((c) => ({
    key: str(c?.key, 120),
    nvr: str(c?.nvr, 80),
    model: str(c?.model, 60),
    ch: Math.round(Number(c?.ch) || 0),
    name: str(c?.name, 80),
    online: c?.online !== false,
    place: PLACES.includes(c?.place) ? c.place : '',
    tableId: c?.place === 'table' ? str(c?.tableId, 80) : '',
    label: str(c?.label, 120),
  })).filter((c) => c.key && c.ch > 0);
  await writeSetting('cameras', { items, updatedAtMs: Date.now() });
  return { ok: true, count: items.length, linked: items.filter((c) => c.place === 'table').length };
}

export async function getCameras() {
  return readSetting('cameras', { items: [], updatedAtMs: 0 });
}
