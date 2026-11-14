'use strict';
// Sahifalarga beriladigan kichik ko'prik (window.OqDesktop). Sayt sahifalari faqat chek chop etish va
// bo'lim ochishni oladi; printer dasturi va sozlamalar faqat dasturning o'z bosh oynasiga (file://) ochiq.
const { contextBridge, ipcRenderer } = require('electron');

const local = location.protocol === 'file:';
const api = {
  isDesktop: true,
  version: ipcRenderer.sendSync('oq:version'),
  printHtml: (html) => ipcRenderer.invoke('oq:print-html', String(html)),
  open: (section, hash = '') => ipcRenderer.invoke('oq:open', String(section), String(hash)),
};
if (local) {
  Object.assign(api, {
    state: () => ipcRenderer.invoke('oq:home:state'),
    setSettings: (patch) => ipcRenderer.invoke('oq:settings:set', patch),
    pair: (code) => ipcRenderer.invoke('oq:pair', String(code)),
    unpair: () => ipcRenderer.invoke('oq:unpair'),
    scan: () => ipcRenderer.invoke('oq:scan'),
    testLocal: (printer) => ipcRenderer.invoke('oq:test-local', printer),
    testHtml: () => ipcRenderer.invoke('oq:test-html'),
    onStatus: (cb) => ipcRenderer.on('oq:agent-status', (_e, s) => cb(s)),
    onLog: (cb) => ipcRenderer.on('oq:agent-log', (_e, l) => cb(l)),
    onMode: (cb) => ipcRenderer.on('oq:mode', (_e, m) => cb(m)),
    onUpdate: (cb) => ipcRenderer.on('oq:update', (_e, u) => cb(u)),
    installUpdate: () => ipcRenderer.invoke('oq:update:install'),
    checkUpdates: () => ipcRenderer.invoke('oq:update:check'),
    // server kompyuteri
    server: {
      state: () => ipcRenderer.invoke('oq:server:state'),
      enable: (on) => ipcRenderer.invoke('oq:server:enable', Boolean(on)),
      findKeys: () => ipcRenderer.invoke('oq:server:find-keys'),
      importKeys: (files) => ipcRenderer.invoke('oq:server:import-keys', Array.isArray(files) ? files.map(String) : []),
      tunnel: (domain) => ipcRenderer.invoke('oq:server:tunnel', String(domain || '')),
      migrate: () => ipcRenderer.invoke('oq:server:migrate'),
      fresh: () => ipcRenderer.invoke('oq:server:fresh'),
      backup: () => ipcRenderer.invoke('oq:server:backup'),
      backupTelegram: () => ipcRenderer.invoke('oq:server:backup-telegram'),
      restore: () => ipcRenderer.invoke('oq:server:restore'),
      open: (what) => ipcRenderer.invoke('oq:server:open', String(what)),
      onState: (cb) => ipcRenderer.on('oq:server', (_e, s) => cb(s)),
      onLog: (cb) => ipcRenderer.on('oq:server-log', (_e, l) => cb(l)),
    },
  });
}
contextBridge.exposeInMainWorld('OqDesktop', api);

/* ───────── Sensorli POS monoblok uchun chetdagi menyu ─────────
   Klaviaturasiz kompyuterda Ctrl+H, F1–F4, F11 bosib bo'lmaydi. Shuning uchun har bir bo'lim oynasining chap
   chetida kichik tutqich turadi: bosilsa — Bosh oyna, bo'limlar (asosiy kompyuterda Kassa/Admin/Owner),
   to'liq ekran, sahifani yangilash va tayyor yangilanish. Sahifa uslublariga aralashmasligi uchun Shadow DOM. */
const CURRENT = () => {
  const p = location.pathname;
  if (/kassa\.html$/.test(p)) return 'kassa';
  if (/ofitsiant\.html$/.test(p)) return 'ofitsiant';
  if (/ombor\.html$/.test(p)) return 'ombor';
  if (/^\/owner\//.test(p)) return 'owner';
  if (p === '/' || p === '/index.html') return 'admin';
  return '';
};

async function mountMenu() {
  if (window.top !== window || document.getElementById('oq-desktop-menu')) return;
  // faqat o'z saytlarimizda (Google kirish oynasi va boshqa saytlarda — yo'q)
  const first = await ipcRenderer.invoke('oq:menu:state').catch(() => null);
  if (!first || document.getElementById('oq-desktop-menu')) return;
  const host = document.createElement('div');
  host.id = 'oq-desktop-menu';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .handle { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 2147483646; width: 26px; height: 84px; display: grid; place-items: center;
      border: 0; border-radius: 0 14px 14px 0; background: rgb(229 163 62 / .82); color: #1a1408; font: 700 18px/1 system-ui, sans-serif; cursor: pointer;
      box-shadow: 2px 0 14px rgb(0 0 0 / .35); opacity: .6; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .handle:hover, .handle:focus-visible, .handle.is-open { opacity: 1; outline: none; }
    .handle .dot { position: absolute; top: 6px; right: 4px; width: 9px; height: 9px; border-radius: 50%; background: #e2654f; box-shadow: 0 0 0 2px rgb(229 163 62); }
    .veil { position: fixed; inset: 0; z-index: 2147483645; background: rgb(0 0 0 / .45); }
    .panel { position: fixed; left: 34px; top: 50%; transform: translateY(-50%); z-index: 2147483647; width: min(320px, calc(100vw - 48px)); max-height: calc(100vh - 32px); overflow: auto;
      display: grid; gap: 8px; padding: 16px; border-radius: 20px; background: #17161a; border: 1px solid #2c2a30; box-shadow: 0 24px 60px rgb(0 0 0 / .55);
      color: #f3ede2; font: 500 15px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
    .head strong { font-size: 16px; }
    .head small { color: #a49d92; font-size: 12px; }
    button.item { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 54px; padding: 10px 14px; border-radius: 14px; border: 1px solid #2c2a30;
      background: #1f1e23; color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
    button.item:active { transform: scale(.98); }
    button.item.is-on { border-color: rgb(229 163 62 / .8); background: rgb(229 163 62 / .14); }
    button.item.is-upd { border-color: #8bb83f; background: rgb(139 184 63 / .16); }
    .ic { width: 26px; text-align: center; font-size: 20px; }
    .sep { height: 1px; background: #2c2a30; margin: 4px 0; }
    .toast { position: fixed; top: 14px; right: 14px; z-index: 2147483647; display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; border-radius: 14px;
      background: #17161a; border: 1px solid #8bb83f; color: #f3ede2; font: 500 14px/1.3 system-ui, sans-serif; box-shadow: 0 12px 40px rgb(0 0 0 / .5); }
    .toast button { min-height: 40px; padding: 0 14px; border-radius: 999px; border: 0; background: #8bb83f; color: #10140a; font: 700 14px system-ui, sans-serif; cursor: pointer; }
    .toast .x { background: transparent; color: #a49d92; padding: 0 8px; }
    [hidden] { display: none !important; }`;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'handle';
  handle.setAttribute('aria-label', 'Oqtosh menyusi');
  handle.title = 'Menyu: bosh oyna, bo‘limlar, to‘liq ekran';
  handle.textContent = '⋮';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.hidden = true;
  handle.append(dot);
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Oqtosh menyusi');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.hidden = true;
  root.append(style, veil, panel, handle, toast);
  document.documentElement.append(host);

  let update = null;
  const ICONS = { kassa: '🧾', ofitsiant: '🍽', ombor: '📦', admin: '🛠', owner: '📊' };
  const close = () => {
    panel.hidden = true;
    veil.hidden = true;
    handle.classList.remove('is-open');
  };
  const item = (icon, text, onclick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `item ${cls}`;
    const i = document.createElement('span');
    i.className = 'ic';
    i.textContent = icon;
    const t = document.createElement('span');
    t.textContent = text;
    b.append(i, t);
    b.addEventListener('click', () => {
      close();
      onclick();
    });
    return b;
  };
  const paintDot = () => {
    dot.hidden = update?.status !== 'ready';
  };
  async function open() {
    const st = await ipcRenderer.invoke('oq:menu:state').catch(() => null);
    if (!st) return;
    update = st.update;
    paintDot();
    const head = document.createElement('div');
    head.className = 'head';
    const h = document.createElement('strong');
    h.textContent = 'Oqtosh Kassa';
    const v = document.createElement('small');
    v.textContent = `versiya ${st.version}${st.main ? ' · asosiy' : ''}`;
    head.append(h, v);
    const cur = CURRENT();
    const sep = () => Object.assign(document.createElement('div'), { className: 'sep' });
    panel.replaceChildren(head,
      ...(st.update?.status === 'ready' ? [item('⬆', `Yangilash: ${st.update.version} tayyor`, () => ipcRenderer.invoke('oq:win', 'update'), 'is-upd')] : []),
      item('🏠', 'Bosh oyna', () => ipcRenderer.invoke('oq:open', 'home', '')),
      ...st.sections.map((s) => item(ICONS[s.id] || '•', s.title, () => ipcRenderer.invoke('oq:open', s.id, ''), s.id === cur ? 'is-on' : '')),
      sep(),
      item('⛶', st.fullscreen ? 'To‘liq ekrandan chiqish' : 'To‘liq ekran', () => ipcRenderer.invoke('oq:win', 'fullscreen')),
      item('↻', 'Sahifani yangilash', () => location.reload()));
    panel.hidden = false;
    veil.hidden = false;
    handle.classList.add('is-open');
    panel.querySelector('button.item')?.focus();
  }
  handle.addEventListener('click', () => (panel.hidden ? open() : close()));
  veil.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  // yangilanish tayyor bo'lsa — tutqichda nuqta va bir martalik eslatma
  const showToast = () => {
    const msg = document.createElement('span');
    msg.textContent = `Yangi versiya ${update.version} tayyor`;
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Yangilash';
    go.addEventListener('click', () => ipcRenderer.invoke('oq:win', 'update'));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.setAttribute('aria-label', 'Yopish');
    x.textContent = '✕';
    x.addEventListener('click', () => (toast.hidden = true));
    toast.replaceChildren(msg, go, x);
    toast.hidden = false;
  };
  ipcRenderer.on('oq:update', (_e, u) => {
    const was = update?.status;
    update = u;
    paintDot();
    if (u?.status === 'ready' && was !== 'ready') showToast();
  });
  update = first.update || null;
  paintDot();
  if (update?.status === 'ready') showToast();
}

if (!local) {
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', mountMenu, { once: true });
  else mountMenu();
}
