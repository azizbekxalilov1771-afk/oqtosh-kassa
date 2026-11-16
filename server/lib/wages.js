import { AppError } from './env.js';
import { getDb } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { listStaff, STAFF_ROLES } from './customers.js';
import { normalizeRange } from './owner.js';

// Xodimlar ish haqi: stavka (lavozim bo'yicha standart + har bir xodimga alohida) va davr bo'yicha hisob.
//   settings/wages  { roles: { waiter: Rate, cashier: Rate, courier: Rate, storekeeper: Rate }, staff: { 'tg:ID': Rate } }
//   Rate            { daily: so'm (har ishlagan kuni), pct: % , base: 'service' | 'sales', perDelivery: so'm (kuryer) }
// Ishlagan kun — xodim shu kuni buyurtma qabul qilgan/yozgan, hisob yopgan, stolga xizmat qilgan yoki yetkazgan kun.
// Ofitsiant foizi odatda xizmat haqidan (base: 'service') — "obslujivanie"ning ulushi; savdodan ham bo'lishi mumkin.

const ROLE_LABEL = { waiter: 'Ofitsiant', cashier: 'Kassir', courier: 'Kuryer', storekeeper: 'Omborchi' };
const ZERO = { daily: 0, pct: 0, base: 'service', perDelivery: 0 };
const money = (v) => {
  const n = Math.round(Number(String(v ?? '').replace(/\s/g, '')) || 0);
  if (n < 0 || n > 1e8) throw new AppError(400, 'Summa 0 dan 100 000 000 gacha bo‘lsin.');
  return n;
};
function cleanRate(r) {
  if (!r || typeof r !== 'object') return { ...ZERO };
  const pct = Math.round((Number(String(r.pct ?? 0).replace(',', '.')) || 0) * 10) / 10;
  if (pct < 0 || pct > 100) throw new AppError(400, 'Foiz 0–100 oralig‘ida bo‘lsin.');
  return { daily: money(r.daily), pct, base: r.base === 'sales' ? 'sales' : 'service', perDelivery: money(r.perDelivery) };
}
const isZero = (r) => !r.daily && !r.pct && !r.perDelivery;

export async function getWageRates() {
  const s = await readSetting('wages', {});
  const roles = Object.fromEntries(STAFF_ROLES.map((k) => [k, { ...ZERO, ...(s.roles?.[k] || {}) }]));
  return { roles, staff: s.staff || {} };
}

// { roles: { waiter: Rate… }, staff: { id: Rate | null } } — null yoki nol stavka xodimni lavozim standartiga qaytaradi
export async function saveWageRates(body) {
  const cur = await getWageRates();
  const roles = { ...cur.roles };
  for (const k of STAFF_ROLES) if (body?.roles?.[k]) roles[k] = cleanRate(body.roles[k]);
  const staff = { ...cur.staff };
  for (const [id, r] of Object.entries(body?.staff || {}).slice(0, 300)) {
    if (!/^tg:[\w-]{1,80}$/.test(id)) continue;
    if (r === null || r?.useRole) delete staff[id];
    else staff[id] = cleanRate(r);
  }
  await writeSetting('wages', { roles, staff });
  return getWageRates();
}

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function wageReport(q = {}) {
  const { from, to, days: n } = normalizeRange(q);
  const db = await getDb();
  if (!db) throw new AppError(503, 'Ma’lumotlar bazasi ulanmagan.');
  const [rates, staff] = await Promise.all([getWageRates(), listStaff()]);
  const rows = new Map();
  const rowOf = (id, name = '', role = '') => {
    if (!id) return null;
    if (!rows.has(id)) rows.set(id, { id, name, role, days: new Set(), tabs: 0, sales: 0, service: 0, orders: 0, closed: 0, deliveries: 0, deliveryFees: 0 });
    const r = rows.get(id);
    if (!r.name && name) r.name = name;
    return r;
  };
  for (const s of staff) rowOf(`tg:${s.id}`, s.name || s.phone || 'Xodim', s.role);

  for (let i = 0, day = from; i < n; i++, day = addDays(day, 1)) {
    const [tabs, orders] = await Promise.all([
      db.collection('tabs').where('closedDay', '==', day).get(),
      db.collection('orders').where('day', '==', day).get(),
    ]);
    for (const d of tabs.docs) {
      const t = d.data();
      if (t.status !== 'closed') continue;
      const w = rowOf(t.waiterId, t.waiterName);
      if (w) {
        w.days.add(day);
        w.tabs += 1;
        w.sales += t.payment?.amount ?? t.total ?? 0;
        w.service += t.service || 0;
      }
      const c = t.closedById && t.closedById !== 'mison' ? rowOf(t.closedById, t.closedByName) : null;
      if (c) {
        c.days.add(day);
        c.closed += 1;
      }
    }
    for (const d of orders.docs) {
      const o = d.data();
      if (o.status !== 'qabul') continue;
      const a = rowOf(o.acceptedById || o.createdById, o.acceptedByName || o.createdByName);
      if (a) {
        a.days.add(day);
        a.orders += 1;
      }
      if (o.mode === 'delivery' && o.deliveredAtMs && o.courierId) {
        const k = rowOf(o.courierId, o.courierName);
        k.days.add(day);
        k.deliveries += 1;
        k.deliveryFees += o.deliveryFee || 0;
      }
    }
  }

  const out = [...rows.values()].map((r) => {
    const own = rates.staff[r.id];
    const rate = own || rates.roles[r.role] || ZERO;
    const days = r.days.size;
    const base = rate.base === 'sales' ? r.sales : r.service;
    const fromDays = rate.daily * days;
    const fromPct = Math.round((base * rate.pct) / 100);
    const fromDel = rate.perDelivery * r.deliveries;
    return {
      id: r.id, name: r.name || 'Xodim', role: r.role, roleLabel: ROLE_LABEL[r.role] || '', days, tabs: r.tabs, sales: r.sales, service: r.service,
      orders: r.orders, closed: r.closed, deliveries: r.deliveries, rate, ownRate: Boolean(own), fromDays, fromPct, fromDel, earned: fromDays + fromPct + fromDel,
    };
  }).filter((r) => r.role || r.days).sort((a, b) => b.earned - a.earned || b.sales - a.sales || a.name.localeCompare(b.name));
  return {
    range: { from, to, days: n },
    rows: out,
    total: out.reduce((s, r) => s + r.earned, 0),
    unset: out.filter((r) => r.role && isZero(r.rate)).length,
  };
}
