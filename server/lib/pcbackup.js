// Server kompyuteri rejimi: ma'lumotlar bazasining zaxira nusxalari.
//   • Kompyuterning o'zida: <zaxira papkasi>/oqtosh-YYYYMMDD-HHMMSS.oqz — oxirgi 40 tasi saqlanadi
//   • Kuniga bir marta nusxa Telegram'ga (admin chati) — kompyuter yoki disk buzilsa ham tiklab olinadi
// Fayl shifrlangan (AES-256-GCM, kalit — Firebase/SECRETS kalitidan): o'sha kalitlarsiz ochib bo'lmaydi.
// Format: "OQZ1" + iv(12) + tag(16) + gzip(JSON { v, at, cols: { kolleksiya: { id: hujjat } } })

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { env } from './env.js';
import { backupKey } from './crypto.js';

const MAGIC = Buffer.from('OQZ1');
const KEEP = 40;
const TG_LIMIT = 48 * 1024 * 1024;
// Telegram nusxasiga kirmaydi (katta va qayta tiklanadigan): rasmlar Mison'dan qayta olinadi
const HEAVY = ['media_chunks', 'mison_backup_raw'];

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', backupKey(), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 })), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function openBackup(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('Bu Oqtosh zaxira fayli emas.');
  const d = crypto.createDecipheriv('aes-256-gcm', backupKey(), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  let plain;
  try {
    plain = Buffer.concat([d.update(buf.subarray(32)), d.final()]);
  } catch {
    throw new Error('Zaxirani ochib bo‘lmadi: kalitlar boshqa (bu fayl boshqa kalitlar bilan yozilgan).');
  }
  const obj = JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  if (!obj || obj.v !== 1 || typeof obj.cols !== 'object') throw new Error('Zaxira fayli buzilgan.');
  return obj;
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^oqtosh-\d{8}-\d{6}.*\.oqz$/.test(f)).sort().reverse()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: path.join(dir, f), name: f, size: st.size, atMs: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

// Diskka zaxira; eskilari o'chiriladi
export function writeBackup(db, dir, { reason = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date();
  const buf = seal({ v: 1, at: at.toISOString(), reason, cols: db.exportAll() });
  let file = path.join(dir, `oqtosh-${stamp(at)}.oqz`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `oqtosh-${stamp(at)}-${i}.oqz`);
  fs.writeFileSync(`${file}.tmp`, buf);
  fs.renameSync(`${file}.tmp`, file);
  for (const old of listBackups(dir).slice(KEEP)) fs.rmSync(old.file, { force: true });
  return { file, size: buf.length, at: at.toISOString() };
}

// Zaxiradan tiklash: baza aynan zaxiradagi holatga keltiriladi (avval hozirgi holat ham zaxiraga olinadi)
export function restoreBackup(db, buf, backupDir) {
  const obj = openBackup(buf);
  const safety = backupDir ? writeBackup(db, backupDir, { reason: 'tiklashdan-oldin' }) : null;
  let docs = 0;
  const names = new Set(Object.keys(obj.cols));
  for (const col of [...db.store.keys()]) if (!names.has(col)) db.importCollection(col, {}, { replace: true });
  for (const [col, items] of Object.entries(obj.cols)) docs += db.importCollection(col, items, { replace: true });
  db.compact();
  return { docs, collections: names.size, at: obj.at, safety: safety?.file || '' };
}

// Telegram'ga nusxa (hujjat sifatida)
export async function sendBackupToTelegram(db, { token, chatId, siteName = 'Oqtosh' }) {
  if (!token || !chatId) throw new Error('Telegram bot yoki chat ID kiritilmagan');
  let cols = db.exportAll();
  let buf = seal({ v: 1, at: new Date().toISOString(), reason: 'telegram', cols });
  let light = false;
  if (buf.length > TG_LIMIT) {
    cols = db.exportAll({ skip: HEAVY });
    buf = seal({ v: 1, at: new Date().toISOString(), reason: 'telegram-yengil', cols });
    light = true;
  }
  if (buf.length > TG_LIMIT) throw new Error(`Zaxira juda katta (${Math.round(buf.length / 1048576)} MB) — Telegram'ga yuborilmadi`);
  const base = env('TELEGRAM_API_URL', 'https://api.telegram.org').replace(/\/+$/, '');
  const form = new FormData();
  form.append('chat_id', String(chatId).split(',')[0].trim());
  form.append('caption', `🗄 ${siteName}: ma'lumotlar zaxirasi (${new Date().toLocaleString('ru-RU', { timeZone: env('TIMEZONE', 'Asia/Tashkent') })})${light ? ' — rasmlarsiz' : ''}.\nFaqat Oqtosh Kassa dasturi (server kompyuteri) ochadi: Bosh oyna → Server → Zaxiradan tiklash.`);
  form.append('disable_notification', 'true');
  form.append('document', new Blob([buf], { type: 'application/octet-stream' }), `oqtosh-${stamp()}.oqz`);
  const res = await fetch(`${base}/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram: ${data.description || res.status}`);
  return { size: buf.length, light };
}
