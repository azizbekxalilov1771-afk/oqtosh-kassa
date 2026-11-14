import { getConfig } from './config.js';
import { getRestaurantInfo } from './info.js';
import { sendMessage, rememberChat, escapeHtml, loginBot } from './telegram.js';
import { upsertFromTelegram, updateCustomer, normalizePhone } from './customers.js';
import { attachTelegram, issueCode, loginStatus } from './login.js';

// Verifikatsiya boti: webhook (Netlify) yoki lokal polling (npm run dev, TELEGRAM_POLLING=true) shu funksiyani chaqiradi.

const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

async function sendCode(cfg, chatId, code, name) {
  await sendMessage(cfg, chatId,
    `🔐 Kirish kodi: <b>${code}</b>\n\n${escapeHtml(name)} saytidagi maydonga shu kodni kiriting. Kod 10 daqiqa amal qiladi.\n\nKodni hech kimga bermang — restoran xodimlari ham uni so‘ramaydi.`,
    { reply_markup: { remove_keyboard: true } });
}

export async function handleTelegramUpdate(update, { siteUrl = '' } = {}) {
  if (update.my_chat_member) return rememberChat(update.my_chat_member.chat);
  const msg = update.message;
  if (!msg?.chat) return;
  await rememberChat(msg.chat);
  if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return; // guruhlarda bot jim turadi

  const cfg = loginBot(await getConfig()); // mijozlar bilan verifikatsiya boti gaplashadi
  const info = await getRestaurantInfo();
  const chatId = msg.chat.id;
  const orderUrl = siteUrl ? `${siteUrl.replace(/\/+$/, '')}/buyurtma.html` : '';
  const customer = await upsertFromTelegram(msg.from);

  // Telefon raqami yuborildi
  if (msg.contact) {
    if (String(msg.contact.user_id || '') !== String(msg.from.id)) {
      return sendMessage(cfg, chatId, 'Iltimos, pastdagi tugma orqali <b>o‘zingizning</b> raqamingizni yuboring.', { reply_markup: CONTACT_KEYBOARD });
    }
    const phone = normalizePhone(msg.contact.phone_number);
    const pending = customer.pendingLogin;
    await updateCustomer(customer.id, { phone, pendingLogin: '' });
    if (pending && ['contact', 'pending'].includes(await loginStatus(pending))) {
      return sendCode(cfg, chatId, await issueCode(pending), info.name);
    }
    return sendMessage(cfg, chatId, `Raqamingiz saqlandi ✅${orderUrl ? `\nBuyurtma berish: ${orderUrl}` : ''}`, { reply_markup: { remove_keyboard: true } });
  }

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(msg.text || '');
  const param = start?.[1] || '';

  if (param.startsWith('login_')) {
    const id = param.slice(6);
    const result = await attachTelegram(id, customer);
    if (result === 'expired') {
      return sendMessage(cfg, chatId, 'Bu havola eskirgan. Saytda “Telegram orqali kirish” tugmasini qaytadan bosing.');
    }
    if (result === 'contact') {
      await updateCustomer(customer.id, { pendingLogin: id });
      return sendMessage(cfg, chatId,
        `Assalomu alaykum! ${escapeHtml(info.name)} saytida buyurtma berish uchun telefon raqamingizni tasdiqlang — pastdagi tugmani bosing.`,
        { reply_markup: CONTACT_KEYBOARD });
    }
    return sendCode(cfg, chatId, result.code, info.name);
  }

  if (start) {
    return sendMessage(cfg, chatId,
      `Assalomu alaykum! Bu ${escapeHtml(info.name)} boti.${orderUrl ? `\n\nBuyurtma berish uchun saytga kiring:\n${orderUrl}` : ''}`);
  }

  return sendMessage(cfg, chatId,
    `Buyurtma berish uchun saytdagi “Telegram orqali kirish” tugmasini bosing.${orderUrl ? `\n${orderUrl}` : ''}${info.phone ? `\n\nSavollar uchun: ${escapeHtml(info.phone)}` : ''}`);
}
