// Xodim ruxsatlari (server /api/me va so'rovlar javobidan). Tugmalar shunga qarab ko'rsatiladi;
// server baribir har amalni o'zi tekshiradi.
let set = null;
export const setPerms = (list) => {
  set = new Set(Array.isArray(list) ? list : []);
};
export const can = (key) => Boolean(set?.has(key));
export const canAny = (...keys) => keys.some(can);

// Kirgan xodim boshqa sahifaga tegishli bo'lsa (masalan omborchi ofitsiant oynasidan kirdi) — o'z sahifasi
export function homeFor(here) {
  const order = [['page.kassa', 'kassa.html'], ['page.ofitsiant', 'ofitsiant.html'], ['page.ombor', 'ombor.html'], ['page.kuryer', 'kuryer.html']];
  if (can(here)) return '';
  const hit = order.find(([k]) => can(k));
  return hit ? hit[1] : '';
}
