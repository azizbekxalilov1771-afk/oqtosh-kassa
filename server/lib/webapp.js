import crypto from 'node:crypto';
import { AppError } from './env.js';
import { getConfig } from './config.js';
import { loginBot, tgCall } from './telegram.js';
import { upsertFromTelegram } from './customers.js';

// Telegram mini-ilova (Web App): bot ichida ochiladigan buyurtma sahifasi.
// Telegram sahifaga initData beradi — u bot tokeni bilan imzolangan; server imzoni tekshiradi:
//   secret = HMAC_SHA256(key = "WebAppData", data = bot_token)
//   hash   = hex(HMAC_SHA256(key = secret, data = "key=value\n..." — hash'dan boshqa maydonlar, alifbo tartibida))
// To'g'ri bo'lsa — foydalanuvchi o'sha Telegram hisobi (kod kerak emas). Telefon raqami bo'lmasa,
// mini-ilova "Raqamni ulashish" (requestContact) so'raydi — kontakt botga keladi va profilga yoziladi.

const MAX_AGE_S = 24 * 3600;

export function verifyInitData(initData, botToken, nowS = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams(String(initData || ''));
  const hash = params.get('hash') || '';
  if (!hash || !botToken) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const want = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (want.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || nowS - authDate > MAX_AGE_S || authDate - nowS > 300) return null;
  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {}
  if (!user?.id) return null;
  return { user, authDate };
}

export async function webAppLogin(initData) {
  const cfg = loginBot(await getConfig());
  const v = verifyInitData(initData, cfg.telegramBotToken);
  if (!v) throw new AppError(401, 'Telegram ma’lumoti tasdiqlanmadi. Mini-ilovani bot ichidan qaytadan oching.');
  return upsertFromTelegram(v.user);
}

// Bot pastidagi "Menyu" tugmasi → mini-ilova (sayt https bo'lsa)
export async function setMenuButton(cfg, siteUrl, text = '🍽 Menyu') {
  if (!/^https:\/\//.test(siteUrl || '')) return false;
  await tgCall(cfg, 'setChatMenuButton', { menu_button: { type: 'web_app', text, web_app: { url: `${siteUrl.replace(/\/+$/, '')}/buyurtma.html?tg=1` } } });
  return true;
}
