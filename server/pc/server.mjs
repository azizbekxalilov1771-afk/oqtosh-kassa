// Oqtosh — server kompyuteri. Oqtosh Kassa dasturi (Windows) ichida alohida jarayon sifatida ishga tushadi:
//   sayt   — 127.0.0.1:8780  → internetda https://oqtoshrestoran.uz        (Cloudflare Tunnel orqali)
//   admin  — 127.0.0.1:8781  → internetda https://admin.oqtoshrestoran.uz  (admin panel, /xodim/ sahifalari)
// Ma'lumotlar Firestore'da emas, shu kompyuter diskida (lib/localdb.js). Netlify va Firebase limitlari yo'q.
// Kod aynan Netlify'dagi bilan bir xil (lib/api.js, lib/admin-api.js) — faqat "server" qismi shu fayl.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = process.env;
E.OQ_DATA_DIR ||= path.join(os.homedir(), 'OqtoshServer', 'data');
E.PUBLIC_SITE_URL ||= 'https://oqtoshrestoran.uz';
E.STAFF_SITE_URL ||= 'https://admin.oqtoshrestoran.uz';
E.TIMEZONE ||= 'Asia/Tashkent';
const BACKUP_DIR = E.OQ_BACKUP_DIR || path.join(path.dirname(E.OQ_DATA_DIR), 'zaxira');
const SITE_PORT = Number(E.OQ_SITE_PORT) || 8780;
const ADMIN_PORT = Number(E.OQ_ADMIN_PORT) || 8781;
const BIND = E.OQ_BIND || '127.0.0.1';
const PUBLIC_URL = E.PUBLIC_SITE_URL.replace(/\/+$/, '');
const STAFF_URL = E.STAFF_SITE_URL.replace(/\/+$/, '');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), ...a);

const { openLocalDb, firebaseConfigured, getFirebaseApp } = await import('../lib/firebase.js');
const { handleApi } = await import('../lib/api.js');
const { createAdminApi } = await import('../lib/admin-api.js');
const { handleLive, liveStats } = await import('../lib/live.js');
const { migrateFromFirestore, migrationState, essentialReady, startFresh } = await import('../lib/migrate.js');
const { writeBackup, listBackups, restoreBackup, sendBackupToTelegram } = await import('../lib/pcbackup.js');
const { getConfig } = await import('../lib/config.js');
const { complaintsBot } = await import('../lib/telegram.js');
const { noteStationIp } = await import('../lib/workplace.js');
const { invalidateLocal } = await import('../lib/pulse.js');

const db = await openLocalDb();
const adminApi = createAdminApi();
let ready = await essentialReady(db);
let publicIp = '';
const counters = { requests: 0, errors: 0, startedAtMs: Date.now() };
const servers = [];

/* ───────── statik fayllar (Netlify qoidalari bilan bir xil) ───────── */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};
const STAFF_PAGES = ['kassa.html', 'ofitsiant.html', 'kuryer.html', 'ombor.html'];
const STAFF_ONLY_JS = ['kassa.js', 'ofitsiant.js', 'kuryer.js', 'ombor.js', 'floor.js', 'posorder.js', 'printagent.js', 'print-tick.js', 'pinlogin.js', 'perms.js'].map((f) => `js/${f}`);
const STAFF_ASSETS = ['styles.css', 'order.css', 'favicon.png', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'logo.jpg'];
const SITE_DIR = path.join(ROOT, 'site/public');
const ADMIN_DIR = path.join(ROOT, 'admin/public');

function parseHeaders(dir) {
  const rules = [];
  let cur = null;
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, '_headers'), 'utf8');
  } catch {
    return rules;
  }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { pattern: raw.trim(), headers: {} };
      rules.push(cur);
      continue;
    }
    const m = /^\s+([\w-]+):\s*(.+)$/.exec(raw);
    if (m && cur) cur.headers[m[1]] = m[2].trim();
  }
  return rules;
}
const RULES = { site: parseHeaders(SITE_DIR), admin: parseHeaders(ADMIN_DIR) };
const headersFor = (rules, p) => {
  const out = {};
  for (const r of rules) {
    const hit = r.pattern.endsWith('/*') ? p.startsWith(r.pattern.slice(0, -1)) || p === r.pattern.slice(0, -2) : p === r.pattern;
    if (hit) Object.assign(out, r.headers);
  }
  return out;
};

// URL yo'li → { file } | { redirect, status } | null
function resolveStatic(kind, urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  if (kind === 'site') {
    if (STAFF_PAGES.includes(rel)) return { redirect: `${STAFF_URL}/xodim/${rel}`, status: 301 };
    if (STAFF_ONLY_JS.includes(rel)) return null;
    return { dir: SITE_DIR, rel };
  }
  const short = /^(kassa|ofitsiant|kuryer|ombor)(\.html)?$/.exec(rel);
  if (short) return { redirect: `/xodim/${short[1]}.html`, status: 301 };
  if (rel === 'xodim' || rel === 'xodim/') return { redirect: '/xodim/kassa.html', status: 302 };
  if (rel.startsWith('xodim/')) {
    const r = rel.slice(6);
    if (STAFF_PAGES.includes(r) || STAFF_ASSETS.includes(r) || r.startsWith('js/')) return { dir: SITE_DIR, rel: r };
    return null;
  }
  return { dir: ADMIN_DIR, rel };
}

async function serveStatic(kind, req, res, urlPath) {
  const hit = resolveStatic(kind, urlPath);
  if (hit?.redirect) return res.writeHead(hit.status, { Location: hit.redirect, 'Cache-Control': 'no-cache' }).end();
  if (!hit) return notFound(res);
  let file = path.normalize(path.join(hit.dir, hit.rel));
  if (!file.startsWith(hit.dir) || path.basename(file).startsWith('_')) return notFound(res);
  let st = await fs.promises.stat(file).catch(() => null);
  if (st?.isDirectory()) {
    if (!urlPath.endsWith('/')) return res.writeHead(301, { Location: `${urlPath}/`, 'Cache-Control': 'no-cache' }).end();
    file = path.join(file, 'index.html');
    st = await fs.promises.stat(file).catch(() => null);
  } else if (!st && !path.extname(file)) {
    file = `${file}.html`; // Netlify "pretty URL": /menyu → menyu.html
    st = await fs.promises.stat(file).catch(() => null);
  }
  if (!st?.isFile()) return notFound(res);
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    ...headersFor(RULES[kind], urlPath),
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ['.html', '.js', '.css', '.json', '.webmanifest', '.mjs'].includes(ext) ? 'public, max-age=0, must-revalidate' : 'public, max-age=86400',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const PAGE = (title, text) => `<!doctype html><html lang="uz"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f3ede2;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#a49d92;margin:0}</style>
<div><h1>${title}</h1><p>${text}</p></div></html>`;
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(PAGE('Sahifa topilmadi', 'Manzilni tekshiring yoki bosh sahifaga qayting.'));
}
function maintenance(res, api) {
  const text = 'Tizim yangi serverga ko‘chirilmoqda. Bir ozdan keyin qayta urinib ko‘ring.';
  if (api) return res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '120', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: text, maintenance: true }));
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '120', 'Cache-Control': 'no-store' }).end(PAGE('Oqtosh — texnik ishlar', text));
}

/* ───────── so'rovlar ───────── */
const isLoop = (a) => /^(::1|127\.|::ffff:127\.)/.test(String(a || ''));

function requestInfo(req, port) {
  const loop = isLoop(req.socket.remoteAddress);
  const cfIp = loop ? String(req.headers['cf-connecting-ip'] || '').trim() : '';
  const viaCf = Boolean(cfIp);
  const proto = viaCf && (req.headers['x-forwarded-proto'] === 'https' || /https/.test(String(req.headers['cf-visitor'] || ''))) ? 'https' : 'http';
  let host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`).split(',')[0].trim();
  if (viaCf && /^(127\.|localhost|\[::1\])/.test(host)) host = new URL(port === ADMIN_PORT ? STAFF_URL : PUBLIC_URL).host;
  // shu kompyuterning o'zi (kassa oynasi, printer dasturi) — restoran tarmog'i hisoblanadi
  const ip = viaCf ? cfIp : loop ? publicIp || '127.0.0.1' : String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return { viaCf, proto, host, ip };
}

function toRequest(req, info) {
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'host' || k.startsWith(':')) continue;
    for (const one of [].concat(v)) headers.append(k, one);
  }
  headers.set('host', info.host);
  return new Request(`${info.proto}://${info.host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function sendResponse(req, res, response) {
  const headers = {};
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v;
  });
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (req.method === 'HEAD' || !response.body) return res.end();
  Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
}

function makeServer(kind, port) {
  const server = http.createServer(async (req, res) => {
    counters.requests++;
    res.setHeader('X-Oq-Server', '1'); // Cloudflare "yopiq" sahifasi (Worker) server javobini Cloudflare xatosidan ajratadi
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return res.writeHead(400).end();
    }
    const info = requestInfo(req, port);
    try {
      // http → https, www → asosiy domen (faqat internetdan kelgan so'rovlar)
      if (info.viaCf && (info.proto === 'http' || info.host.startsWith('www.'))) {
        return res.writeHead(301, { Location: `https://${info.host.replace(/^www\./, '')}${req.url}` }).end();
      }
      if (urlPath === '/api/pc/ping') {
        return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, pc: true, ready, kind, version: VERSION }));
      }
      if (urlPath.startsWith('/live/')) return handleLive(req, res, urlPath);
      const api = urlPath.startsWith('/api/') || (kind === 'admin' && urlPath.startsWith('/admin-api/'));
      if (!ready) return maintenance(res, api);
      if (Number(req.headers['content-length'] || 0) > 25 * 1024 * 1024) return res.writeHead(413).end();
      if (api) {
        const request = toRequest(req, info);
        const ctx = { ip: info.ip };
        let response;
        if (kind === 'site') response = await handleApi(request, { ...ctx, scope: 'public' });
        else if (urlPath.startsWith('/admin-api/') || urlPath.startsWith('/api/media/')) response = await adminApi(request, ctx);
        else response = await handleApi(request, { ...ctx, scope: 'staff' });
        return await sendResponse(req, res, response);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
      return await serveStatic(kind, req, res, urlPath);
    } catch (e) {
      counters.errors++;
      warn(`[${kind}] ${req.method} ${urlPath}:`, e?.stack || e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Server xatosi. Qayta urinib ko‘ring."}');
      else res.destroy();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.on('clientError', (_e, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND, () => resolve(server));
  });
}

/* ───────── fon vazifalari ───────── */
const META = ['_pc', 'backup'];
const readMeta = async () => (await db.collection(META[0]).doc(META[1]).get()).data() || {};
const writeMeta = (patch) => db.collection(META[0]).doc(META[1]).set(patch, { merge: true });

let migrating = null;
function runMigration() {
  if (migrating) return migrating;
  migrating = (async () => {
    if (!firebaseConfigured()) return migrationState(db);
    const st = await migrateFromFirestore(db, {
      onProgress: (p) => {
        process.send?.({ type: 'migration', ...p });
      },
    });
    if (!ready && (await essentialReady(db))) {
      ready = true;
      invalidateLocal();
      log('[ko‘chirish] zarur ma’lumotlar ko‘chirildi — server ishga tushdi');
    }
    if (st.lastError) warn('[ko‘chirish]', st.lastError);
    else if (st.phase === 'done') log(`[ko‘chirish] tugadi: ${st.docs} hujjat`);
    return st;
  })().finally(() => {
    migrating = null;
  });
  return migrating;
}

async function localBackup(reason) {
  const r = writeBackup(db, BACKUP_DIR, { reason });
  await writeMeta({ lastLocalAtMs: Date.now(), lastLocalFile: r.file, lastLocalSize: r.size, lastError: '' });
  log(`[zaxira] ${path.basename(r.file)} (${Math.round(r.size / 1024)} KB)`);
  return r;
}

async function telegramBackup() {
  const cfg = complaintsBot(await getConfig());
  const r = await sendBackupToTelegram(db, { token: cfg.telegramBotToken, chatId: cfg.telegramChatId });
  await writeMeta({ lastTelegramAtMs: Date.now(), lastTelegramError: '' });
  log(`[zaxira] Telegram'ga yuborildi (${Math.round(r.size / 1024)} KB${r.light ? ', rasmlarsiz' : ''})`);
  return r;
}

async function backupTick() {
  if (!ready) return;
  const m = await readMeta();
  const now = Date.now();
  try {
    if (now - (m.lastLocalAtMs || 0) > 3 * 3600_000) await localBackup('avto');
  } catch (e) {
    await writeMeta({ lastError: String(e.message).slice(0, 200), lastErrorAtMs: now });
    warn('[zaxira]', e.message);
  }
  if (now - (m.lastTelegramAtMs || 0) > 20 * 3600_000 && now - (m.lastTelegramTryMs || 0) > 3600_000) {
    await writeMeta({ lastTelegramTryMs: now });
    await telegramBackup().catch(async (e) => {
      await writeMeta({ lastTelegramError: String(e.message).slice(0, 200) });
      warn('[zaxira] Telegram:', e.message);
    });
  }
}

// Mison zaxirasi (menyu, stollar, rasmlar) — Netlify'dagi soatlik "zaxira" funksiyasi o'rnida
async function misonTick() {
  if (!ready) return;
  try {
    const { runBackup } = await import('../lib/backup.js');
    const r = await runBackup({ budgetMs: 60_000 });
    log('[mison-zaxira]', JSON.stringify({ items: r.items, images: `${r.imagesStored}/${r.imagesTotal}`, errors: r.errors?.length || 0 }));
  } catch (e) {
    warn('[mison-zaxira]', e.message);
  }
}

// Restoranning internet manzili (IP): xodimlar "faqat restoran Wi‑Fi'sidan" kirishi uchun avtomatik eslab qolinadi
async function ipTick() {
  try {
    const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) })).text();
    const ip = /^ip=(.+)$/m.exec(t)?.[1]?.trim() || '';
    if (ip) {
      publicIp = ip;
      if (ready) await noteStationIp(ip);
    }
  } catch {}
}

// Admin panel yangi manzildan (admin.oqtoshrestoran.uz) Google bilan kirishi uchun Firebase'da ruxsat
async function ensureAuthDomain() {
  try {
    const app = await getFirebaseApp();
    if (!app?.options?.credential?.getAccessToken) return;
    const { access_token: token } = await app.options.credential.getAccessToken();
    const pid = E.FIREBASE_PROJECT_ID;
    const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${pid}/config`;
    const cur = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })).json();
    const list = cur.authorizedDomains || [];
    const want = [new URL(STAFF_URL).hostname, new URL(PUBLIC_URL).hostname, 'localhost'].filter((h) => !list.includes(h));
    if (!want.length || !Array.isArray(cur.authorizedDomains)) return;
    const r = await fetch(`${url}?updateMask=authorizedDomains`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizedDomains: [...list, ...want] }),
      signal: AbortSignal.timeout(10_000),
    });
    log(r.ok ? `[auth] Firebase'da ruxsat berildi: ${want.join(', ')}` : `[auth] Firebase ruxsat berilmadi (${r.status}) — Authentication → Settings → Authorized domains'ga qo‘lda qo‘shing: ${want.join(', ')}`);
  } catch (e) {
    warn('[auth]', e.message);
  }
}

async function status() {
  const m = await readMeta().catch(() => ({}));
  return {
    type: 'status', ready, version: VERSION, pid: process.pid, uptimeS: Math.round(process.uptime()), memMb: Math.round(process.memoryUsage().rss / 1048576),
    ports: { site: SITE_PORT, admin: ADMIN_PORT }, urls: { site: PUBLIC_URL, admin: STAFF_URL }, publicIp,
    db: db.summary(), live: liveStats(), requests: counters.requests, errors: counters.errors,
    migration: await migrationState(db).catch(() => null), backups: { ...m, dir: BACKUP_DIR, count: listBackups(BACKUP_DIR).length }, firebase: firebaseConfigured(),
  };
}

/* ───────── boshqaruv (Oqtosh Kassa dasturidan, IPC) ───────── */
let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  log('[server] to‘xtatilmoqda…');
  for (const s of servers) {
    s.close();
    s.closeAllConnections?.();
  }
  try {
    const m = await readMeta();
    if (ready && Date.now() - (m.lastLocalAtMs || 0) > 30 * 60_000) await localBackup('yopilish');
  } catch (e) {
    warn('[zaxira]', e.message);
  }
  try {
    db.close();
  } catch (e) {
    warn('[baza]', e.message);
  }
  process.exit(code);
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const reply = (ok, result) => process.send?.({ type: 'reply', id: msg.id, ok, ...(ok ? { result } : { error: String(result?.message || result) }) });
  try {
    if (msg.type === 'stop') return shutdown(0);
    if (msg.type === 'status') return reply(true, await status());
    if (msg.type === 'migrate') return reply(true, await runMigration());
    if (msg.type === 'fresh') {
      const st = await startFresh(db);
      ready = await essentialReady(db);
      return reply(true, st);
    }
    if (msg.type === 'backup') return reply(true, await localBackup('qo‘lda'));
    if (msg.type === 'backup-telegram') return reply(true, await telegramBackup());
    if (msg.type === 'restore') {
      const r = restoreBackup(db, fs.readFileSync(String(msg.file)), BACKUP_DIR);
      ready = await essentialReady(db);
      invalidateLocal();
      log(`[zaxira] tiklandi: ${r.docs} hujjat (${r.at})`);
      return reply(true, r);
    }
    reply(false, 'nomaʼlum buyruq');
  } catch (e) {
    reply(false, e);
  }
});
process.on('disconnect', () => shutdown(0)); // dastur yopildi
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('unhandledRejection', (e) => warn('[unhandled]', e?.stack || e));
process.on('uncaughtException', (e) => {
  warn('[xato]', e?.stack || e);
  shutdown(1);
});

/* ───────── ishga tushirish ───────── */
try {
  servers.push(await makeServer('site', SITE_PORT), await makeServer('admin', ADMIN_PORT));
} catch (e) {
  warn(`[server] port band: ${e.message}`);
  process.send?.({ type: 'fatal', error: `Port band (${SITE_PORT}/${ADMIN_PORT}): ${e.message}` });
  db.close();
  process.exit(2);
}
log(`[server] Oqtosh ${VERSION}: sayt http://${BIND}:${SITE_PORT} · admin http://${BIND}:${ADMIN_PORT} · ma’lumotlar ${E.OQ_DATA_DIR} · ${ready ? 'tayyor' : 'ko‘chirish kutilmoqda'}`);
process.send?.({ type: 'started', ports: { site: SITE_PORT, admin: ADMIN_PORT } });

const every = (ms, fn) => setInterval(() => fn().catch?.(() => {}), ms).unref();
ipTick();
ensureAuthDomain();
if (!ready || (await migrationState(db)).phase === 'history') runMigration();
every(10 * 60_000, async () => {
  const st = await migrationState(db);
  if (st.phase === 'essential' || st.phase === 'history' || (st.phase === 'none' && firebaseConfigured())) runMigration();
});
setTimeout(() => backupTick().catch(() => {}), 5 * 60_000).unref();
every(30 * 60_000, backupTick);
setTimeout(() => misonTick(), 2 * 60_000).unref();
every(60 * 60_000, misonTick);
every(30 * 60_000, ipTick);
every(15_000, async () => process.send?.(await status()));
