import { env } from './env.js';

// firebase-admin: Firestore va Auth. Firebase kalitlari ikkala sayt (ommaviy va admin)
// .env / Netlify muhit o'zgaruvchilarida turadi — qolgan barcha kalitlar admin paneldan kiritiladi.

let appPromise = null;
let testDb; // faqat testlar uchun (scripts/test)
let localDb = null;

// Server kompyuteri rejimi: ma'lumotlar Firestore'da emas, shu kompyuter diskida (OQ_DATA_DIR papkasi).
// Firebase faqat Google/email bilan kirishni tekshirish uchun qoladi (bu Firestore limitiga kirmaydi).
export const localMode = () => Boolean(env('OQ_DATA_DIR'));

export function normalizedPrivateKey() {
  return env('FIREBASE_PRIVATE_KEY').replace(/^"|"$/g, '').replace(/\\n/g, '\n').trim();
}

export function firebaseConfigured() {
  return Boolean(env('FIREBASE_PROJECT_ID') && env('FIREBASE_CLIENT_EMAIL') && normalizedPrivateKey());
}

export function getFirebaseApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    if (!firebaseConfigured()) {
      console.warn('[firebase] FIREBASE_* kalitlari to‘ldirilmagan — Firestore o‘chiq');
      return null;
    }
    try {
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      return getApps()[0] || initializeApp({
        credential: cert({
          projectId: env('FIREBASE_PROJECT_ID'),
          clientEmail: env('FIREBASE_CLIENT_EMAIL'),
          privateKey: normalizedPrivateKey(),
        }),
      });
    } catch (e) {
      console.error('[firebase] ulanib bo‘lmadi:', e.message);
      return null;
    }
  })();
  return appPromise;
}

export async function getDb() {
  if (testDb !== undefined) return testDb;
  if (localMode()) return openLocalDb();
  const app = await getFirebaseApp();
  if (!app) return null;
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore(app);
}

export async function openLocalDb() {
  if (!localDb) {
    const { LocalDb } = await import('./localdb.js');
    localDb = localDb || LocalDb.open(env('OQ_DATA_DIR'));
  }
  return localDb;
}
export const currentLocalDb = () => localDb;

// Faqat Firebase'dan bir martalik ko'chirish uchun: haqiqiy Firestore (lokal rejimda ham)
export async function getRemoteFirestore() {
  const app = await getFirebaseApp();
  if (!app) return null;
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore(app);
}

export function __setTestDb(db) {
  testDb = db;
}
