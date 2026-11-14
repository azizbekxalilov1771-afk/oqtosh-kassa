import { setupProblem, watchUser, login, loginWithGoogle, isCancelled, redirectError, logout, resetPassword, sendVerify, refreshUser, api, authMessage, currentEmail } from './auth.js';
import { $, $$, el, btn, busy, toast } from './ui.js';

const PAGES = {
  '': { title: 'Bosh panel — savdo', load: () => import('./pages/dashboard.js') },
  kalitlar: { title: 'Kalitlar va ulanishlar', load: () => import('./pages/integrations.js') },
  restoran: { title: 'Restoran ma’lumotlari', load: () => import('./pages/restaurant.js') },
  manzillar: { title: 'Manzillar', load: () => import('./pages/locations.js') },
  yangiliklar: { title: 'Yangiliklar', load: () => import('./pages/news.js') },
  bolimlar: { title: 'Bo‘limlar', load: () => import('./pages/sections.js') },
  buyurtmalar: { title: 'Buyurtmalar', load: () => import('./pages/orders.js') },
  stollar: { title: 'Stollar', load: () => import('./pages/tables.js') },
  menyu: { title: 'Menyu', load: () => import('./pages/menu.js') },
  mehmonlar: { title: 'Mehmonlar', load: () => import('./pages/guests.js') },
  qurilmalar: { title: 'Qurilmalar', load: () => import('./pages/devices.js') },
  tayyorlash: { title: 'Tayyorlash joylari', load: () => import('./pages/kitchen.js') },
  chek: { title: 'Chek ko‘rinishi', load: () => import('./pages/receipt.js') },
  owner: { title: 'Owner kirishi', load: () => import('./pages/owners.js') },
  'stol-menyu': { title: 'Stol menyusi', load: () => import('./pages/printmenu.js') },
  misonsiz: { title: 'Misonsiz ishlash', load: () => import('./pages/misonsiz.js') },
  'menyu-tahrir': { title: 'Menyu tahriri', load: () => import('./pages/ownmenu.js') },
  yetkazish: { title: 'Yetkazib berish', load: () => import('./pages/delivery.js') },
  xodimlar: { title: 'Xodimlar va ruxsatlar', load: () => import('./pages/staff.js') },
  tolovlar: { title: 'To‘lovlar', load: () => import('./pages/payments.js') },
  ombor: { title: 'Ombor', load: () => import('./pages/stock.js') },
  shikoyatlar: { title: 'Shikoyatlar', load: () => import('./pages/complaints.js') },
};

const screens = { setup: $('#screen-setup'), login: $('#screen-login'), verify: $('#screen-verify'), denied: $('#screen-denied'), app: $('#app') };
function show(name) {
  for (const [k, node] of Object.entries(screens)) node.hidden = k !== name;
}

const ctx = { me: null };

/* ───────── Kirish ───────── */
const loginForm = $('#login-form');
const loginError = $('#login-error');
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const { email, password } = Object.fromEntries(new FormData(loginForm));
  await busy(loginForm.querySelector('button[type=submit]'), 'Kirilmoqda…', async () => {
    try {
      await login(email, password);
    } catch (err) {
      loginError.textContent = authMessage(err);
      loginError.hidden = false;
    }
  });
});
$('#google-login').addEventListener('click', (e) => busy(e.currentTarget, 'Google oynasi ochilmoqda…', async () => {
  loginError.hidden = true;
  try {
    await loginWithGoogle();
  } catch (err) {
    if (isCancelled(err)) return;
    loginError.textContent = authMessage(err);
    loginError.hidden = false;
  }
}));
redirectError.then((err) => {
  if (!err || isCancelled(err)) return;
  loginError.textContent = authMessage(err);
  loginError.hidden = false;
});
$('#forgot').addEventListener('click', async () => {
  const email = loginForm.elements.email.value.trim();
  if (!email) {
    loginError.textContent = 'Avval emailingizni yozing — tiklash havolasi shu manzilga yuboriladi.';
    loginError.hidden = false;
    return loginForm.elements.email.focus();
  }
  try {
    await resetPassword(email);
    toast('Parolni tiklash havolasi emailingizga yuborildi.');
  } catch (err) {
    toast(authMessage(err), 'error');
  }
});

$('#send-verify').addEventListener('click', (e) => busy(e.currentTarget, 'Yuborilmoqda…', async () => {
  try {
    await sendVerify();
    toast('Tasdiqlash xati yuborildi. Pochtangizni tekshiring.');
  } catch (err) {
    toast(authMessage(err), 'error');
  }
}));
$('#recheck-verify').addEventListener('click', (e) => busy(e.currentTarget, 'Tekshirilmoqda…', async () => {
  await refreshUser();
  await enter();
}));
$$('[data-logout]').forEach((b) => b.addEventListener('click', () => logout()));
window.addEventListener('admin:unauthorized', () => logout());

async function enter() {
  try {
    ctx.me = await api('/me');
  } catch (err) {
    if (err.code === 'unverified') {
      $('#verify-email').textContent = currentEmail();
      return show('verify');
    }
    $('#denied-text').textContent = err.message;
    return show('denied');
  }
  $('#me-email').textContent = ctx.me.email;
  const siteLink = $('#open-site');
  siteLink.hidden = !ctx.me.publicSiteUrl;
  if (ctx.me.publicSiteUrl) siteLink.href = ctx.me.publicSiteUrl;
  show('app');
  route();
}

/* ───────── Sahifalar ───────── */
const key = () => location.hash.replace(/^#\/?/, '').split('?')[0];
let lastKey = null;

async function route() {
  if (screens.app.hidden) return;
  const k = PAGES[key()] ? key() : '';
  if (window.__adminDirty && lastKey !== null && k !== lastKey) {
    if (!confirm('Saqlanmagan o‘zgarishlar bor. Baribir chiqib ketasizmi?')) {
      history.replaceState(null, '', `#/${lastKey}`);
      return;
    }
  }
  window.__adminDirty = false;
  lastKey = k;
  for (const a of $$('.side-nav a')) {
    if (a.dataset.page === k) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${PAGES[k].title} — Admin panel`;
  const root = $('#page');
  root.replaceChildren(el('p', { className: 'muted loading', textContent: 'Yuklanmoqda…' }));
  window.scrollTo(0, 0);
  try {
    const mod = await PAGES[k].load();
    const page = el('div', { className: 'page' });
    await mod.render(page, ctx);
    if (lastKey !== k) return; // foydalanuvchi bu orada boshqa sahifaga o'tdi
    root.replaceChildren(page);
    page.querySelector('h1')?.focus({ preventScroll: true });
  } catch (err) {
    root.replaceChildren(el('div', { className: 'card error-card' },
      el('h2', { textContent: 'Sahifani ochib bo‘lmadi' }),
      el('p', { textContent: err.message }),
      btn('Qayta urinish', route)));
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (window.__adminDirty) e.preventDefault();
});

/* ───────── Boshlash ───────── */
if (setupProblem) {
  $('#setup-text').textContent = setupProblem;
  show('setup');
} else {
  watchUser((user) => {
    if (!user) {
      ctx.me = null;
      lastKey = null;
      window.__adminDirty = false;
      loginForm.reset();
      return show('login');
    }
    enter();
  });
}
