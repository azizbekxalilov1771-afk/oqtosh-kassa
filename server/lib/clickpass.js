import crypto from 'node:crypto';
import { AppError, env } from './env.js';
import { getConfig } from './config.js';

// Click Pass: mijoz Click ilovasidagi QR'ni ko'rsatadi, kassa skaneri o'qiydi → server to'lovni yechadi.
// docs.click.uz → CLICK Pass:  POST {base}/click_pass/payment  { service_id, otp_data, amount, transaction_id }
//   Auth: merchant_user_id:sha1(timestamp + secret_key):timestamp   (timestamp — 10 xonali UNIX soniya)
//   payment_status: 0 — yaratildi, 1 — jarayonda, 2 — muvaffaqiyatli; error_code < 0 — xato (error_note)
//   holat: GET {base}/payment/status/:service_id/:payment_id;  tasdiqlash rejimi: POST {base}/click_pass/confirm
// Kalitlar — admin → To'lovlar → Click (Service ID, Merchant user ID, Secret key); summani faqat server hisoblaydi.

const BASE = () => env('CLICK_API_URL', 'https://api.click.uz/v2/merchant').replace(/\/+$/, '');
export const clickPassReady = (cfg) => Boolean(cfg.clickServiceId && cfg.clickMerchantUserId && cfg.clickSecretKey);

export function clickAuth(cfg, ts = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHash('sha1').update(`${ts}${cfg.clickSecretKey}`).digest('hex');
  return `${cfg.clickMerchantUserId}:${digest}:${ts}`;
}

async function call(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE()}${path}`, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Auth: clickAuth(cfg) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError(504, 'Click javob bermadi. Internetni tekshiring va qayta skanerlang.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error_code === undefined) throw new AppError(502, `Click xatosi (${res.status}).`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failed = (d) => typeof d.error_code !== 'number' || d.error_code < 0;

export async function clickPassCharge({ otp, amount, txId }) {
  const cfg = await getConfig();
  if (!clickPassReady(cfg)) throw new AppError(400, 'Click Pass sozlanmagan: admin → To‘lovlar → Click (Service ID, Merchant user ID, Secret key).');
  const otpData = String(otp || '').trim();
  if (otpData.length < 6 || otpData.length > 512 || /[\s<>"']/.test(otpData)) throw new AppError(400, 'QR kod o‘qilmadi. Mijoz ilovasidagi QR’ni qayta skanerlang.');
  const sum = Math.round(Number(amount));
  if (!(sum > 0)) throw new AppError(400, 'To‘lov summasi noto‘g‘ri.');
  const sid = Number(cfg.clickServiceId);
  const r = await call(cfg, 'POST', '/click_pass/payment', { service_id: sid, otp_data: otpData, amount: sum, transaction_id: String(txId || '').slice(0, 60) });
  if (failed(r)) throw new AppError(402, `Click: ${r.error_note || 'to‘lov o‘tmadi'}`);
  const pid = r.payment_id;
  if (r.confirm_mode) {
    const c = await call(cfg, 'POST', '/click_pass/confirm', { service_id: sid, payment_id: pid });
    if (failed(c)) throw new AppError(402, `Click: ${c.error_note || 'to‘lov tasdiqlanmadi'}`);
  }
  let status = r.payment_status;
  for (let i = 0; status !== 2 && i < 12; i++) {
    await sleep(Number(env('CLICK_POLL_MS', '1500')));
    const s = await call(cfg, 'GET', `/payment/status/${sid}/${pid}`);
    if (failed(s)) throw new AppError(402, `Click: ${s.error_note || 'to‘lov bekor qilindi'}`);
    status = s.payment_status;
  }
  if (status !== 2) throw new AppError(402, 'Click to‘lovi tasdiqlanmadi (kutish tugadi). Mijoz ilovasini tekshiring.');
  return { provider: 'click', paymentId: String(pid), amount: sum, card: String(r.card_number || '').slice(-8), atMs: Date.now() };
}

// Kassa to'lovi (stol hisobi yoki yetkazish buyurtmasi) — Click Pass bilan.
//   pending — avval yechilgan, lekin hisob yopilmay qolgan to'lov (smena xatosi, internet uzildi…):
//   qayta yopishda pul ikkinchi marta yechilmaydi; boshqa to'lov turi bilan yopib bo'lmaydi (mijoz ikki marta to'lamasin).
const sum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export async function takeQrPayment({ rawPayment, payment, pending, txId, savePending }) {
  if (!payment) return payment;
  const needKind = async () => {
    const { getPayments } = await import('./payments.js');
    return (await getPayments()).find((m) => m.key === payment.method)?.kind;
  };
  if (pending?.provider === 'click') {
    if ((await needKind()) !== 'click') throw new AppError(409, `Bu hisobdan Click orqali ${sum(pending.amount)} so‘m allaqachon yechilgan. To‘lov turini Click qilib yoping — pul qayta yechilmaydi.`);
    if (pending.amount !== payment.amount) throw new AppError(409, `Click orqali ${sum(pending.amount)} so‘m yechilgan, hisob esa endi ${sum(payment.amount)} so‘m. Farqni alohida oling yoki Click kabinetida qaytaring.`);
    return { ...payment, ref: pending, label: `${payment.label} (QR)` };
  }
  if (!rawPayment?.qr) return payment;
  if ((await needKind()) !== 'click') throw new AppError(400, 'QR skaner faqat Click to‘lovi uchun.');
  const ref = await clickPassCharge({ otp: rawPayment.qr, amount: payment.amount, txId });
  await savePending(ref);
  return { ...payment, ref, label: `${payment.label} (QR)` };
}
