import { AppError } from './env.js';
import { readSetting, writeSetting } from './settings.js';
import { getRestaurantInfo } from './info.js';
import { str, text } from './validate.js';

// Yetkazib berish: narx restoran joyidan masofaga qarab. Masalan: "Oqtosh mahallasi ichida (1,5 km) — 15 000 so'm,
// undan keyin har km uchun 3 000 so'm". Masofa to'g'ri chiziq bo'yicha × yo'l koeffitsienti (shahar yo'llari uchun 1,3).
// settings/delivery
const DEFAULTS = { enabled: false, note: '', baseFee: 15000, baseRadiusKm: 1.5, perKm: 3000, minOrder: 0, maxKm: 25, roadFactor: 1.3, lat: null, lng: null };

export const getDeliverySettings = () => readSetting('delivery', DEFAULTS);

const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};

export async function saveDeliverySettings(b) {
  const lat = b?.lat === '' || b?.lat === null || b?.lat === undefined ? null : Number(b.lat);
  const lng = b?.lng === '' || b?.lng === null || b?.lng === undefined ? null : Number(b.lng);
  if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw new AppError(400, 'Koordinata noto‘g‘ri.');
  return writeSetting('delivery', {
    enabled: Boolean(b?.enabled),
    note: text(b?.note, 400),
    baseFee: Math.round(num(b?.baseFee, 0, 1e7, DEFAULTS.baseFee)),
    baseRadiusKm: num(b?.baseRadiusKm, 0, 100, DEFAULTS.baseRadiusKm),
    perKm: Math.round(num(b?.perKm, 0, 1e6, DEFAULTS.perKm)),
    minOrder: Math.round(num(b?.minOrder, 0, 1e8, 0)),
    maxKm: num(b?.maxKm, 0, 500, DEFAULTS.maxKm),
    roadFactor: num(b?.roadFactor, 1, 3, DEFAULTS.roadFactor),
    lat, lng,
  });
}

// Restoran joyi: sozlamadagi koordinata, bo'lmasa birinchi filial
async function origin(s) {
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.lat !== null) return { lat: s.lat, lng: s.lng };
  const info = await getRestaurantInfo();
  const l = (info.locations || []).find((x) => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng)) && x.lat !== '' && x.lng !== '');
  return l ? { lat: Number(l.lat), lng: Number(l.lng) } : null;
}

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const deliveryOrigin = async () => origin(await getDeliverySettings());

export async function publicDelivery() {
  const s = await getDeliverySettings();
  const o = await origin(s);
  // Restoran joyi belgilanmagan bo'lsa ham yetkazish ishlaydi — narx hamma joyga bir xil (baseFee)
  return { enabled: Boolean(s.enabled), note: s.note, minOrder: s.minOrder, baseFee: s.baseFee, baseRadiusKm: o ? s.baseRadiusKm : 0, perKm: o ? s.perKm : 0, flat: !o, origin: o };
}

export async function quoteDelivery(lat, lng) {
  const s = await getDeliverySettings();
  if (!s.enabled) throw new AppError(409, 'Hozir yetkazib berish ishlamayapti.');
  const o = await origin(s);
  const p = { lat: Number(lat), lng: Number(lng) };
  if (!(p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180)) throw new AppError(400, 'Xaritada joyni belgilang.');
  if (!o) return { fee: Math.round(s.baseFee), km: 0, inBase: true, flat: true, note: s.note, minOrder: s.minOrder }; // joy belgilanmagan: bir xil narx
  const km = Math.round(haversineKm(o, p) * s.roadFactor * 10) / 10;
  if (s.maxKm && km > s.maxKm) throw new AppError(409, `Bu manzil juda uzoq (${km} km). Biz ${s.maxKm} km gacha yetkazamiz.`);
  const extra = Math.max(0, Math.ceil(km - s.baseRadiusKm));
  const fee = Math.round((s.baseFee + extra * s.perKm) / 500) * 500;
  return { fee, km, inBase: km <= s.baseRadiusKm, note: s.note, minOrder: s.minOrder };
}

export function parseAddress(a) {
  const lat = Number(a?.lat);
  const lng = Number(a?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new AppError(400, 'Xaritada manzilingizni belgilang.');
  const street = str(a?.text, 200);
  if (street.length < 3) throw new AppError(400, 'Manzilni yozing: ko‘cha, uy.');
  return { lat, lng, text: street, apartment: str(a?.apartment, 20), entrance: str(a?.entrance, 20), floor: str(a?.floor, 20), landmark: str(a?.landmark, 120) };
}
