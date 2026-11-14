import { AppError } from './env.js';
import { signToken, verifyToken } from './crypto.js';
import { getCustomer } from './customers.js';

// Mijoz sessiyasi: imzolangan token HttpOnly cookie'da. Brauzer JS'i uni o'qiy olmaydi.
const COOKIE = 'oq_s';
const DAYS = 30;

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

const secureFlag = (request) => (new URL(request.url).protocol === 'https:' ? '; Secure' : '');

// hours: parol bilan kirganda sessiya bir smena (16 soat) davom etadi; Telegram orqali — 30 kun
// password: parol bilan ochilgan sessiya parol almashtirilsa yopiladi (Telegram sessiyalari qoladi)
export function sessionCookie(request, customer, { hours, password = false } = {}) {
  const sec = hours ? Math.round(hours * 3600) : DAYS * 86_400;
  const token = signToken({ c: customer.id, v: customer.sessionVersion || 0, ...(password ? { p: customer.pwVersion || 0 } : {}), exp: Date.now() + sec * 1000 });
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sec}${secureFlag(request)}`;
}

export const clearSessionCookie = (request) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(request)}`;

// Xodim sahifalari tez-tez so'raydi — mijoz hujjati 30 soniya xotirada (Firestore o'qishlari tejaladi).
// PIN almashtirilsa yoki xodim o'chirilsa — ko'pi bilan 30 soniyada kuchga kiradi.
const custMem = new Map();
async function customerCached(id) {
  const hit = custMem.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.c ? { ...hit.c } : null;
  const c = await getCustomer(id);
  custMem.set(id, { at: Date.now(), c });
  if (custMem.size > 500) custMem.clear();
  return c ? { ...c } : null;
}
export const forgetCustomerCache = (id) => (id ? custMem.delete(String(id)) : custMem.clear());

export async function currentCustomer(request) {
  const payload = verifyToken(readCookie(request, COOKIE));
  if (!payload) return null;
  const c = await customerCached(payload.c);
  if (!c || (c.sessionVersion || 0) !== payload.v || c.blocked) return null;
  if (payload.p !== undefined && ((c.pwVersion || 0) !== payload.p || !c.pwHash)) return null;
  return c;
}

export async function requireCustomer(request) {
  const c = await currentCustomer(request);
  if (!c) {
    const e = new AppError(401, 'Avval Telegram orqali kiring.');
    e.code = 'login';
    throw e;
  }
  return c;
}

const ROLE_PAGE = { waiter: 'ofitsiantlar', cashier: 'kassirlar', courier: 'kuryerlar' };
export async function requireStaff(request, roles = ['waiter', 'cashier']) {
  const c = await requireCustomer(request);
  if (!roles.includes(c.role)) {
    throw new AppError(403, `Bu sahifa faqat ${roles.map((r) => ROLE_PAGE[r]).join(' va ')} uchun. Admin sizni “Xodimlar” bo‘limida qo‘shishi kerak.`);
  }
  return c;
}

// Boshqa saytdan yuborilgan so'rovlarni rad etish (cookie bilan ishlaydigan POST'lar uchun)
export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  try {
    if (new URL(origin).host === new URL(request.url).host) return;
  } catch {}
  throw new AppError(403, 'So‘rov rad etildi.');
}
