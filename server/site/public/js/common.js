// Ikkala sahifa uchun umumiy yordamchilar. Hech qanday kalit brauzerga tushmaydi —
// barcha ma'lumot serverdagi /api orqali keladi.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false && c !== '') node.append(c);
  return node;
};

export const formatPrice = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;
// Taom qo'shimchalari: "Limon, Qazi ×2"
export const modsLine = (mods) => (mods?.length ? mods.map((m) => (m.qty > 1 ? `${m.name} ×${m.qty}` : m.name)).join(', ') : '');
// Taom haqida qisqa: "350 g · 420 kkal · 3 ta qoldi"
export const dishFacts = (i) => [i.weight, i.nutrition?.kcal ? `${Math.round(i.nutrition.kcal)} kkal` : '', i.available && i.left > 0 ? `${i.left} ta qoldi` : ''].filter(Boolean).join(' · ');
export const phoneHref = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
export const handle = (v, host) => String(v).replace(new RegExp(`^https?://(www\\.)?${host}/`), '').replace(/^@/, '').replace(/\/$/, '');

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}, ${m[1]}` : '';
}

// Xodim sahifalarida brauzer o'z belgisini (qurilma ID) yuboradi — admin panel "Qurilmalar"da
// shu bo'yicha asosiy kassa kompyuteri (chek printeri) tanlanadi. Mijoz sahifalarida yuborilmaydi.
const STAFF_PAGE = /\/(ofitsiant|kassa|kuryer)\.html$/.exec(location.pathname)?.[1] || '';
export const deviceId = (() => {
  if (!STAFF_PAGE) return '';
  try {
    let v = localStorage.getItem('oq_device');
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(v || '')) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
      localStorage.setItem('oq_device', v);
    }
    return v;
  } catch {
    return '';
  }
})();

// Telegram mini-ilova (Telegram Web'da iframe ichida cookie yuborilmaydi) — sessiya kaliti sarlavhada
export const tgSession = {
  get() {
    try {
      return sessionStorage.getItem('oq_tg_session') || '';
    } catch {
      return '';
    }
  },
  set(v) {
    try {
      if (v) sessionStorage.setItem('oq_tg_session', v);
      else sessionStorage.removeItem('oq_tg_session');
    } catch {}
  },
};

// Server bilan aloqa holati: o'zgarganda window'ga "oq:net" hodisasi (detail.up) — xodim sahifalarida banner (offline.js)
let netUp = true;
export function netState(up) {
  if (up === netUp) return;
  netUp = up;
  window.dispatchEvent(new CustomEvent('oq:net', { detail: { up } }));
}
export const isNetUp = () => netUp;

export async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  const tgs = tgSession.get();
  if (tgs) headers['X-Oq-Session'] = tgs;
  if (deviceId) Object.assign(headers, { 'X-Oq-Device': deviceId, 'X-Oq-Page': STAFF_PAGE });
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    netState(false);
    throw Object.assign(new Error('Internet yo‘q — server bilan aloqa uzildi.'), { status: 0, offline: true });
  }
  netState(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Server bilan bog‘lanib bo‘lmadi.'), { status: res.status, code: data.code });
  return data;
}

// "Buyurtma berish" qayerga olib boradi: admin paneldagi havola, bo'sh bo'lsa buyurtma bo'limi
export function orderTarget(info) {
  const url = safeHref(info?.orderUrl) || '/buyurtma.html';
  return { href: url, external: /^https?:\/\//.test(url) };
}

export function wireOrderLinks(info) {
  const { href, external } = orderTarget(info);
  for (const a of $$('[data-order]')) {
    a.href = href;
    if (info?.orderLabel) a.textContent = info.orderLabel;
    if (external) Object.assign(a, { target: '_blank', rel: 'noopener' });
  }
}

// Admin kiritgan havolalar uchun ikkinchi himoya (server ham tekshiradi)
export const safeHref = (v) => (/^(https?:\/\/|\/(?!\/)|#|tel:)/i.test(String(v || '')) ? v : '');

// [data-info="name"] kabi elementlarga matn, logo bo'lsa rasm
export function applyInfo(info) {
  for (const node of $$('[data-info]')) {
    const v = info[node.dataset.info];
    if (typeof v === 'string' && v) node.textContent = v;
  }
  // Admin panelda logo yuklanmagan bo'lsa — restoranning asosiy logosi (/logo.jpg)
  const logo = info.logo || '/logo.jpg';
  document.body.classList.add('has-logo');
  for (const mark of $$('[data-logo]')) {
    const img = el('img', { src: logo, alt: mark.dataset.logo === 'hero' ? info.name || 'Oqtosh' : '', className: mark.getAttribute('class') });
    img.addEventListener('error', () => {
      img.replaceWith(mark);
      document.body.classList.remove('has-logo');
    });
    mark.replaceWith(img);
  }
}

/* Sopol lagan naqshi — logo rasmi bo'lmasa shu belgi logo vazifasini bajaradi */
export function drawLagan(svg) {
  if (!svg) return;
  const ring = (n, step, offset, build) => Array.from({ length: n }, (_, i) => build(i * step + offset)).join('');
  svg.innerHTML = `
    <defs>
      <radialGradient id="glaze" cx="42%" cy="38%" r="70%">
        <stop offset="0" class="lagan-glaze-hi"/><stop offset="1" class="lagan-glaze-lo"/>
      </radialGradient>
      <path id="bodom" d="M0,-158 C24,-128 24,-88 0,-66 C-24,-88 -24,-128 0,-158Z"/>
      <path id="bodom-ich" d="M0,-145 C12,-126 12,-99 0,-84 C-12,-99 -12,-126 0,-145Z"/>
      <path id="tomchi" d="M0,-120 C8,-110 8,-98 0,-92 C-8,-98 -8,-110 0,-120Z"/>
      <path id="gul" d="M0,-48 C12,-36 12,-19 0,-11 C-12,-19 -12,-36 0,-48Z"/>
    </defs>
    <circle r="198" fill="url(#glaze)"/>
    <circle r="185" class="s-cobalt" stroke-width="18"/>
    ${ring(40, 9, 0, (a) => `<circle cy="-185" r="3.2" class="f-plate" transform="rotate(${a})"/>`)}
    <circle r="171" class="s-ishkor" stroke-width="2"/>
    ${ring(12, 30, 0, (a) => `<use href="#bodom" class="f-ishkor" transform="rotate(${a})"/><use href="#bodom-ich" class="f-cobalt" transform="rotate(${a})"/>`)}
    ${ring(12, 30, 15, (a) => `<use href="#tomchi" class="f-cobalt" transform="rotate(${a})"/>`)}
    ${ring(24, 15, 7.5, (a) => `<circle cy="-150" r="2.6" class="f-anor" transform="rotate(${a})"/>`)}
    <circle r="63" class="s-cobalt" stroke-width="5"/>
    <circle r="56" class="s-ishkor" stroke-width="1.5"/>
    ${ring(8, 45, 0, (a) => `<use href="#gul" class="f-cobalt" transform="rotate(${a})"/>`)}
    ${ring(8, 45, 22.5, (a) => `<use href="#gul" class="f-ishkor" transform="rotate(${a}) scale(.62)"/>`)}
    <circle r="8" class="f-anor"/>`;
}

export function setYear() {
  for (const n of $$('[data-year]')) n.textContent = new Date().getFullYear();
}

/* ───────── Android ilova (WebView) uchun ───────── */
// Ilova User-Agent'iga "OqtoshApp/<versiya>" qo'shadi va window.AndroidApp ko'prigini beradi.
export const inApp = /OqtoshApp\//.test(navigator.userAgent);
if (inApp) document.documentElement.classList.add('in-app');
// Telefondagi "orqaga" tugmasi: avval ochiq oynani (taom tanlash, skaner) yopadi
window.__appBack = () => {
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  if (dialogs.length) {
    dialogs.at(-1).close();
    return true;
  }
  const scan = document.querySelector('.scan-overlay .scan-close');
  if (scan) {
    scan.click();
    return true;
  }
  return false;
};
// "Pastga tortib yangilash" xarita, ochiq oyna va kod kiritishda ishlamasin
if (window.AndroidApp?.setPull) {
  addEventListener('touchstart', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    let block = Boolean(t?.closest('dialog[open], .map-box, .scan-overlay, .otp, input, textarea, select'));
    // ichki aylantiriladigan blok yuqoriga to'liq qaytmagan bo'lsa ham yangilanmasin
    for (let n = t; !block && n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(n).overflowY)) block = true;
    }
    window.AndroidApp.setPull(!block);
  }, { passive: true, capture: true });
  addEventListener('touchend', () => setTimeout(() => window.AndroidApp.setPull(true), 50), { passive: true, capture: true });
}
