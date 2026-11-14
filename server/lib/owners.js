import { AppError } from './env.js';
import { getFirebaseApp } from './firebase.js';
import { readSetting, writeSetting } from './settings.js';
import { adminEmails, verifyUser } from './auth.js';
import { str } from './validate.js';

// Owner (egasi) hisoblari: faqat hisobotlarni ko'radi (admin-sayt/owner). Admin panel → "Owner kirishi"da qo'shiladi.
// Kirish — Firebase email + parol (admin yaratadi, email tasdiqlangan deb belgilanadi). settings/owners: { list: [{ email, name, addedAtMs }] }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let authProvider = null; // faqat testlar uchun
export function __setOwnerAuth(fake) {
  authProvider = fake;
}
async function fbAuth() {
  if (authProvider) return authProvider;
  const app = await getFirebaseApp();
  if (!app) throw new AppError(503, 'Firebase ulanmagan.');
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(app);
}

export async function listOwners() {
  const s = await readSetting('owners', { list: [] });
  return (s.list || []).map((o) => ({ email: o.email, name: o.name || '', addedAt: o.addedAtMs ? new Date(o.addedAtMs).toISOString() : '' }));
}

export async function isOwnerEmail(email) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  if (adminEmails().includes(e)) return true;
  return (await listOwners()).some((o) => o.email === e);
}

const checkPassword = (p) => {
  const v = String(p || '');
  if (v.length < 8) throw new AppError(400, 'Parol kamida 8 belgi bo‘lsin.');
  if (v.length > 64) throw new AppError(400, 'Parol juda uzun.');
  return v;
};

export async function addOwner({ email, name, password }) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new AppError(400, 'Email noto‘g‘ri yozilgan.');
  const auth = await fbAuth();
  let existed = false;
  try {
    await auth.getUserByEmail(e);
    existed = true;
  } catch (err) {
    if (err?.code && err.code !== 'auth/user-not-found') throw new AppError(502, `Firebase: ${err.message}`);
  }
  if (!existed) {
    const pw = checkPassword(password);
    try {
      await auth.createUser({ email: e, password: pw, emailVerified: true, displayName: str(name, 60) || undefined });
    } catch (err) {
      throw new AppError(502, err?.code === 'auth/operation-not-allowed'
        ? 'Firebase’da email/parol bilan kirish yoqilmagan: Authentication → Sign-in method → Email/Password → Enable.'
        : `Firebase: ${err.message}`);
    }
  }
  const s = await readSetting('owners', { list: [] });
  const list = (s.list || []).filter((o) => o.email !== e);
  list.push({ email: e, name: str(name, 60), addedAtMs: Date.now() });
  await writeSetting('owners', { list: list.slice(-20) });
  return { email: e, existed };
}

export async function setOwnerPassword(email, password) {
  const e = String(email || '').toLowerCase();
  if (!(await listOwners()).some((o) => o.email === e)) throw new AppError(404, 'Owner topilmadi.');
  if (adminEmails().includes(e)) throw new AppError(409, 'Bu admin hisobi — parolini shu yerdan o‘zgartirib bo‘lmaydi.');
  const auth = await fbAuth();
  const u = await auth.getUserByEmail(e).catch(() => null);
  if (!u) throw new AppError(404, 'Firebase’da bu email topilmadi.');
  await auth.updateUser(u.uid, { password: checkPassword(password) });
  return { ok: true };
}

export async function removeOwner(email) {
  const e = String(email || '').toLowerCase();
  const s = await readSetting('owners', { list: [] });
  const list = (s.list || []).filter((o) => o.email !== e);
  await writeSetting('owners', { list });
  // Firebase hisobi o'chirilmaydi (admin bo'lishi yoki boshqa joyda ishlatilishi mumkin) — faqat ruxsat olinadi
  return { ok: true };
}

// Owner sahifasi: admin yoki ro'yxatdagi owner. Email tasdiqlangan bo'lishi shart (admin yaratganda tasdiqlangan bo'ladi).
export async function verifyOwner(request, verifier) {
  const user = await verifyUser(request, verifier);
  const email = String(user.email || '').toLowerCase();
  if (!(await isOwnerEmail(email))) throw new AppError(403, `Bu hisobga (${email || 'email yo‘q'}) Owner sahifasiga ruxsat yo‘q. Admin panel → “Owner kirishi”da qo‘shilishi kerak.`);
  if (!user.email_verified) throw new AppError(403, 'Email tasdiqlanmagan.');
  return { email, uid: user.uid, admin: adminEmails().includes(email) };
}
