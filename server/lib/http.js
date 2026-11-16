import { AppError } from './env.js';

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

export async function readJson(request, max = 50_000) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new AppError(415, 'JSON yuboring.');
  const text = await request.text();
  if (text.length > max) throw new AppError(413, 'So‘rov juda katta.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new AppError(400, 'JSON noto‘g‘ri.');
  }
}

// IP bo'yicha oddiy cheklov. Serverless'da har bir instansiya o'z hisobini yuritadi —
// spamga qarshi birinchi to'siq, to'liq himoya emas.
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) throw new AppError(429, 'Juda ko‘p so‘rov. Birozdan so‘ng qayta urinib ko‘ring.');
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
}

export function errorResponse(e, route) {
  if (e?.expose) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status || 400);
  console.error('[api]', route, e);
  return json({ error: 'Serverda xatolik. Birozdan so‘ng qayta urinib ko‘ring.' }, 500);
}
