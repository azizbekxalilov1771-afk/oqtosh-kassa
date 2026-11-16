import crypto from 'node:crypto';
import { env } from './env.js';
import { getDb } from './firebase.js';

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Shikoyatlar Telegram'ga ketadimi: shikoyatlar boti (yoki asosiy bot) va chat ID bor
export function telegramConfigured(cfg) {
  return Boolean((cfg.telegramComplaintsBotToken || cfg.telegramBotToken) && cfg.telegramChatId);
}

function apiUrl(cfg, method) {
  const base = env('TELEGRAM_API_URL', 'https://api.telegram.org').replace(/\/+$/, '');
  return `${base}/bot${cfg.telegramBotToken}/${method}`;
}

// Uchta bot ishlatilishi mumkin:
//   telegramBotToken           — asosiy bot: yangi buyurtmalar xabari (ofitsiantlar chati)
//   telegramComplaintsBotToken — shikoyatlar boti: saytdan kelgan shikoyatlar (bo'sh bo'lsa — asosiy bot)
//   telegramLoginBotToken      — mijozlar kirishi (verifikatsiya) va mijozga keladigan xabarlar (bo'sh bo'lsa — asosiy bot)
export const loginBot = (cfg) => ({ ...cfg, telegramBotToken: cfg.telegramLoginBotToken || cfg.telegramBotToken });
export const complaintsBot = (cfg) => ({ ...cfg, telegramBotToken: cfg.telegramComplaintsBotToken || cfg.telegramBotToken });

export class TelegramError extends Error {
  constructor(method, status, description) {
    super(`Telegram ${method}: ${description || status}`);
    Object.assign(this, { status, description: description || '' });
  }
}

// Bot API chaqiruvi
export async function tgCall(cfg, method, body = {}, timeoutMs = 8000) {
  if (!cfg.telegramBotToken) throw new Error('Telegram bot tokeni kiritilmagan');
  const res = await fetch(apiUrl(cfg, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new TelegramError(method, data.error_code || res.status, data.description);
  return data.result;
}

export const sendMessage = (cfg, chatId, html, extra = {}) =>
  tgCall(cfg, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// Bir nechta chatga (vergul bilan): 123456,-100987654
async function sendToMany(cfg, idsString, html) {
  const chatIds = String(idsString || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!chatIds.length) throw new Error('Telegram chat ID kiritilmagan');
  const results = await Promise.allSettled(chatIds.map((id) => sendMessage(cfg, id, html)));
  const failed = results.filter((r) => r.status === 'rejected');
  failed.forEach((r) => console.error('[telegram]', r.reason.message));
  if (failed.length === results.length) throw new Error(failed[0].reason.message);
  return { sent: results.length - failed.length, failed: failed.map((r) => r.reason.message) };
}

// Shikoyatlar chati
// Shikoyatlar chati — shikoyatlar boti orqali
export async function sendTelegram(cfg, html) {
  const bot = complaintsBot(cfg);
  if (!bot.telegramBotToken) throw new Error('Telegram bot tokeni kiritilmagan');
  if (!bot.telegramChatId) throw new Error('Shikoyatlar uchun chat ID kiritilmagan');
  return sendToMany(bot, bot.telegramChatId, html);
}

// Buyurtmalar chati (bo'lmasa — hech narsa yuborilmaydi)
export async function sendOrdersChat(cfg, html) {
  if (!cfg.telegramBotToken || !cfg.telegramOrdersChatId) return { sent: 0, failed: [] };
  return sendToMany(cfg, cfg.telegramOrdersChatId, html);
}

/* ───────── Bot ma'lumoti ───────── */
const botCache = new Map();
export async function getBotInfo(cfg) {
  const hit = botCache.get(cfg.telegramBotToken);
  if (hit && Date.now() < hit.until) return hit.info;
  const info = await tgCall(cfg, 'getMe');
  botCache.set(cfg.telegramBotToken, { info, until: Date.now() + 60 * 60_000 });
  return info;
}

// Webhook so'rovi haqiqatan Telegram'dan kelganini tekshirish uchun maxfiy so'z (tokendan olinadi)
export const webhookSecret = (cfg) =>
  crypto.createHash('sha256').update(`oqtosh-webhook:${cfg.telegramBotToken}`).digest('hex').slice(0, 48);

export async function setWebhook(cfg, siteUrl) {
  const url = `${siteUrl.replace(/\/+$/, '')}/api/telegram/webhook`;
  await tgCall(cfg, 'setWebhook', {
    url, secret_token: webhookSecret(cfg), allowed_updates: ['message', 'my_chat_member'], drop_pending_updates: true,
  });
  return url;
}

export const deleteWebhook = (cfg) => tgCall(cfg, 'deleteWebhook', { drop_pending_updates: false });
export const getWebhookInfo = (cfg) => tgCall(cfg, 'getWebhookInfo');

/* ───────── Chatlar ro'yxati (chat ID topish uchun) ───────── */
const chatName = (chat) => chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';

// Webhook ishlayotganda getUpdates ishlamaydi — shuning uchun bot ko'rgan chatlar bazaga yoziladi
export async function rememberChat(chat) {
  const db = await getDb();
  if (!db || !chat?.id) return;
  await db.collection('telegram_chats').doc(String(chat.id))
    .set({ id: String(chat.id), name: chatName(chat).slice(0, 100), type: chat.type || '', lastSeen: new Date() })
    .catch(() => {});
}

// Shikoyatlar boti va asosiy botga yozgan chatlar: qaysi chatga qaysi xabar yuborilishi mumkinligi bilan
export async function findAllChats(cfg) {
  const complaints = complaintsBot(cfg).telegramBotToken;
  const main = cfg.telegramBotToken;
  if (!complaints && !main) throw new Error('Avval bot tokenini kiriting');
  const out = new Map();
  const add = (list, flag) => {
    for (const c of list) out.set(c.id, { ...(out.get(c.id) || { ...c, complaints: false, orders: false }), [flag]: true });
  };
  if (complaints === main) {
    const list = await findChats(cfg);
    add(list, 'complaints');
    add(list, 'orders');
  } else {
    const [a, b] = await Promise.all([findChats(complaintsBot(cfg)), main ? findChats(cfg).catch(() => []) : []]);
    add(a, 'complaints');
    add(b, 'orders');
  }
  return [...out.values()];
}

export async function findChats(cfg) {
  if (!cfg.telegramBotToken) throw new Error('Avval bot tokenini kiriting');
  try {
    const updates = await tgCall(cfg, 'getUpdates', { timeout: 0 });
    const chats = new Map();
    for (const u of updates || []) {
      const chat = (u.message || u.channel_post || u.my_chat_member || u.edited_message)?.chat;
      if (chat) chats.set(String(chat.id), { id: String(chat.id), name: chatName(chat), type: chat.type });
    }
    return [...chats.values()];
  } catch (e) {
    if (e.status !== 409) throw e;
    const db = await getDb(); // webhook ulangan
    if (!db) return [];
    const snap = await db.collection('telegram_chats').orderBy('lastSeen', 'desc').limit(20).get();
    return snap.docs.map((d) => {
      const c = d.data();
      return { id: c.id, name: c.name, type: c.type };
    });
  }
}
