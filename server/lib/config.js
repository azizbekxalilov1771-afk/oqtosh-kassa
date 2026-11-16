import { env, AppError } from './env.js';
import { getDb } from './firebase.js';
import { encrypt, decrypt } from './crypto.js';

// Ulanish sozlamalari: admin panel (Firestore settings/integrations) → .env → standart qiymat.
// Maxfiy maydonlar shifrlanadi va admin panelga hech qachon to'liq qaytarilmaydi.

export const FIELDS = {
  // 'mison' — Mison bilan ishlash; 'own' — Misonsiz: o'z menyumiz va stollarimiz, Mison'ga hech narsa yuborilmaydi
  posMode: { env: 'POS_MODE', def: 'mison', check: 'posmode' },
  misonApiUrl: { env: 'MISON_API_URL', def: 'https://backend.mison.uz/api/integrations/v1', check: 'url' },
  misonApiKey: { env: 'MISON_API_KEY', secret: true },
  misonPointId: { env: 'MISON_POINT_ID', check: 'pointId' },
  misonOrders: { env: 'MISON_ORDERS', def: 'on', check: 'onoff' },
  misonMenuId: { env: 'MISON_MENU_ID', check: 'param' },
  misonPaymentTypeId: { env: 'MISON_PAYMENT_TYPE_ID', check: 'int' },
  misonPriceDivisor: { env: 'MISON_PRICE_DIVISOR', def: '1', check: 'number' },
  misonImageBaseUrl: { env: 'MISON_IMAGE_BASE_URL', check: 'url' },
  menuCacheMinutes: { env: 'MENU_CACHE_MINUTES', def: '30', check: 'number' },
  misonWebhookSecret: { env: 'MISON_WEBHOOK_SECRET', secret: true },
  groqApiKey: { env: 'GROQ_API_KEY', secret: true },
  groqModel: { env: 'GROQ_MODEL', def: 'openai/gpt-oss-120b' },
  groqFallbackModel: { env: 'GROQ_FALLBACK_MODEL', def: 'llama-3.3-70b-versatile' },
  telegramBotToken: { env: 'TELEGRAM_BOT_TOKEN', secret: true },
  telegramLoginBotToken: { env: 'TELEGRAM_LOGIN_BOT_TOKEN', secret: true },
  telegramComplaintsBotToken: { env: 'TELEGRAM_COMPLAINTS_BOT_TOKEN', secret: true },
  telegramChatId: { env: 'TELEGRAM_CHAT_ID', check: 'chatId' },
  telegramOrdersChatId: { env: 'TELEGRAM_ORDERS_CHAT_ID', check: 'chatId' },
  // To'lov tizimlari (admin panel → To'lovlar). Onlayn tasdiqlash shu kalitlar bilan ulanadi.
  clickServiceId: { env: 'CLICK_SERVICE_ID', check: 'int' },
  clickMerchantId: { env: 'CLICK_MERCHANT_ID', check: 'int' },
  clickMerchantUserId: { env: 'CLICK_MERCHANT_USER_ID', check: 'int' },
  clickSecretKey: { env: 'CLICK_SECRET_KEY', secret: true },
  paymeMerchantId: { env: 'PAYME_MERCHANT_ID', check: 'param' },
  paymeKey: { env: 'PAYME_KEY', secret: true },
  paymeTestKey: { env: 'PAYME_TEST_KEY', secret: true },
  uzumTerminalId: { env: 'UZUM_TERMINAL_ID', check: 'param' },
  uzumApiKey: { env: 'UZUM_API_KEY', secret: true },
};

const REF = ['settings', 'integrations'];
let mem = { data: null, until: 0 };

async function readStored() {
  const db = await getDb();
  if (!db) return {};
  try {
    const snap = await db.collection(REF[0]).doc(REF[1]).get();
    return snap.exists ? snap.data() || {} : {};
  } catch (e) {
    console.error('[config] Firestore:', e.message);
    return {};
  }
}

function resolve(stored) {
  const cfg = {};
  const meta = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    let value = '';
    let source = '';
    let broken = false;
    const s = stored[k];
    if (f.secret && s && typeof s === 'object') {
      const d = decrypt(s);
      if (d) [value, source] = [d, 'admin'];
      else broken = true;
    } else if (!f.secret && typeof s === 'string' && s !== '') {
      [value, source] = [s, 'admin'];
    }
    if (!value && env(f.env)) [value, source] = [env(f.env), 'env'];
    if (!value && f.def) [value, source] = [f.def, 'default'];
    cfg[k] = value;
    meta[k] = { source, broken };
  }
  return { cfg, meta };
}

export async function getConfig() {
  if (mem.data && Date.now() < mem.until) return mem.data;
  const { cfg } = resolve(await readStored());
  mem = { data: cfg, until: Date.now() + 60_000 };
  return cfg;
}

export function clearConfigCache() {
  mem = { data: null, until: 0 };
}

// Admin panel uchun: maxfiy qiymatlar faqat oxirgi 4 belgisi bilan
export async function getConfigForAdmin() {
  const { cfg, meta } = resolve(await readStored());
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    out[k] = f.secret
      ? { secret: true, set: Boolean(cfg[k]), hint: cfg[k] ? `••••${cfg[k].slice(-4)}` : '', source: meta[k].source, broken: meta[k].broken }
      : { value: cfg[k], source: meta[k].source };
  }
  return out;
}

function check(k, f, v) {
  const fail = (msg) => { throw new AppError(400, msg); };
  if (v.length > 500) fail('Qiymat juda uzun.');
  if (f.check === 'url' && v && !/^https?:\/\/[^\s]+$/i.test(v)) fail('Manzil https:// bilan boshlansin.');
  if (f.check === 'number' && v && !(Number(v) > 0 && Number(v) <= 100000)) fail('Musbat son kiriting.');
  if (f.check === 'pointId' && v && !/^[\w-]{1,64}$/.test(v)) fail('Filial ID: "Tekshirish" ro‘yxatidan tanlang.');
  if (f.check === 'int' && v && !/^\d{1,9}$/.test(v)) fail('Faqat raqam kiriting.');
  if (f.check === 'onoff' && v && !['on', 'off'].includes(v)) fail('Qiymat: on yoki off.');
  if (f.check === 'posmode' && v && !['mison', 'own'].includes(v)) fail('Rejim: mison yoki own.');
  if (f.check === 'param' && v && !/^[\w.-]{1,60}$/.test(v)) fail('Parametr nomi noto‘g‘ri.');
  if (f.check === 'chatId' && v && !/^(-?\d{3,20}|@\w{3,40})(\s*,\s*(-?\d{3,20}|@\w{3,40}))*$/.test(v)) fail('Chat ID: raqamlar, vergul bilan ajratib.');
  if (f.secret && /\s/.test(v)) fail('Kalitda bo‘sh joy bo‘lmasligi kerak.');
  return v;
}

// patch: { maydon: "yangi qiymat" }. Maxfiy maydon: bo'sh — o'zgarmaydi, null — o'chiriladi.
// Oddiy maydon: bo'sh satr — admin qiymati o'chadi (.env yoki standart qiymat ishlaydi).
export async function saveIntegrations(patch) {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan — kalitlarni saqlab bo‘lmaydi.');
  const update = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const f = FIELDS[k];
    if (!f) continue;
    if (f.secret) {
      if (v === null) update[k] = null;
      else if (typeof v === 'string' && v.trim()) update[k] = encrypt(check(k, f, v.trim()));
    } else {
      update[k] = check(k, f, typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
    }
  }
  if (Object.keys(update).length) await db.collection(REF[0]).doc(REF[1]).set(update, { merge: true });
  clearConfigCache();
  return Object.keys(update);
}

// Saqlanmagan qiymatlarni sinab ko'rish uchun: bo'sh bo'lmaganlari ustidan yoziladi
export async function configWithOverrides(overrides = {}) {
  const cfg = { ...(await getConfig()) };
  for (const [k, v] of Object.entries(overrides)) {
    if (FIELDS[k] && typeof v === 'string' && v.trim()) cfg[k] = v.trim();
  }
  return cfg;
}

// Xodim sahifalari (kassa, ofitsiant, kuryer) admin saytida: <admin>/xodim/kassa.html
export const staffSiteUrl = () => String(env('STAFF_SITE_URL') || env('ADMIN_SITE_URL') || 'https://oqtoshrestoran-admin.netlify.app').replace(/\/+$/, '');
