// Firebase Authentication (Google hisobi yoki email + parol) va admin API'ga so'rovlar.
// Firebase web config ochiq ma'lumot — u serverdagi /admin-api/config'dan olinadi.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendEmailVerification, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const cfg = await fetch('/admin-api/config').then((r) => r.json()).catch(() => ({ ready: false }));

export const setupProblem = cfg.ready
  ? ''
  : 'Admin sayt hali sozlanmagan. Netlify (yoki .env) da FIREBASE_WEB_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY va ADMIN_EMAILS ni kiriting.';

let auth = null;
if (cfg.ready) {
  auth = getAuth(initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId }));
  auth.languageCode = 'uz';
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Email yoki parol noto‘g‘ri.',
  'auth/wrong-password': 'Email yoki parol noto‘g‘ri.',
  'auth/user-not-found': 'Email yoki parol noto‘g‘ri.',
  'auth/invalid-email': 'Email manzil noto‘g‘ri yozilgan.',
  'auth/too-many-requests': 'Juda ko‘p urinish. Bir necha daqiqadan so‘ng qayta urinib ko‘ring.',
  'auth/network-request-failed': 'Internet aloqasi yo‘q.',
  'auth/user-disabled': 'Bu hisob o‘chirilgan.',
  'auth/missing-email': 'Emailni kiriting.',
  'auth/operation-not-allowed': 'Firebase’da Google orqali kirish yoqilmagan: Authentication → Sign-in method → Google → Enable.',
  'auth/unauthorized-domain': `Bu manzil (${location.hostname}) Firebase’da ruxsat etilmagan: Authentication → Settings → Authorized domains’ga qo‘shing.`,
  'auth/admin-restricted-operation': 'Bu Google hisob Firebase’da ro‘yxatdan o‘tmagan. Authentication → Users’da shu email bo‘lishi kerak.',
  'auth/account-exists-with-different-credential': 'Bu email boshqa usul bilan ro‘yxatdan o‘tgan — email va parol bilan kiring.',
  'auth/popup-blocked': 'Brauzer Google oynasini to‘sib qo‘ydi. Qayta bosing.',
};
// Foydalanuvchi o'zi yopgan Google oynasi — xato emas
export const isCancelled = (e) => ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'].includes(e?.code);
export const authMessage = (e) => AUTH_ERRORS[e?.code] || e?.message || 'Xatolik yuz berdi.';

export const currentEmail = () => auth?.currentUser?.email || '';
export const watchUser = (cb) => (auth ? onAuthStateChanged(auth, cb) : cb(null));
export const login = (email, password) => signInWithEmailAndPassword(auth, email.trim(), password);
export const logout = () => auth && signOut(auth);

// Google hisobi bilan kirish: avval oyna (popup), brauzer ruxsat bermasa — sahifani yo'naltirish
export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e?.code)) return signInWithRedirect(auth, provider);
    throw e;
  }
}
// Yo'naltirish orqali kirishdan qaytganda xato bo'lsa, kirish ekranida ko'rsatiladi
export const redirectError = auth ? getRedirectResult(auth).then(() => null, (e) => e) : Promise.resolve(null);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email.trim());
export const sendVerify = () => sendEmailVerification(auth.currentUser);
export async function refreshUser() {
  await auth.currentUser.reload();
  await auth.currentUser.getIdToken(true);
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    Object.assign(this, { status, code });
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = await auth?.currentUser?.getIdToken();
  const res = await fetch(`/admin-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token || ''}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error || `Xatolik (${res.status})`, res.status, data.code);
    if (res.status === 401) window.dispatchEvent(new CustomEvent('admin:unauthorized'));
    throw err;
  }
  return data;
}
