import { env, AppError } from './env.js';
import { getDb } from './firebase.js';
import { getConfig } from './config.js';
import { sendTelegram, escapeHtml, telegramConfigured } from './telegram.js';
import { getRestaurantInfo } from './info.js';
import { text } from './validate.js';

export const TOPICS = {
  food: 'Taom sifati',
  service: 'Xizmat ko‘rsatish',
  delivery: 'Yetkazib berish',
  clean: 'Tozalik',
  price: 'Narx yoki hisob',
  other: 'Boshqa',
};
export const STATUSES = { yangi: 'Yangi', jarayonda: 'Ko‘rib chiqilmoqda', hal: 'Hal qilindi' };

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function validateComplaint(body) {
  if (body?.website) throw new AppError(400, 'So‘rov rad etildi.'); // honeypot: odam to'ldirmaydi
  const c = {
    name: clean(body?.name, 80),
    phone: clean(body?.phone, 25),
    topic: TOPICS[body?.topic] ? body.topic : 'other',
    visitDate: clean(body?.visitDate, 20),
    message: typeof body?.message === 'string' ? body.message.trim().slice(0, 2000) : '',
  };
  if (c.message.length < 10) throw new AppError(400, 'Shikoyat matni kamida 10 ta belgidan iborat bo‘lsin.');
  if (c.phone && !/^\+?[\d\s()-]{7,20}$/.test(c.phone)) throw new AppError(400, 'Telefon raqami noto‘g‘ri. Masalan: +998 90 123 45 67');
  if (c.visitDate && !/^\d{4}-\d{2}-\d{2}$/.test(c.visitDate)) c.visitDate = '';
  return c;
}

function telegramText(c, id, restaurantName) {
  const time = new Intl.DateTimeFormat('ru-RU', { // 08.11.2026, 21:04
    timeZone: env('TIMEZONE', 'Asia/Tashkent'), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  return [
    `🔴 <b>Yangi shikoyat</b> — ${escapeHtml(restaurantName)}`,
    '',
    `<b>Mavzu:</b> ${escapeHtml(TOPICS[c.topic])}`,
    `<b>Ism:</b> ${escapeHtml(c.name || '—')}`,
    `<b>Telefon:</b> ${escapeHtml(c.phone || '—')}`,
    c.visitDate ? `<b>Tashrif sanasi:</b> ${escapeHtml(c.visitDate)}` : null,
    '',
    escapeHtml(c.message),
    '',
    `<i>${time}${id ? `\nID: ${escapeHtml(id)}` : ''}</i>`,
  ].filter((l) => l !== null).join('\n');
}

export async function submitComplaint(body, meta = {}) {
  const c = validateComplaint(body);
  const [info, cfg, db] = await Promise.all([getRestaurantInfo(), getConfig(), getDb()]);

  let docRef = null;
  if (db) {
    try {
      docRef = await db.collection('complaints').add({
        ...c, topicLabel: TOPICS[c.topic], status: 'yangi', telegramSent: false,
        userAgent: clean(meta.userAgent, 200), createdAt: new Date(),
      });
    } catch (e) {
      console.error('[complaint] Firestore:', e.message);
    }
  }

  let sent = false;
  if (telegramConfigured(cfg)) {
    try {
      await sendTelegram(cfg, telegramText(c, docRef?.id, info.name));
      sent = true;
      if (docRef) await docRef.update({ telegramSent: true }).catch(() => {});
    } catch (e) {
      console.error('[complaint] Telegram:', e.message);
    }
  }

  if (!sent && !docRef) throw new AppError(502, 'Shikoyatni hozir yuborib bo‘lmadi. Iltimos, birozdan so‘ng qayta urinib ko‘ring.');
  return { id: docRef?.id || null };
}

/* ───────── Admin ───────── */
const iso = (v) => (v?.toDate ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null)?.toISOString() || '';

export async function listComplaints() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  const snap = await db.collection('complaints').orderBy('createdAt', 'desc').limit(300).get();
  return snap.docs.map((d) => {
    const c = d.data();
    return {
      id: d.id, name: c.name || '', phone: c.phone || '', topic: c.topicLabel || TOPICS[c.topic] || '',
      visitDate: c.visitDate || '', message: c.message || '', status: STATUSES[c.status] ? c.status : 'yangi',
      note: c.note || '', telegramSent: Boolean(c.telegramSent), createdAt: iso(c.createdAt),
    };
  });
}

export async function updateComplaint(id, body, email) {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  const ref = db.collection('complaints').doc(id);
  if (!(await ref.get()).exists) throw new AppError(404, 'Shikoyat topilmadi.');
  const patch = { updatedAt: new Date(), updatedBy: email };
  if (body.status !== undefined) {
    if (!STATUSES[body.status]) throw new AppError(400, 'Holat noto‘g‘ri.');
    patch.status = body.status;
  }
  if (body.note !== undefined) patch.note = text(body.note, 1000);
  await ref.update(patch);
  return { id, status: patch.status, note: patch.note };
}

export async function countNewComplaints() {
  try {
    return (await listComplaints()).filter((c) => c.status === 'yangi').length;
  } catch {
    return null;
  }
}

