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

// chetdagi menyuda bosilganda navbatdagi rejim: avtomatik → doim → o'chiq
const OSK_LABEL = { auto: 'Klaviatura: barmoq bosganda', on: 'Klaviatura: doim ochiladi', off: 'Klaviatura: o‘chiq' };
const OSK_NEXT = { auto: 'on', on: 'off', off: 'auto' };

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
      item('⌨', OSK_LABEL[st.osk] || OSK_LABEL.auto, () => ipcRenderer.invoke('oq:osk:set', OSK_NEXT[st.osk] || 'on'), st.osk === 'off' ? '' : 'is-on'),
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

/* ───────── Ekran klaviaturasi ─────────
   Sensorli monoblokda jismoniy klaviatura yo'q: matn yoki raqam maydoniga barmoq bilan bosilganda pastda
   dasturning o'z klaviaturasi chiqadi (lotin + o‘ g‘, kirill + ў қ ғ ҳ, belgilar, raqam paneli).
   Rejim (Sozlamalar yoki chetdagi menyu): auto — barmoq bilan bosilganda, on — doim, off — o'chiq.
   Harflar document.execCommand('insertText') bilan yoziladi — sahifa buni oddiy yozish deb qabul qiladi
   (input hodisasi, kursor joyi, maxlength). Modal oyna ochiq bo'lsa klaviatura o'sha oyna ichiga qo'yiladi,
   aks holda oyna orqasida qolib, bosib bo'lmaydi. Haqiqiy klaviaturadan yozilsa (auto rejimida) o'zi yopiladi. */
// OSK:BEGIN
function mountKeyboard({ mode: firstMode = 'auto', onMode = () => {} } = {}) {
  if (window.top !== window || window.__oqOsk) return null;
  window.__oqOsk = true;
  let mode = firstMode;

  const TEXT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  const editable = (el) => {
    if (!el || el.nodeType !== 1 || el.disabled || el.readOnly) return false;
    if (el.closest('[data-osk="off"]')) return false;
    if ((el.getAttribute('inputmode') || '').toLowerCase() === 'none') return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return TEXT_TYPES.includes(el.type);
    return Boolean(el.isContentEditable);
  };
  const kindOf = (el) => {
    const im = (el.getAttribute('inputmode') || '').toLowerCase();
    if (el.type === 'tel' || im === 'tel') return 'tel';
    if (im === 'numeric') return 'num';
    if (el.type === 'number' || im === 'decimal') return 'dec';
    return 'text';
  };

  // tugmalar: matn — 2 yarim-birlik; K(amal, kenglik)
  const K = (k, s = 2) => ({ k, s });
  const T = (t, s) => ({ t, s }); // kengroq harf tugmasi (qator chetini to'ldiradi)
  const DIG = [...'1234567890'];
  const LAYOUTS = {
    lat: { u: 23, rows: [
      [...DIG, K('bs', 3)],
      [...'qwertyuiop', T('o‘', 3)],
      [...'asdfghjkl', 'g‘', K('enter', 3)],
      [K('shift', 3), ...'zxcvbnm', '’', ',', '.'],
      [K('sym', 3), K('lang', 3), K('space', 10), '-', K('dock'), K('hide', 3)],
    ] },
    kir: { u: 25, rows: [
      ['ё', ...DIG, K('bs', 3)],
      [...'йцукенгшщзх', T('ъ', 3)],
      [...'фывапролджэ', K('enter', 3)],
      [K('shift', 3), ...'ячсмитьбю', ',', '.'],
      [K('sym', 3), K('lang', 3), 'ў', 'қ', K('space', 6), 'ғ', 'ҳ', K('dock'), K('hide', 3)],
    ] },
    sym: { u: 23, rows: [
      [...DIG, K('bs', 3)],
      [...'@#№%&*()-+', T('=', 3)],
      [...'/:;"!?_«»', K('enter', 5)],
      [T(',', 3), ...'.‘’~<>[]{}'],
      [K('abc', 3), '-', K('space', 11), '.', K('dock'), K('hide', 3)],
    ] },
    num: { u: 8, pad: true, rows: [[...'123', K('bs')], [...'456', K('clear')], [...'789', K('enter')], ['000', '0', K('abc'), K('hide')]] },
    dec: { u: 8, pad: true, rows: [[...'123', K('bs')], [...'456', K('clear')], [...'789', K('enter')], ['.', '0', '000', K('hide')]] },
    tel: { u: 8, pad: true, rows: [[...'123', K('bs')], [...'456', K('clear')], [...'789', K('enter')], ['+', '0', K('abc'), K('hide')]] },
  };
  const TEXT_LAYOUTS = ['lat', 'kir', 'sym'];

  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  let textLang = store.get('oq-osk-lang') === 'kir' ? 'kir' : 'lat';
  let dock = store.get('oq-osk-dock') === 'top' ? 'top' : 'bottom';
  let layout = textLang;
  let target = null;
  let visible = false;
  let shift = 0; // 0 — kichik, 1 — bitta katta harf, 2 — hammasi katta
  let lastShiftAt = 0;
  let lastPtr = '';
  let hideTimer = 0;
  let watchTimer = 0;

  const host = document.createElement('div');
  host.id = 'oq-osk';
  const hostCss = (extra = '') => {
    host.style.cssText = `all: initial !important; position: fixed !important; left: 0 !important; right: 0 !important; z-index: 2147483647 !important; ${extra}`;
  };
  hostCss('display: none !important;');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .kb { --h: clamp(42px, 6.6vh, 62px); --g: 7px; box-sizing: border-box; display: grid; gap: var(--g); width: 100%;
      padding: 9px max(8px, calc((100vw - 1240px) / 2)) 11px; background: rgb(10 17 30 / .97); border-top: 1px solid #263852;
      box-shadow: 0 -14px 40px rgb(0 0 0 / .5); color: #eef3fa; font: 600 22px/1 system-ui, 'Segoe UI', Roboto, sans-serif;
      user-select: none; -webkit-user-select: none; touch-action: none; -webkit-tap-highlight-color: transparent; }
    .kb.top { border-top: 0; border-bottom: 1px solid #263852; box-shadow: 0 14px 40px rgb(0 0 0 / .5); }
    .kb.pad { --h: clamp(50px, 8.4vh, 74px); --g: 8px; padding-inline: max(8px, calc((100vw - 520px) / 2)); font-size: 26px; }
    .row { display: grid; gap: var(--g); }
    .key { box-sizing: border-box; display: flex; align-items: center; justify-content: center; min-width: 0; height: var(--h); padding: 0 4px;
      border-radius: 10px; background: #1f2d44; box-shadow: 0 2px 0 #070d17; cursor: pointer; overflow: hidden; white-space: nowrap; }
    .key.fn { background: #15233a; color: #b4c3d8; font-size: 17px; font-weight: 600; }
    .key.space { color: #7f93ae; font-size: 15px; font-weight: 500; }
    .key.enter, .key.on { background: #0e8a78; color: #fff; }
    .key.hide { font-size: 15px; }
    .key.down { background: #3a5378; transform: translateY(1px); box-shadow: none; }
    .key.enter.down, .key.on.down { background: #12a58f; }
    .key svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }`;
  const panel = document.createElement('div');
  panel.className = 'kb';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Ekran klaviaturasi');
  root.append(style, panel);
  const specs = new WeakMap();

  const ICON = {
    bs: '<svg viewBox="0 0 24 24"><path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="m12 9 6 6m0-6-6 6"/></svg>',
    enter: '<svg viewBox="0 0 24 24"><path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/></svg>',
    shift: '<svg viewBox="0 0 24 24"><path d="M12 4 4 12h4.5v7h7v-7H20z"/></svg>',
    caps: '<svg viewBox="0 0 24 24"><path d="M12 3 4 11h4.5v5h7v-5H20z"/><path d="M8.5 20h7"/></svg>',
    dock: '<svg viewBox="0 0 24 24"><path d="m8 8 4-4 4 4M12 4v16m-4-4 4 4 4-4"/></svg>',
  };
  const isLetter = (t) => /\p{L}/u.test(t);
  const shown = (t) => (shift && isLetter(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  function label(b, spec) {
    if (spec.t !== undefined) {
      b.textContent = shown(spec.t);
      return;
    }
    b.classList.add('fn', spec.k);
    if (spec.k === 'shift') {
      b.innerHTML = shift === 2 ? ICON.caps : ICON.shift;
      b.classList.toggle('on', shift > 0);
      b.setAttribute('aria-label', 'Katta harf');
    } else if (ICON[spec.k]) {
      b.innerHTML = ICON[spec.k];
      b.setAttribute('aria-label', { bs: 'O‘chirish', enter: 'Kiritish', dock: 'Klaviaturani tepaga/pastga' }[spec.k]);
    } else {
      b.textContent = {
        space: layout === 'kir' ? 'Кирилл' : layout === 'lat' ? 'Lotin' : '',
        lang: layout === 'lat' ? 'Кир' : 'Lot',
        sym: '?123',
        abc: textLang === 'kir' ? 'АБВ' : 'ABC',
        hide: 'Yopish',
        clear: 'C',
      }[spec.k];
      if (spec.k === 'space') b.setAttribute('aria-label', 'Probel');
    }
  }
  function render() {
    const L = LAYOUTS[layout];
    panel.className = `kb${L.pad ? ' pad' : ''}${dock === 'top' ? ' top' : ''}`;
    panel.dataset.layout = layout;
    panel.replaceChildren(...L.rows.map((row) => {
      const r = document.createElement('div');
      r.className = 'row';
      r.style.gridTemplateColumns = `repeat(${L.u}, minmax(0, 1fr))`;
      const items = row.map((x) => (typeof x === 'string' ? { t: x, s: 2 } : x));
      const used = items.reduce((a, x) => a + x.s, 0);
      let col = Math.floor((L.u - used) / 2) + 1;
      for (const spec of items) {
        const b = document.createElement('div');
        b.className = 'key';
        b.setAttribute('role', 'button');
        b.style.gridColumn = `${col} / span ${spec.s}`;
        col += spec.s;
        label(b, spec);
        specs.set(b, spec);
        r.append(b);
      }
      return r;
    }));
  }

  /* yozish */
  const focusTarget = () => {
    if (!target || !target.isConnected) {
      hide();
      return false;
    }
    if (document.activeElement !== target) target.focus({ preventScroll: true });
    return true;
  };
  function manual(el, text, inputType) {
    if (!('value' in el)) return;
    let s = null;
    let e = null;
    try {
      s = el.selectionStart;
      e = el.selectionEnd;
    } catch {}
    const v = String(el.value);
    if (s == null) el.value = inputType === 'deleteContentBackward' ? v.slice(0, -1) : v + text;
    else if (inputType === 'deleteContentBackward') el.setRangeText('', s === e && s > 0 ? s - 1 : s, e, 'end');
    else el.setRangeText(text, s, e, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text || null }));
  }
  function typeText(text) {
    if (!focusTarget()) return;
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {}
    if (!ok) manual(target, text, 'insertText');
  }
  function backspace() {
    if (!focusTarget()) return;
    let ok = false;
    try {
      ok = document.execCommand('delete', false);
    } catch {}
    if (!ok) manual(target, '', 'deleteContentBackward');
  }
  function clearAll() {
    if (!focusTarget()) return;
    const el = target;
    let ok = false;
    try {
      if (typeof el.select === 'function') el.select();
      else document.execCommand('selectAll');
      ok = document.execCommand('delete', false);
    } catch {}
    if (!ok && 'value' in el) {
      el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    }
  }
  function enter() {
    if (!focusTarget()) return;
    const el = target;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) {
      let ok = false;
      try {
        ok = document.execCommand('insertLineBreak');
      } catch {}
      if (!ok) typeText('\n');
      return;
    }
    const init = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (!go || !el.isConnected) return; // sahifa o'zi Enter'ni ishlatdi
    if (el.form) {
      try {
        el.form.requestSubmit();
      } catch {}
    } else hide();
  }

  function press(spec) {
    if (spec.t !== undefined) {
      typeText(shown(spec.t));
      if (shift === 1) {
        shift = 0;
        render();
      }
      return;
    }
    switch (spec.k) {
      case 'bs': return backspace();
      case 'enter': return enter();
      case 'space': return typeText(' ');
      case 'clear': return clearAll();
      case 'hide': return hide();
      case 'shift': {
        const now = Date.now();
        shift = shift === 1 && now - lastShiftAt < 450 ? 2 : shift ? 0 : 1;
        lastShiftAt = now;
        return render();
      }
      case 'lang':
        textLang = layout === 'lat' ? 'kir' : 'lat';
        store.set('oq-osk-lang', textLang);
        layout = textLang;
        shift = 0;
        return render();
      case 'sym':
        layout = 'sym';
        return render();
      case 'abc':
        layout = textLang;
        return render();
      case 'dock':
        dock = dock === 'top' ? 'bottom' : 'top';
        store.set('oq-osk-dock', dock);
        place();
        render();
        return fit();
      default:
    }
  }

  /* klaviatura tugmalari: fokus maydondan ketmasin, sahifaning "tashqariga bosildi" hodisalariga tushmasin */
  let repeat = 0;
  const stopRepeat = () => {
    clearTimeout(repeat);
    clearInterval(repeat);
    repeat = 0;
    for (const b of panel.querySelectorAll('.key.down')) setTimeout(() => b.classList.remove('down'), 60);
  };
  panel.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const b = e.target.closest?.('.key');
    const spec = b && specs.get(b);
    if (!spec) return;
    b.classList.add('down');
    press(spec);
    if (spec.k === 'bs') {
      stopRepeat();
      b.classList.add('down');
      repeat = setTimeout(() => (repeat = setInterval(backspace, 60)), 450);
    }
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) panel.addEventListener(t, (e) => {
    e.stopPropagation();
    stopRepeat();
  });
  for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) panel.addEventListener(t, (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  for (const t of ['touchstart', 'touchmove', 'touchend']) panel.addEventListener(t, (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });

  /* joylashuv va maydonni ko'rinadigan qilish */
  function place() {
    let parent = document.documentElement;
    const dlg = target?.closest?.('dialog');
    try {
      if (dlg && dlg.open && dlg.matches(':modal')) parent = dlg;
    } catch {}
    if (host.parentNode !== parent) parent.append(host);
    hostCss(visible ? `display: block !important; ${dock === 'top' ? 'top: 0 !important;' : 'bottom: 0 !important;'}` : 'display: none !important;');
  }
  const saved = [];
  const setTmp = (el, prop, value) => {
    saved.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  };
  const restore = () => {
    while (saved.length) {
      const [el, prop, v, pr] = saved.pop();
      if (v) el.style.setProperty(prop, v, pr);
      else el.style.removeProperty(prop);
    }
  };
  const scrollParent = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') return p;
    }
    return document.body;
  };
  function fit() {
    restore();
    if (!visible || !target || !target.isConnected) return;
    const h = Math.ceil(panel.getBoundingClientRect().height);
    const dlg = host.parentNode?.tagName === 'DIALOG' ? host.parentNode : null;
    if (dlg) {
      setTmp(dlg, dock === 'top' ? 'margin-top' : 'margin-bottom', `${h + 8}px`);
      setTmp(dlg, 'max-height', `calc(100vh - ${h + 24}px)`);
    }
    const covered = () => {
      const r = target.getBoundingClientRect();
      return dock === 'top' ? r.top < h + 8 : r.bottom > innerHeight - h - 8;
    };
    if (!covered()) return;
    if (!dlg && dock === 'bottom') {
      const sc = scrollParent(target);
      setTmp(sc, 'padding-bottom', `${parseFloat(getComputedStyle(sc).paddingBottom) + h}px`);
    }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function setVisible(v) {
    visible = v;
    place();
    clearInterval(watchTimer);
    // maydon o'chib ketsa (oyna yopildi, sahifa almashdi) — klaviatura ham yopiladi
    if (v) watchTimer = setInterval(() => {
      if (!target || !target.isConnected || (document.activeElement !== target && !editable(document.activeElement))) hide();
    }, 600);
  }
  function show(el) {
    clearTimeout(hideTimer);
    if (mode === 'off' || !editable(el)) return;
    const kind = kindOf(el);
    const next = kind === 'text' ? (target === el && TEXT_LAYOUTS.includes(layout) ? layout : textLang) : kind;
    if (visible && target === el && next === layout) return;
    if (target !== el) shift = 0;
    target = el;
    layout = next;
    render();
    if (!visible) setVisible(true);
    else place();
    fit();
  }
  function hide() {
    clearTimeout(hideTimer);
    stopRepeat();
    restore();
    target = null;
    shift = 0;
    if (visible) setVisible(false);
  }
  const wants = (ptr) => mode === 'on' || (mode === 'auto' && (ptr === 'touch' || ptr === 'pen'));

  document.addEventListener('pointerdown', (e) => {
    if (e.target === host) return;
    lastPtr = e.pointerType || '';
    const el = e.target;
    // allaqachon fokusdagi maydonga qayta bosildi (klaviatura yopilgan edi) — yana ochiladi
    if (editable(el) && wants(lastPtr)) setTimeout(() => document.activeElement === el && show(el), 0);
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el === host) return;
    if (editable(el) && (visible || wants(lastPtr))) show(el);
    else if (visible) hideSoon();
  }, true);
  document.addEventListener('focusout', (e) => {
    if (visible && e.target === target) hideSoon();
  }, true);
  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== target && editable(a)) show(a);
      else if (a !== target) hide();
    }, 160);
  }
  // haqiqiy klaviaturadan yozildi — demak klaviatura bor, ekrandagisi kerak emas
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !visible || mode !== 'auto') return;
    if (e.key.length === 1 || e.key === 'Backspace') hide();
  }, true);
  window.addEventListener('resize', () => visible && fit());

  const setMode = (m) => {
    mode = ['auto', 'on', 'off'].includes(m) ? m : 'auto';
    if (mode === 'off') hide();
  };
  onMode(setMode);
  return { setMode, show, hide, state: () => ({ visible, layout, mode, dock }) };
}
// OSK:END

let osk = null;
function startKeyboard() {
  let mode = 'auto';
  try {
    mode = ipcRenderer.sendSync('oq:osk:get') || 'auto';
  } catch {}
  osk = mountKeyboard({ mode, onMode: (cb) => ipcRenderer.on('oq:osk', (_e, m) => cb(m)) });
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', startKeyboard, { once: true });
else startKeyboard();
