import { AppError } from './env.js';
import { readSetting, writeSetting } from './settings.js';

// Og'irlik bo'yicha sotiladigan taomlar (masalan, jiz 1 kg = 100 000 so'm → mijoz 0,7 kg yoki "100 000 so'mlik" oladi).
// Mison'da birligi kg va og'irligi 1 bo'lgan taomlar o'zi og'irlik bo'yicha; admin panel istalganini yoqadi/o'chiradi.
// settings/menu_config: { weighted: { [taomId]: { on: bool, step, min } } }
const DEF = { step: 0.1, min: 0.1 };

export const getMenuConfig = () => readSetting('menu_config', { weighted: {} });

export function applyMenuConfig(items, conf) {
  const w = conf?.weighted || {};
  return items.map((i) => {
    const c = w[i.id];
    const on = c ? c.on !== false : Boolean(i.perKg);
    if (!on) {
      if (!i.byWeight) return i;
      const { byWeight, ...rest } = i;
      return rest;
    }
    return { ...i, byWeight: { unit: 'kg', step: Number(c?.step) || DEF.step, min: Number(c?.min) || DEF.min } };
  });
}

export async function saveMenuConfig(body) {
  const weighted = {};
  for (const [id, c] of Object.entries(body?.weighted || {}).slice(0, 500)) {
    if (!/^[\w-]{1,64}$/.test(id) || !c) continue;
    const step = Number(c.step);
    const min = Number(c.min);
    if (c.on && (!(step >= 0.01 && step <= 1) || !(min >= 0.01 && min <= 5))) throw new AppError(400, 'Qadam 0,01–1 kg, eng kami 0,01–5 kg bo‘lsin.');
    weighted[id] = { on: Boolean(c.on), step: Math.round(step * 1000) / 1000 || DEF.step, min: Math.round(min * 1000) / 1000 || DEF.min };
  }
  return writeSetting('menu_config', { weighted });
}

// Miqdor: oddiy taom — butun son; og'irlik bo'yicha — qadamga karrali, eng kami min, ko'pi bilan 50 kg
export function checkQty(item, qty) {
  if (!item.byWeight) {
    if (!Number.isInteger(qty)) throw new AppError(400, `"${item.name}" faqat butun son bilan buyurtma qilinadi.`);
    return qty;
  }
  const { step, min } = item.byWeight;
  const q = Math.round(qty * 1000) / 1000;
  const k = q / step;
  if (q < min - 1e-9 || Math.abs(k - Math.round(k)) > 1e-6) throw new AppError(400, `"${item.name}": eng kami ${min} kg, qadam ${step} kg.`);
  return q;
}
