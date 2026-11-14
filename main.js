'use strict';
// Oqtosh Kassa — kompyuter dasturi. Bitta dasturda: Kassa, Ofitsiant, Ombor, Admin panel, Owner hisobotlari
// va ichki printer dasturi (oshxona/kassa cheklari Wi‑Fi va USB printerlarga, oynasiz).
// Sahifalar saytdan yuklanadi — sayt yangilansa dastur ham o'zi yangilanadi (qayta o'rnatish shart emas).
// Ikki rejim:
//   asosiy kompyuter — admin bergan kod bilan ulangan (printer dasturi ishlaydi): Kassa, Admin, Owner, printerlar
//   ofitsiant terminali — ulanmagan kompyuter: faqat Ofitsiant oynasi (omborchi ham shu oynadan PIN bilan kiradi)
// Dasturning o'zi (oyna, printer moduli) GitHub'dagi yangi versiyani o'zi topadi va yangilanadi (electron-updater).

const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, session, safeStorage, Notification, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { Agent, pair, VERSION: AGENT_VERSION } = require('./agent/core');
const { makeRawPrint } = require('./agent/raw-win');
const defaults = require('./config.json');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.setAppUserModelId('uz.oqtoshrestoran.desktop');
const ICON = path.join(__dirname, 'app', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const APP_URL = pathToFileURL(path.join(__dirname, 'app')).href; // faqat shu papkadagi sahifalar "bosh oyna" huquqiga ega
const userDir = app.getPath('userData');
const SETTINGS_FILE = path.join(userDir, 'settings.json');
const KEY_FILE = path.join(userDir, 'agent.key');
const hidden = process.argv.includes('--hidden');

/* ───────── sozlamalar ───────── */
const readJson = (file, fb) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fb;
  }
};
let settings = { site: defaults.site, admin: defaults.admin, autostart: true, startWith: 'home', fullscreen: true, htmlPrinter: '', ...readJson(SETTINGS_FILE, {}) };
function saveSettings() {
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
// Admin sayt boshqa Netlify loyihasiga ko'chgan bo'lsa — kompyuterda saqlangan eski manzil yangisiga almashadi
if ((defaults.oldAdmin || []).map(cleanUrl).includes(cleanUrl(settings.admin))) {
  settings.admin = defaults.admin;
  try {
    saveSettings();
  } catch {}
}
const okUrl = (u) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u);

function loadKey() {
  try {
    const b = fs.readFileSync(KEY_FILE);
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8');
  } catch {
    return '';
  }
}
function saveKey(k) {
  if (!k) return fs.rmSync(KEY_FILE, { force: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(KEY_FILE, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : Buffer.from(k, 'utf8'));
}

/* ───────── xavfsizlik: faqat o'z saytlarimiz ichida ───────── */
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};
// Saytimiz o'zi yo'naltirgan manzillar (masalan oqtosh-sayt.netlify.app → oqtoshrestoran.uz) ham "o'zimizniki":
// aks holda yo'naltirilgan sahifadagi havolalar tashqi brauzerda ochilib ketadi.
const aliases = new Set([defaults.site, defaults.admin, ...(defaults.aliases || [])].map(originOf).filter(Boolean));
const ours = () => [originOf(settings.site), originOf(settings.admin), ...aliases].filter(Boolean);
const isOurs = (u) => ours().includes(originOf(u));
const AUTH_HOST = /(^|\.)(accounts\.google\.com|firebaseapp\.com|googleapis\.com|google\.com|gstatic\.com)$/i;
const EXTERNAL_OK = /^(https?|tg|tel|mailto):/i;
const openOutside = (url) => {
  if (EXTERNAL_OK.test(url)) shell.openExternal(url).catch(() => {});
};

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (AUTH_HOST.test(u.hostname)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, icon: ICON, webPreferences: { contextIsolation: true, sandbox: true } } };
    }
    if (isOurs(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 820, icon: ICON, backgroundColor: '#0b0b0d', webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true } } };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith(APP_URL) || isOurs(url)) return;
    try {
      if (AUTH_HOST.test(new URL(url).hostname)) return;
    } catch {}
    e.preventDefault();
    openOutside(url);
  });
});

/* ───────── oynalar ───────── */
// Xodim sahifalari admin saytida (/xodim/...): mijozlar sayti (oqtoshrestoran.uz) faqat mijozlar uchun
const SECTIONS = {
  kassa: { title: 'Kassa', url: () => `${settings.admin}/xodim/kassa.html`, size: [1366, 860], main: true },
  ofitsiant: { title: 'Ofitsiant', url: () => `${settings.admin}/xodim/ofitsiant.html`, size: [1100, 820] },
  ombor: { title: 'Ombor', url: () => `${settings.admin}/xodim/ombor.html`, size: [1100, 820] },
  kuryer: { title: 'Kuryer', url: () => `${settings.admin}/xodim/kuryer.html`, size: [900, 820], main: true },
  admin: { title: 'Admin panel', url: () => `${settings.admin}/`, size: [1366, 880], main: true },
  owner: { title: 'Owner — hisobotlar', url: () => `${settings.admin}/owner/`, size: [1366, 880], main: true },
};
// Asosiy kompyuter — printer dasturi ulangan (admin bergan kod bilan). Qolganlari — ofitsiant terminali.
const isMain = () => Boolean(loadKey());
const allowed = (name) => Boolean(SECTIONS[name]) && (!SECTIONS[name].main || isMain());
const windows = new Map();
let home = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

function webPrefs() {
  return { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false };
}

function attachOffline(w) {
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || url.startsWith('file:')) return; // -3: foydalanuvchi to'xtatdi
    w.loadFile(path.join(__dirname, 'app', 'offline.html'), { query: { u: url, e: desc || String(code) } });
  });
}

function openSection(name, hash = '') {
  const s = SECTIONS[name];
  if (!s || !allowed(name)) return null;
  const url = s.url() + (hash ? `#${String(hash).replace(/^#/, '')}` : '');
  let w = windows.get(name);
  if (w && !w.isDestroyed()) {
    if (hash) w.loadURL(url);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return w;
  }
  w = new BrowserWindow({ width: s.size[0], height: s.size[1], minWidth: 360, minHeight: 500, title: `Oqtosh — ${s.title}`, icon: ICON, backgroundColor: '#0b0b0d', show: false, autoHideMenuBar: true, webPreferences: webPrefs() });
  windows.set(name, w);
  attachOffline(w);
  w.once('ready-to-show', () => {
    // to'liq ekran (F11 — chiqish/qaytish); o'chirilgan bo'lsa — butun ekranga yoyiladi
    if (settings.fullscreen) w.setFullScreen(true);
    else w.maximize();
    w.show();
  });
  w.on('closed', () => windows.delete(name));
  w.loadURL(url);
  return w;
}

function showHome() {
  if (home && !home.isDestroyed()) {
    if (home.isMinimized()) home.restore();
    home.show();
    home.focus();
    return home;
  }
  home = new BrowserWindow({ width: 1080, height: 760, minWidth: 380, minHeight: 560, title: 'Oqtosh Kassa', icon: ICON, backgroundColor: '#0b0b0d', show: false, autoHideMenuBar: true, webPreferences: webPrefs() });
  home.once('ready-to-show', () => {
    if (settings.fullscreen) home.setFullScreen(true);
    else home.maximize();
    home.show();
  });
  home.on('close', (e) => {
    // printer dasturi ishlab tursa — oyna yopilmaydi, tray'ga yashirinadi
    if (!quitting && agent) {
      e.preventDefault();
      home.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: 'Oqtosh Kassa orqada ishlayapti', body: 'Printerlar cheklarni chiqarishda davom etadi. Ochish — soat yonidagi belgini bosing.', icon: ICON }).show();
      }
    }
  });
  home.on('closed', () => (home = null));
  home.loadFile(path.join(__dirname, 'app', 'home.html'));
  return home;
}

function quit() {
  quitting = true;
  agent?.stop();
  app.quit();
}

function buildMenu() {
  const main = isMain();
  const back = (_i, w) => {
    const h = w?.webContents?.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Oqtosh', submenu: [
      { label: 'Bosh oyna', accelerator: 'CmdOrCtrl+H', click: showHome },
      { type: 'separator' },
      ...(main ? [
        { label: 'Kassa', accelerator: 'F1', click: () => openSection('kassa') },
        { label: 'Ofitsiant', accelerator: 'F2', click: () => openSection('ofitsiant') },
        { label: 'Admin panel', accelerator: 'F3', click: () => openSection('admin') },
        { label: 'Owner (hisobotlar)', accelerator: 'F4', click: () => openSection('owner') },
        { label: 'Ombor', click: () => openSection('ombor') },
        { label: 'Kuryer', click: () => openSection('kuryer') },
        { type: 'separator' },
        { label: 'Printerlarni sozlash', click: () => openSection('admin', '/tayyorlash') },
      ] : [{ label: 'Ofitsiant', accelerator: 'F2', click: () => openSection('ofitsiant') }]),
      { label: 'Yangilanishni tekshirish', click: () => checkUpdates(true) },
      { type: 'separator' },
      { label: 'Chiqish', accelerator: 'CmdOrCtrl+Q', click: quit },
    ] },
    { label: 'Ko‘rinish', submenu: [
      { label: 'Orqaga', accelerator: 'Alt+Left', click: back },
      { role: 'reload', label: 'Yangilash' },
      { role: 'forceReload', label: 'To‘liq yangilash' },
      { type: 'separator' },
      { role: 'zoomIn', label: 'Kattalashtirish' },
      { role: 'zoomOut', label: 'Kichraytirish' },
      { role: 'resetZoom', label: 'Asl o‘lcham' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'To‘liq ekran' },
      { role: 'toggleDevTools', label: 'Dasturchi oynasi' },
    ] },
    { label: 'Tahrirlash', submenu: [
      { role: 'undo', label: 'Bekor qilish' }, { role: 'redo', label: 'Qaytarish' }, { type: 'separator' },
      { role: 'cut', label: 'Kesish' }, { role: 'copy', label: 'Nusxa olish' }, { role: 'paste', label: 'Qo‘yish' }, { role: 'selectAll', label: 'Hammasini tanlash' },
    ] },
  ]));
}

function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('double-click', showHome);
    tray.on('click', showHome);
  }
  tray.setToolTip('Oqtosh Kassa');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Bosh oyna', click: showHome },
    ...(isMain() ? [
      { label: 'Kassa', click: () => openSection('kassa') },
      { label: 'Ofitsiant', click: () => openSection('ofitsiant') },
      { label: 'Admin panel', click: () => openSection('admin') },
      { label: 'Owner (hisobotlar)', click: () => openSection('owner') },
    ] : [{ label: 'Ofitsiant', click: () => openSection('ofitsiant') }]),
    { type: 'separator' },
    { label: 'Chiqish', click: quit },
  ]));
}
// rejim o'zgarganda (ulash / uzish) menyu, tray va asosiy kompyuter oynalari yangilanadi
function applyMode() {
  buildMenu();
  buildTray();
  if (!isMain()) for (const [name, w] of windows) if (SECTIONS[name]?.main && !w.isDestroyed()) w.close();
  toHome('oq:mode', { main: isMain() });
}

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.autostart), path: process.execPath, args: ['--hidden'] });
}

/* ───────── printerlar ───────── */
let helper = null; // Windows printerlari ro'yxati uchun ko'rinmas oyna
async function windowsPrinters() {
  if (!helper || helper.isDestroyed()) {
    helper = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await helper.loadURL('about:blank');
  }
  return helper.webContents.getPrintersAsync();
}

let agent = null;
let agentStatus = { paired: false };
const logs = [];
const rawPrint = process.platform === 'win32' ? makeRawPrint(userDir) : null;
const toHome = (ch, data) => {
  if (home && !home.isDestroyed()) home.webContents.send(ch, data);
};
function pushLog(l) {
  logs.push(l);
  if (logs.length > 200) logs.shift();
  toHome('oq:agent-log', l);
}

function startAgent() {
  agent?.stop();
  agent = null;
  const key = loadKey();
  agentStatus = { paired: Boolean(key) };
  toHome('oq:agent-status', agentStatus);
  tray?.setToolTip(key ? 'Oqtosh Kassa — printer dasturi' : 'Oqtosh Kassa (printer ulanmagan)');
  if (!key) return;
  agent = new Agent({
    site: settings.site,
    key,
    listWinPrinters: async () => (await windowsPrinters()).map((p) => ({ name: p.name, driver: p.options?.['printer-make-and-model'] || p.description || '' })),
    rawPrint,
  });
  agent.on('status', (s) => {
    agentStatus = s;
    toHome('oq:agent-status', s);
  });
  agent.on('log', pushLog);
  agent.on('site', (site) => {
    aliases.add(originOf(settings.site)); // ochiq oynalar eski manzilda ishlashda davom etsin
    settings.site = site;
    saveSettings();
  });
  agent.on('unpaired', () => {
    saveKey('');
    agent = null;
    agentStatus = { paired: false, keyBad: true, error: 'Kalit eskirgan — dasturni qayta ulang.' };
    toHome('oq:agent-status', agentStatus);
    if (Notification.isSupported()) new Notification({ title: 'Printer dasturi uzildi', body: 'Admin panel → Tayyorlash joylari → “Oqtosh Kassa dasturini ulash” kodini qayta kiriting.', icon: ICON }).show();
  });
  agent.start();
}

// Brauzer cheki (HTML) — tanlangan printerga oynasiz
async function printHtml(html) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html).slice(0, 2_000_000))}`);
    return await new Promise((resolve) => {
      w.webContents.print({ silent: true, printBackground: true, deviceName: settings.htmlPrinter || '', margins: { marginType: 'none' } },
        (ok, reason) => resolve(ok ? { ok: true } : { ok: false, error: reason || 'chop etilmadi' }));
    });
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    setTimeout(() => !w.isDestroyed() && w.destroy(), 2000);
  }
}

/* ───────── IPC ───────── */
const fromHome = (e) => String(e.senderFrame?.url || '').startsWith(APP_URL);
const guard = (e) => {
  if (!fromHome(e)) throw new Error('ruxsat yo‘q');
};

ipcMain.on('oq:version', (e) => {
  e.returnValue = app.getVersion();
});
ipcMain.handle('oq:print-html', async (e, html) => {
  if (!fromHome(e) && !isOurs(e.senderFrame?.url || '')) return { ok: false, error: 'ruxsat yo‘q' };
  return printHtml(html);
});
ipcMain.handle('oq:open', (e, name, hash) => {
  if (!fromHome(e) && !isOurs(e.senderFrame?.url || '')) return false;
  if (name === 'home') return Boolean(showHome());
  return Boolean(openSection(String(name), String(hash || '')));
});
ipcMain.handle('oq:home:state', async (e) => {
  guard(e);
  let printers = [];
  try {
    printers = (await windowsPrinters()).map((p) => ({ name: p.name, isDefault: Boolean(p.isDefault) }));
  } catch {}
  return { settings, version: app.getVersion(), agentVersion: AGENT_VERSION, status: agentStatus, logs, printers, platform: process.platform, main: isMain(), update: updateState };
});
ipcMain.handle('oq:settings:set', async (e, patch) => {
  guard(e);
  const next = { ...settings };
  if (patch.site !== undefined) {
    const u = cleanUrl(patch.site);
    if (!okUrl(u)) throw new Error('Sayt manzili https://… ko‘rinishida bo‘lsin');
    next.site = u;
  }
  if (patch.admin !== undefined) {
    const u = cleanUrl(patch.admin);
    if (!okUrl(u)) throw new Error('Admin manzili https://… ko‘rinishida bo‘lsin');
    next.admin = u;
  }
  for (const k of ['autostart', 'fullscreen']) if (patch[k] !== undefined) next[k] = Boolean(patch[k]);
  if (patch.startWith !== undefined) next.startWith = ['home', 'kassa', 'ofitsiant'].includes(patch.startWith) ? patch.startWith : 'home';
  if (patch.htmlPrinter !== undefined) next.htmlPrinter = String(patch.htmlPrinter).slice(0, 200);
  const siteChanged = next.site !== settings.site;
  settings = next;
  saveSettings();
  applyAutostart();
  if (siteChanged && agent) startAgent();
  return settings;
});
ipcMain.handle('oq:pair', async (e, code) => {
  guard(e);
  const r = await pair(settings.site, String(code || ''));
  if (r.site && okUrl(r.site) && r.site !== settings.site) {
    aliases.add(originOf(settings.site));
    settings.site = r.site;
    saveSettings();
  }
  saveKey(r.key);
  startAgent();
  applyMode();
  return true;
});
ipcMain.handle('oq:unpair', (e) => {
  guard(e);
  agent?.stop();
  agent = null;
  saveKey('');
  startAgent();
  applyMode();
  return true;
});
ipcMain.handle('oq:update:install', (e) => {
  guard(e);
  installUpdate();
  return true;
});
ipcMain.handle('oq:update:check', (e) => {
  guard(e);
  checkUpdates(true);
  return true;
});
ipcMain.handle('oq:scan', (e) => {
  guard(e);
  agent?.scanNow();
  return Boolean(agent);
});
ipcMain.handle('oq:test-local', async (e, p) => {
  guard(e);
  if (!agent) throw new Error('Avval printer dasturini ulang.');
  await agent.testLocal(p);
  return true;
});
ipcMain.handle('oq:test-html', async (e) => {
  guard(e);
  return printHtml(`<!doctype html><meta charset="utf-8"><style>@page{margin:0}body{width:72mm;margin:0 auto;padding:4mm 0;font:14px Arial;text-align:center}</style>
<h2>Oqtosh Kassa</h2><p>Sinov cheki</p><p>${new Date().toLocaleString('ru-RU')}</p><p>Printer: ${(settings.htmlPrinter || 'asosiy (Windows)').replace(/[<>&]/g, '')}</p>`);
});

/* ───────── yangilanish (GitHub Releases → latest.yml) ───────── */
let updater = null;
let updateState = { status: 'idle', version: '' };
let askedFor = '';
const setUpdate = (patch) => {
  updateState = { ...updateState, ...patch };
  toHome('oq:update', updateState);
};
function installUpdate() {
  if (!updater || updateState.status !== 'ready') return;
  quitting = true;
  agent?.stop();
  setImmediate(() => updater.quitAndInstall(true, true)); // jim o'rnatadi va qayta ochadi
}
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch {
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  updater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => setUpdate({ status: 'latest' }));
  updater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('error', (e) => setUpdate({ status: 'error', error: String(e?.message || e).slice(0, 200) }));
  updater.on('update-downloaded', async (i) => {
    setUpdate({ status: 'ready', version: i.version });
    if (askedFor === i.version) return;
    askedFor = i.version;
    if (Notification.isSupported()) new Notification({ title: `Oqtosh Kassa ${i.version} tayyor`, body: 'Yangilash uchun dasturni qayta ishga tushiring.', icon: ICON }).show();
    const parent = BrowserWindow.getFocusedWindow() || [...windows.values()].find((w) => !w.isDestroyed() && w.isVisible()) || home;
    const r = await dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
      type: 'info', buttons: ['Hozir yangilash', 'Keyinroq'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'Yangi versiya', message: `Oqtosh Kassa ${i.version} yuklab olindi.`,
      detail: 'Hozir yangilansinmi? Dastur 10–20 soniyada yopilib, qayta ochiladi. “Keyinroq” — kompyuter o‘chirilganda o‘zi o‘rnatiladi.',
    });
    if (r.response === 0) installUpdate();
  });
  checkUpdates();
  setInterval(() => checkUpdates(), 30 * 60_000);
}
function checkUpdates(manual = false) {
  if (!updater) {
    if (manual) dialog.showMessageBox({ type: 'info', message: 'Yangilagich faqat o‘rnatilgan dasturda ishlaydi.' });
    return;
  }
  updater.checkForUpdates().catch((e) => setUpdate({ status: 'error', error: String(e?.message || e).slice(0, 200) }));
  if (manual) showHome();
}

/* ───────── ishga tushish ───────── */
app.on('second-instance', () => showHome());
// Printer dasturi ulanmagan bo'lsa va ko'rinadigan oyna qolmasa — dastur yopiladi (aks holda tray'da ishlaydi)
function maybeQuit() {
  setTimeout(() => {
    if (quitting || agent) return;
    const visible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w !== helper && w.isVisible());
    if (!visible) quit();
  }, 300);
}
app.on('browser-window-created', (_e, w) => w.on('closed', maybeQuit));
app.on('window-all-closed', () => {
  if (!agent) quit();
});
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = details?.requestingUrl || wc.getURL();
    cb(isOurs(url) && ['notifications', 'clipboard-sanitized-write', 'clipboard-read', 'media', 'fullscreen', 'geolocation'].includes(permission));
  });
  // o'z saytimiz sahifani boshqa https manzilga yo'naltirsa — o'sha manzil ham ruxsat etiladi
  session.defaultSession.webRequest.onBeforeRedirect((d) => {
    if (d.resourceType !== 'mainFrame' || !isOurs(d.url)) return;
    const to = originOf(d.redirectURL);
    if (to.startsWith('https://')) aliases.add(to);
  });
  buildMenu();
  buildTray();
  applyAutostart();
  startAgent();
  setupUpdater();
  if (!hidden) {
    // ofitsiant terminali — darhol ofitsiant oynasi (to'liq ekran)
    if (!isMain()) openSection('ofitsiant');
    else if (settings.startWith === 'kassa' || settings.startWith === 'ofitsiant') openSection(settings.startWith);
    else showHome();
  }
});
