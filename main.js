'use strict';
// Oqtosh Kassa — kompyuter dasturi. Bitta dasturda: Kassa, Ofitsiant, Ombor, Admin panel, Owner hisobotlari
// va ichki printer dasturi (oshxona/kassa cheklari Wi‑Fi va USB printerlarga, oynasiz).
// Sahifalar saytdan yuklanadi — sayt yangilansa dastur ham o'zi yangilanadi (qayta o'rnatish shart emas).
// Ikki rejim:
//   asosiy kompyuter — admin bergan kod bilan ulangan (printer dasturi ishlaydi): Kassa, Admin, Owner, printerlar
//   ofitsiant terminali — ulanmagan kompyuter: faqat Ofitsiant oynasi (omborchi ham shu oynadan PIN bilan kiradi)
// Dasturning o'zi (oyna, printer moduli) GitHub'dagi yangi versiyani o'zi topadi va yangilanadi (electron-updater).
// Server kompyuteri rejimi (server-host.js): sayt, admin panel va barcha ma'lumotlar shu kompyuterdan ishlaydi.

const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, session, safeStorage, Notification, dialog, powerSaveBlocker } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { Agent, pair, VERSION: AGENT_VERSION } = require('./agent/core');
const { makeRawPrint } = require('./agent/raw-win');
const cams = require('./agent/cameras');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { ServerHost } = require('./server-host');
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
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); // PowerShell 5.1 UTF-8 BOM bilan yozadi
  } catch {
    return fb;
  }
};
let settings = { site: defaults.site, admin: defaults.admin, autostart: true, startWith: 'home', fullscreen: true, htmlPrinter: '', osk: 'auto', ...readJson(SETTINGS_FILE, {}) };
settings.server = { enabled: false, domain: defaults.domain || 'oqtoshrestoran.uz', ...(settings.server || {}) };
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
// Netlify'dagi eski admin: yangi manzil (server kompyuteri) javob bera boshlaganda o'ziga o'tadi
const probeAdmin = new Set((defaults.probeAdmin || []).map(cleanUrl));
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

/* ───────── server kompyuteri ───────── */
const host = new ServerHost({ userDir, getSettings: () => settings, save: saveSettings });
const serverOn = () => host.enabled;
// Server rejimida shu kompyuterdagi oynalar va printer dasturi serverga to'g'ridan-to'g'ri ulanadi (internetsiz ham ishlaydi)
const siteUrl = () => (serverOn() ? host.urls().localSite : settings.site);
const adminUrl = () => (serverOn() ? host.urls().localAdmin : settings.admin);

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
const ours = () => [originOf(settings.site), originOf(settings.admin), originOf(host.urls().site), originOf(host.urls().admin), ...(serverOn() ? [originOf(siteUrl()), originOf(adminUrl())] : []), ...aliases].filter(Boolean);
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
  kassa: { title: 'Kassa', url: () => `${adminUrl()}/xodim/kassa.html`, size: [1366, 860], main: true },
  ofitsiant: { title: 'Ofitsiant', url: () => `${adminUrl()}/xodim/ofitsiant.html`, size: [1100, 820] },
  ombor: { title: 'Ombor', url: () => `${adminUrl()}/xodim/ombor.html`, size: [1100, 820] },
  kuryer: { title: 'Kuryer', url: () => `${adminUrl()}/xodim/kuryer.html`, size: [900, 820], main: true },
  admin: { title: 'Admin panel', url: () => `${adminUrl()}/`, size: [1366, 880], main: true },
  owner: { title: 'Owner — hisobotlar', url: () => `${adminUrl()}/owner/`, size: [1366, 880], main: true },
};
// Asosiy kompyuter — printer dasturi ulangan (admin bergan kod bilan). Qolganlari — ofitsiant terminali.
const isMain = () => Boolean(loadKey()) || serverOn();
const allowed = (name) => Boolean(SECTIONS[name]) && (!SECTIONS[name].main || isMain());
const windows = new Map();
let home = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

function webPrefs() {
  return { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false };
}

// Kassa dasturi kabi: sensorli ekranda ikki barmoq bilan kattalashib ketmaydi (menyudagi Ctrl +/− ishlaydi),
// fayl oynaga tashlansa sahifa o'rniga ochilib qolmaydi
function nativeFeel(w) {
  w.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  w.webContents.on('did-finish-load', () => w.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}));
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
  nativeFeel(w);
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
    // printer dasturi yoki server ishlab tursa — oyna yopilmaydi, tray'ga yashirinadi
    if (!quitting && (agent || serverOn())) {
      e.preventDefault();
      home.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: 'Oqtosh Kassa orqada ishlayapti', body: serverOn() ? 'Sayt, admin panel va printerlar shu kompyuterdan ishlashda davom etadi. Ochish — soat yonidagi belgini bosing.' : 'Printerlar cheklarni chiqarishda davom etadi. Ochish — soat yonidagi belgini bosing.', icon: ICON }).show();
      }
    }
  });
  nativeFeel(home);
  home.on('closed', () => (home = null));
  home.loadFile(path.join(__dirname, 'app', 'home.html'));
  return home;
}

function quit() {
  quitting = true;
  agent?.stop();
  app.quit();
}
// Server ishlayotgan bo'lsa — dastur yopilishidan oldin ma'lumotlar diskka yoziladi va server toza to'xtatiladi
let serverStopped = false;
async function stopServerThenQuit() {
  if (serverStopped) return;
  serverStopped = true;
  try {
    await host.stopAll();
  } catch {}
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

// Kompyuter yoqilganda dastur o'zi ochiladi: asosiy kompyuterda — bosh oyna (yoki tanlangan bo'lim), qolganlarida —
// ofitsiant oynasi, to'liq ekranda. Printer qismi shu bilan birga ishga tushadi (alohida cmd oynasi kerak emas).
function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.autostart), path: process.execPath, args: [] });
}

// Eski "Oqtosh printer" (cmd oynasidagi dastur) endi shu dasturning ichida. Kompyuterda topilsa: u to'xtatiladi,
// Windows bilan ishga tushishi o'chiriladi va bu kompyuter hali ulanmagan bo'lsa — uning kaliti olinadi
// (kompyuter o'zi asosiy bo'ladi, qayta kod kiritish shart emas).
function adoptOldCmdPrinter() {
  if (process.platform !== 'win32') return;
  const dir = path.join(app.getPath('appData'), 'OqtoshPrinter');
  if (!fs.existsSync(dir)) return;
  try {
    fs.writeFileSync(path.join(dir, 'stop.flag'), '1'); // ishlab turgan cmd oynasi o'zi yopiladi
  } catch {}
  try {
    fs.rmSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Oqtosh printer.lnk'), { force: true });
  } catch {}
  if (loadKey()) return;
  const cfg = readJson(path.join(dir, 'config.json'), null);
  const key = String(cfg?.key || '');
  if (!/^oqa_[A-Za-z0-9_-]{20,64}$/.test(key)) return;
  saveKey(key);
  pushLog({ at: Date.now(), text: 'Eski printer dasturi (cmd) topildi — uning ulanishi shu dasturga o‘tkazildi va cmd oynasi yopildi.', kind: 'ok' });
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
    site: siteUrl(),
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
    if (serverOn()) return; // server kompyuterida printer dasturi doim shu kompyuterdagi serverga ulanadi
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
  if (cameraStore().state().nvrs.length) syncCamerasSoon(15_000);
}

/* ───────── kameralar (Hikvision / HiLook videoregistratorlari) ─────────
   Topish, ulash, rasm va "kabina = stol" shu kompyuterda (agent/cameras.js). Parollar safeStorage bilan shifrlanadi.
   Saytga (owner hisobotlari uchun) faqat kamera nomlari va qaysi stolga qaragani yuboriladi — IP, parol, rasm emas. */
let camStore = null;
let camSyncTimer = null;
const camEnc = (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s, 'utf8')).toString('base64');
const camDec = (s) => {
  const b = Buffer.from(String(s || ''), 'base64');
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8');
  } catch {
    return '';
  }
};
function cameraStore() {
  camStore ||= new cams.CameraStore({ file: path.join(userDir, 'cameras.json'), encrypt: camEnc, decrypt: camDec, onChange: () => syncCamerasSoon() });
  return camStore;
}
function syncCamerasSoon(ms = 2000) {
  clearTimeout(camSyncTimer);
  camSyncTimer = setTimeout(async () => {
    if (!agent) return;
    try {
      await agent.api('POST', '/api/print-agent/cameras', { cameras: cameraStore().summary() });
    } catch (e) {
      pushLog({ at: Date.now(), text: `Kameralar saytga yuborilmadi: ${e.message}`, kind: 'warn' });
    }
  }, ms);
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
  return { settings, version: app.getVersion(), agentVersion: AGENT_VERSION, status: agentStatus, logs, printers, platform: process.platform, main: isMain(), update: updateState, server: host.publicState() };
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
  if (patch.osk !== undefined && OSK_MODES.includes(patch.osk)) next.osk = patch.osk;
  const oskChanged = next.osk !== settings.osk;
  const siteChanged = next.site !== settings.site;
  settings = next;
  saveSettings();
  applyAutostart();
  if (siteChanged && agent) startAgent();
  if (oskChanged) broadcastOsk();
  return settings;
});
ipcMain.handle('oq:cam:state', (e) => {
  guard(e);
  return cameraStore().state();
});
ipcMain.handle('oq:cam:discover', async (e) => {
  guard(e);
  const have = cameraStore().state().nvrs;
  const list = await cams.discover();
  return list.map((d) => ({ ...d, added: have.some((n) => n.ip === d.ip || (d.serial && n.serial === d.serial)) }));
});
ipcMain.handle('oq:cam:connect', async (e, o) => {
  guard(e);
  const r = await cameraStore().connect({ ip: o?.ip, port: o?.port, user: o?.user, pass: o?.pass });
  pushLog({ at: Date.now(), text: `Videoregistrator ulandi: ${r.name || r.model} (${r.channels.length} kamera)`, kind: 'ok' });
  return r;
});
ipcMain.handle('oq:cam:refresh', (e, id) => {
  guard(e);
  return cameraStore().refresh(String(id));
});
ipcMain.handle('oq:cam:snapshot', async (e, id, ch) => {
  guard(e);
  const jpg = await cameraStore().snapshot(String(id), Number(ch));
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
});
ipcMain.handle('oq:cam:place', (e, id, ch, place) => {
  guard(e);
  return cameraStore().setPlace(String(id), Number(ch), { place: place?.place || '', tableId: place?.tableId || '', label: place?.label || '' });
});
ipcMain.handle('oq:cam:remove', (e, id) => {
  guard(e);
  cameraStore().remove(String(id));
  return true;
});
// Stollar ro'yxati (kabina = stol) — saytning ochiq /api/tables manzilidan
ipcMain.handle('oq:cam:tables', async (e) => {
  guard(e);
  const res = await fetch(`${siteUrl()}/api/tables`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Stollar olinmadi (HTTP ${res.status})`);
  const d = await res.json();
  return (d.halls || []).map((h) => ({ id: String(h.id), name: String(h.name || ''), tables: (h.tables || []).map((t) => ({ id: String(t.id), name: String(t.name || ''), label: String(t.label || t.name || '') })) }));
});
ipcMain.handle('oq:pair', async (e, code) => {
  guard(e);
  const r = await pair(siteUrl(), String(code || ''));
  if (!serverOn() && r.site && okUrl(r.site) && r.site !== settings.site) {
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
// Ekran klaviaturasi: auto — barmoq bilan bosilganda, on — doim (sichqoncha bilan ham), off — o'chiq.
// Hamma oynalar bir xil rejimda; o'zgarsa ochiq oynalarga darhol yuboriladi.
const OSK_MODES = ['auto', 'on', 'off'];
const oskMode = () => (OSK_MODES.includes(settings.osk) ? settings.osk : 'auto');
function broadcastOsk() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('oq:osk', oskMode());
}
ipcMain.on('oq:osk:get', (e) => {
  e.returnValue = oskMode();
});
ipcMain.handle('oq:osk:set', (e, mode) => {
  if (!fromHome(e) && !isOurs(e.senderFrame?.url || '')) return oskMode();
  if (!OSK_MODES.includes(mode) || mode === settings.osk) return oskMode();
  settings.osk = mode;
  saveSettings();
  broadcastOsk();
  return mode;
});

// Sensorli POS monoblok (klaviaturasiz): bo'lim oynalaridagi chetdagi menyu uchun
const MENU_SECTIONS = ['kassa', 'ofitsiant', 'ombor', 'admin', 'owner'];
ipcMain.handle('oq:menu:state', (e) => {
  if (!fromHome(e) && !isOurs(e.senderFrame?.url || '')) return null;
  const w = BrowserWindow.fromWebContents(e.sender);
  return {
    version: app.getVersion(), main: isMain(), fullscreen: Boolean(w?.isFullScreen()), update: updateState, osk: oskMode(),
    sections: MENU_SECTIONS.filter(allowed).map((id) => ({ id, title: SECTIONS[id].title })),
  };
});
ipcMain.handle('oq:win', (e, action) => {
  if (!fromHome(e) && !isOurs(e.senderFrame?.url || '')) return false;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (action === 'fullscreen' && w) {
    const on = !w.isFullScreen();
    w.setFullScreen(on);
    if (!on) w.maximize();
    return on;
  }
  if (action === 'update') {
    installUpdate();
    return updateState.status === 'ready';
  }
  return false;
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

/* ───────── server kompyuteri: boshqaruv ───────── */
function setupServer() {
  let last = 0;
  let timer = null;
  // holat tez-tez o'zgaradi (ko'chirish jarayoni) — bosh oynaga ko'pi bilan sekundiga bir marta
  host.on('state', () => {
    const send = () => {
      last = Date.now();
      timer = null;
      toHome('oq:server', host.publicState());
    };
    if (Date.now() - last > 1000) send();
    else if (!timer) timer = setTimeout(send, 1000);
  });
  host.on('log', (l) => toHome('oq:server-log', l));
  // server ishlab turganda kompyuter uyqu rejimiga o'tmaydi (ekran o'chishi mumkin) — aks holda sayt to'xtaydi
  let blocker = null;
  const keepAwake = () => {
    if (serverOn() && blocker === null) blocker = powerSaveBlocker?.start('prevent-app-suspension') ?? null;
    if (!serverOn() && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  };
  keepAwake();
  host.on('mode', () => {
    keepAwake();
    startAgent(); // printer dasturi serverga (yoki saytga) qayta ulanadi
    applyMode();
    for (const [name, w] of windows) if (!w.isDestroyed() && SECTIONS[name]) w.loadURL(SECTIONS[name].url());
  });
  host.on('started', () => {
    // server endi tayyor — "sayt ochilmadi" sahifasidagi oynalar qayta yuklanadi
    for (const [name, w] of windows) if (!w.isDestroyed() && w.webContents.getURL().startsWith('file:') && SECTIONS[name]) w.loadURL(SECTIONS[name].url());
  });
  if (serverOn()) {
    host.start();
    host.startTunnel();
  }
}

// Boshqa kompyuterlar (ofitsiant terminallari): Netlify'dagi eski admin manzili saqlangan bo'lsa,
// yangi manzil (server kompyuteri) ishlay boshlaganini tekshirib, o'zi o'tadi
function watchOldAdmin() {
  const check = async () => {
    if (serverOn() || !probeAdmin.has(cleanUrl(settings.admin))) return;
    const next = host.urls().admin;
    try {
      const r = await fetch(`${next}/api/pc/ping`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok || !(await r.json()).pc) return;
    } catch {
      return;
    }
    const old = settings.admin;
    aliases.add(originOf(old));
    settings.admin = next;
    saveSettings();
    pushLog({ at: Date.now(), text: `Admin manzili yangilandi: ${next} (server kompyuteri)`, kind: 'ok' });
    for (const [name, w] of windows) if (!w.isDestroyed() && w.webContents.getURL().startsWith(originOf(old)) && SECTIONS[name]) w.loadURL(SECTIONS[name].url());
  };
  check();
  setInterval(check, 5 * 60_000);
}

// Fayl tanlash oynasi: to'liq ekrandagi oyna ustida Windows dialogni orqada qoldirishi mumkin —
// shuning uchun dialog paytida to'liq ekrandan chiqiladi, keyin qaytariladi
async function pickFile(opts) {
  const w = home && !home.isDestroyed() ? home : null;
  const wasFull = Boolean(w?.isFullScreen());
  if (wasFull) {
    w.setFullScreen(false);
    await new Promise((r) => setTimeout(r, 350));
  }
  w?.focus();
  try {
    return await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
  } finally {
    if (wasFull && !w.isDestroyed()) w.setFullScreen(true);
  }
}

const serverCall = (fn) => async (e, ...args) => {
  guard(e);
  return fn(...args);
};
ipcMain.handle('oq:server:state', serverCall(() => host.publicState()));
ipcMain.handle('oq:server:enable', serverCall((on) => host.enable(Boolean(on))));
ipcMain.handle('oq:server:find-keys', serverCall(() => host.findEnvFiles()));
ipcMain.handle('oq:server:import-keys', serverCall(async (files) => {
  let list = Array.isArray(files) ? files.map(String).filter((f) => fs.existsSync(f)) : [];
  if (!list.length) {
    const r = await pickFile({
      title: 'Kalitlar fayli (.env yoki netlify-kalitlar.env)', defaultPath: app.getPath('downloads'), properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
      filters: [{ name: 'Barcha fayllar', extensions: ['*'] }],
    });
    if (r.canceled) return host.keysInfo();
    list = r.filePaths;
  }
  const info = host.importEnvFiles(list);
  if (serverOn()) {
    await host.stop();
    host.start(); // yangi kalitlar bilan
  }
  return info;
}));
ipcMain.handle('oq:server:tunnel', serverCall((domain) => host.setupTunnel(domain)));
// buyruqdan keyin holat darhol yangilanadi (15 soniyalik navbatni kutmasdan)
const andRefresh = (p) => p.finally(() => host.refresh());
ipcMain.handle('oq:server:migrate', serverCall(() => andRefresh(host.request('migrate', {}, 30 * 60_000))));
ipcMain.handle('oq:server:fresh', serverCall(() => andRefresh(host.request('fresh'))));
ipcMain.handle('oq:server:backup', serverCall(() => andRefresh(host.request('backup'))));
ipcMain.handle('oq:server:backup-telegram', serverCall(() => andRefresh(host.request('backup-telegram'))));
ipcMain.handle('oq:server:restore', serverCall(async () => {
  const r = await pickFile({
    title: 'Zaxira faylini tanlang (.oqz)', defaultPath: host.backupDir, properties: ['openFile'], filters: [{ name: 'Oqtosh zaxirasi', extensions: ['oqz'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const ok = await dialog.showMessageBox(home && !home.isDestroyed() ? home : undefined, {
    type: 'warning', buttons: ['Tiklash', 'Bekor qilish'], defaultId: 1, cancelId: 1, noLink: true, title: 'Zaxiradan tiklash',
    message: `Ma'lumotlar ${path.basename(r.filePaths[0])} holatiga qaytarilsinmi?`,
    detail: 'Hozirgi ma’lumotlar oldin alohida zaxiraga saqlanadi. Zaxiradan keyingi buyurtmalar ro‘yxatdan chiqadi.',
  });
  if (ok.response !== 0) return null;
  return andRefresh(host.request('restore', { file: r.filePaths[0] }, 10 * 60_000));
}));
ipcMain.handle('oq:server:open', serverCall((what) => {
  if (what === 'backups') return host.openBackups();
  if (what === 'log') return host.openLog();
  const u = host.urls();
  if (what === 'site' || what === 'admin') return shell.openExternal(u[what]);
  return false;
}));

/* ───────── masofadan o'chirish (Admin panel → Qurilmalar → Kompyuterlar) ─────────
   Har bir dastur o'zining tasodifiy id va maxfiy kaliti bilan har 10 soniyada saytga "men yoqilganman" deydi.
   Admin "O'chirish" bossa — javobda buyruq keladi (3 daqiqa amal qiladi, keyin eskiradi): Windows'ning
   shutdown /s /t <5–60> buyrug'i (vaqtni admin tanlaydi), ekranda ogohlantirish va "Bekor qilish". Server kompyuteri o'chmaydi. */
const DEVICE_FILE = path.join(userDir, 'device.json');
let device = null;
let power = null; // { id, restart, abort } — boshlangan o'chirish (ekrandagi ogohlantirish bilan)
const seenCommands = new Set();
// bajarilgan buyruq diskka yoziladi: qayta yoqilgandan keyin (ack yetib bormagan bo'lsa ham) takrorlanmaydi
const POWER_FILE = path.join(userDir, 'power.json');
const lastPowerId = () => readJson(POWER_FILE, {}).id || '';
function deviceIdentity() {
  if (device) return device;
  const d = readJson(DEVICE_FILE, null);
  if (d && /^[a-f0-9]{32}$/.test(d.id) && /^[a-f0-9]{64}$/.test(d.secret || '')) return (device = { id: d.id, secret: d.secret });
  device = { id: crypto.randomBytes(16).toString('hex'), secret: crypto.randomBytes(32).toString('hex') };
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(device));
  return device;
}
async function desktopCall(route, body) {
  const me = deviceIdentity();
  const res = await fetch(`${siteUrl()}/api/desktop/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ id: me.id, secret: me.secret, ...body }),
  });
  return res.json().catch(() => ({}));
}
const powerText = (restart, by) => `${by || 'Admin'} bu kompyuterni ${restart ? 'qayta yoqmoqda' : 'o‘chirmoqda'}`;
function runShutdown(args, cb = () => {}) {
  execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shutdown.exe'), args, { windowsHide: true }, cb);
}
async function runPowerCommand(c) {
  if (!c?.id || seenCommands.has(c.id) || lastPowerId() === c.id) return;
  seenCommands.add(c.id);
  const ack = (result, error = '') => desktopCall('ack', { commandId: c.id, result, error }).catch(() => {});
  if (c.action === 'cancel') {
    if (process.platform === 'win32') runShutdown(['/a']);
    power?.abort.abort(); // ekrandagi ogohlantirish ham yopiladi
    power = null;
    pushLog({ at: Date.now(), text: 'Kompyuterni o‘chirish bekor qilindi (admin).', kind: 'ok' });
    return ack('cancelled');
  }
  if (!['shutdown', 'restart'].includes(c.action)) return ack('error', 'noma’lum buyruq');
  if (serverOn()) return ack('refused', 'server kompyuteri');
  if (process.platform !== 'win32') return ack('error', 'faqat Windows');
  const restart = c.action === 'restart';
  const delay = Math.min(300, Math.max(5, Number(c.delaySec) || 10));
  const text = powerText(restart, c.byName);
  try {
    fs.writeFileSync(POWER_FILE, JSON.stringify({ id: c.id, action: c.action, at: Date.now() }));
  } catch {}
  runShutdown([restart ? '/r' : '/s', '/t', String(delay), '/c', `Oqtosh: ${text}. ${delay} soniyadan keyin.`], async (err) => {
    if (err) {
      pushLog({ at: Date.now(), text: `Kompyuterni o‘chirib bo‘lmadi: ${err.message}`, kind: 'warn' });
      return ack('error', String(err.message).slice(0, 180));
    }
    const abort = new AbortController();
    power = { id: c.id, restart, abort };
    await ack('started');
    pushLog({ at: Date.now(), text: `${text} — ${delay} soniya.`, kind: 'warn' });
    // ekranda ogohlantirish: ishini saqlab olsin yoki bekor qilsin
    const parent = BrowserWindow.getFocusedWindow() || [...windows.values()].find((w) => !w.isDestroyed() && w.isVisible()) || (home && !home.isDestroyed() ? home : undefined);
    const r = await dialog.showMessageBox(parent, {
      type: 'warning', buttons: ['Bekor qilish', restart ? 'Hozir qayta yoqish' : 'Hozir o‘chirish'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Oqtosh Kassa', message: `${text}: ${delay} soniyadan keyin.`,
      detail: 'Ochiq buyurtma yoki to‘lov bo‘lsa — avval tugating yoki “Bekor qilish”ni bosing.',
      signal: abort.signal,
    });
    if (!power || power.id !== c.id) return; // admin allaqachon bekor qildi
    if (r.response === 0) {
      runShutdown(['/a']);
      power = null;
      pushLog({ at: Date.now(), text: 'Kompyuterni o‘chirish shu yerda bekor qilindi.', kind: 'ok' });
      ack('cancelled');
    } else {
      runShutdown(['/a'], () => runShutdown([restart ? '/r' : '/s', '/t', '0']));
    }
  });
}
let powerTimer = null;
function startPowerControl() {
  const tick = async () => {
    try {
      const r = await desktopCall('ping', { name: os.hostname(), version: app.getVersion(), main: isMain(), server: serverOn(), os: `${process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()}` });
      if (r?.command) await runPowerCommand(r.command);
    } catch {}
  };
  clearInterval(powerTimer);
  setTimeout(tick, 5000);
  powerTimer = setInterval(tick, 10_000);
}
ipcMain.on('oq:device-id', (e) => {
  e.returnValue = isOurs(e.senderFrame?.url || '') || fromHome(e) ? deviceIdentity().id : '';
});

/* ───────── yangilanish (GitHub Releases → latest.yml) ───────── */
let updater = null;
let updateState = { status: 'idle', version: '' };
let askedFor = '';
const setUpdate = (patch) => {
  updateState = { ...updateState, ...patch };
  toHome('oq:update', updateState);
  // bo'lim oynalaridagi (kassa, ofitsiant…) chetdagi menyu ham bilsin
  for (const w of windows.values()) if (!w.isDestroyed()) w.webContents.send('oq:update', updateState);
};
async function installUpdate() {
  if (!updater || updateState.status !== 'ready') return;
  quitting = true;
  agent?.stop();
  serverStopped = true;
  try {
    await host.stopAll(); // ma'lumotlar diskka yoziladi, keyin o'rnatiladi
  } catch {}
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
  // POS monobloklar kechasi ham o'chirilmaydi: "Keyinroq" deyilgan yangilanish tunda (03:00–06:00) o'zi o'rnatiladi
  setInterval(() => {
    const h = new Date().getHours();
    if (updateState.status === 'ready' && h >= 3 && h < 6) installUpdate();
  }, 10 * 60_000);
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
    if (quitting || agent || serverOn()) return;
    const visible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w !== helper && w.isVisible());
    if (!visible) quit();
  }, 300);
}
app.on('browser-window-created', (_e, w) => w.on('closed', maybeQuit));
app.on('window-all-closed', () => {
  if (!agent && !serverOn()) quit();
});
app.on('before-quit', (e) => {
  quitting = true;
  if (!serverStopped && (host.child || host.tunnel)) {
    e.preventDefault();
    stopServerThenQuit();
  }
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
  adoptOldCmdPrinter();
  buildMenu();
  buildTray();
  applyAutostart();
  setupServer();
  startAgent();
  setupUpdater();
  startPowerControl();
  watchOldAdmin();
  if (!hidden) {
    // ofitsiant terminali — darhol ofitsiant oynasi (to'liq ekran)
    if (!isMain()) openSection('ofitsiant');
    else if (settings.startWith === 'kassa' || settings.startWith === 'ofitsiant') openSection(settings.startWith);
    else showHome();
  }
});
