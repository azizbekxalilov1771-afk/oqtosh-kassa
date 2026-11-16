import { env, AppError } from './env.js';
import { getFirebaseApp } from './firebase.js';

// Admin kirishi: Firebase Authentication (email + parol). Brauzer ID token yuboradi,
// server uni firebase-admin bilan tekshiradi va email ADMIN_EMAILS ro'yxatida ekanini ko'radi.
// Email tasdiqlangan bo'lishi shart — boshqa odam shu email bilan ro'yxatdan o'tib kira olmaydi.

export async function firebaseVerify(token) {
  const app = await getFirebaseApp();
  if (!app) throw new AppError(503, 'Firebase ulanmagan: FIREBASE_* kalitlarini tekshiring.');
  const { getAuth } = await import('firebase-admin/auth');
  try {
    return await getAuth(app).verifyIdToken(token, true);
  } catch {
    throw new AppError(401, 'Sessiya tugagan. Qaytadan kiring.');
  }
}

export function adminEmails() {
  return env('ADMIN_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Token egasi (admin yoki owner tekshiruvidan oldin)
export async function verifyUser(request, verifier = firebaseVerify) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AppError(401, 'Kirish talab qilinadi.');
  return verifier(token);
}

export async function verifyAdmin(request, verifier = firebaseVerify) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AppError(401, 'Kirish talab qilinadi.');
  const user = await verifier(token);
  const allowed = adminEmails();
  if (!allowed.length) throw new AppError(403, 'ADMIN_EMAILS sozlanmagan — admin saytining muhit o‘zgaruvchilariga emailingizni yozing.');
  const email = String(user.email || '').toLowerCase();
  if (!email || !allowed.includes(email)) throw new AppError(403, `Bu hisobga (${email || 'email yo‘q'}) admin panelga ruxsat yo‘q. .env dagi ADMIN_EMAILS ga shu emailni yozing.`);
  if (!user.email_verified) {
    const e = new AppError(403, 'Email tasdiqlanmagan. Pochtangizga kelgan havolani bosing.');
    e.code = 'unverified';
    throw e;
  }
  return { email, uid: user.uid };
}
