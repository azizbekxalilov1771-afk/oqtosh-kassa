import { setupProblem, watchUser, login, loginWithGoogle, isCancelled, redirectError, logout, resetPassword, sendVerify, refreshUser, api, authMessage, currentEmail, pinDevice, hasPinSession, pinLogin, setupPinHere, forgetPinHere } from './auth.js';
import { $, $$, el, btn, busy, toast } from './ui.js';

const PAGES = {
  '': { title: 'Bosh panel — savdo', load: () => import('./pages/dashboard.js') },
  hisobot: { title: 'Hisobotlar', load: () => import('./pages/report.js') },
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

const screens = { setup: $('#screen-setup'), login: $('#screen-login'), pin: $('#screen-pin'), verify: $('#screen-verify'), denied: $('#screen-denied'), app: $('#app') };
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
// Android ilovasida (Oqtosh Admin) Google kirish oynasi ishlamaydi (Google ilova ichidagi oynaga ruxsat bermaydi):
// email + parol bilan kiriladi, keyin shu telefonda PIN o'rnatiladi
if (/OqtoshApp\//.test(navigator.userAgent)) {
  $('#google-login').hidden = true;
  $('.gate-or span').textContent = 'email va parol bilan';
}
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
$$('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
  await logout();
  if (pinDevice()) showPin();
}));
window.addEventListener('admin:unauthorized', async () => {
  await logout();
  if (pinDevice()) showPin();
  else show('login');
});

/* ───────── PIN bilan kirish (xodimlar kabi: chapda logo, o'ngda raqamlar) ───────── */
const WEEK = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
let pinKeys = null;
function showPin() {
  const d = pinDevice();
  if (!d) return show('login');
  let pin = '';
  let busyPin = false;
  const dots = el('div', { className: 'pin-dots', ariaHidden: 'true' }, [0, 1, 2, 3, 4, 5].map(() => el('span')));
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const paint = () => [...dots.children].forEach((x, i) => {
    x.classList.toggle('is-on', i < pin.length);
    x.hidden = i >= Math.max(4, pin.length);
  });
  const go = async () => {
    if (busyPin || pin.length < 4) return;
    busyPin = true;
    err.hidden = true;
    try {
      await pinLogin(pin);
      document.removeEventListener('keydown', pinKeys);
      await enter();
    } catch (e) {
      pin = '';
      paint();
      err.textContent = e.message;
      err.hidden = false;
      dots.classList.remove('is-shake');
      void dots.offsetWidth;
      dots.classList.add('is-shake');
      if (e.code === 'pin-reset') setTimeout(() => show('login'), 1800);
    } finally {
      busyPin = false;
    }
  };
  const press = (k) => {
    if (busyPin) return;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'ok') return go();
    else if (pin.length < 6) pin += k;
    err.hidden = true;
    paint();
  };
  const key = (k, label = k, cls = '') => el('button', { type: 'button', className: `pin-key ${cls}`.trim(), textContent: label, ariaLabel: k === 'del' ? 'O‘chirish' : k === 'ok' ? 'Kirish' : label, onclick: () => press(k) });
  document.removeEventListener('keydown', pinKeys);
  pinKeys = (e) => {
    if (screens.pin.hidden) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') press('ok');
  };
  document.addEventListener('keydown', pinKeys);
  const clock = el('p', { className: 'pin-clock' });
  const t = new Date();
  clock.append(el('strong', { textContent: t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }), el('span', { textContent: `${t.getDate()}-${MONTHS[t.getMonth()]}, ${WEEK[t.getDay()]}` }));
  screens.pin.replaceChildren(
    el('aside', { className: 'pin-brand' },
      el('img', { className: 'pin-logo', src: '/logo.jpg', alt: '', width: 220, height: 220 }),
      el('h1', { textContent: 'Admin panel' }),
      el('p', { className: 'pin-who', textContent: d.email || '' }),
      clock),
    el('section', { className: 'pin-panel', ariaLabel: 'PIN bilan kirish' },
      el('h2', { textContent: 'PIN’ingizni tering' }),
      el('p', { className: 'muted', textContent: 'Shu kompyuterda o‘rnatgan 4–6 xonali PIN.' }),
      dots, err,
      el('div', { className: 'pin-pad' },
        ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => key(n)),
        key('del', '⌫', 'is-soft'), key('0'), key('ok', 'Kirish', 'is-ok')),
      el('div', { className: 'pin-alt' },
        btn('Email bilan kirish', () => show('login'), 'btn-text'),
        btn('Bu qurilmada PIN’ni o‘chirish', async () => {
          if (!confirm('Bu kompyuterda PIN bilan kirish o‘chirilsinmi? Keyin email bilan kirasiz.')) return;
          await forgetPinHere();
          show('login');
        }, 'btn-text'))));
  paint();
  show('pin');
}

// Email bilan kirgandan keyin: "Bu qurilmada PIN bilan kirish" (ixtiyoriy)
function pinSetupDialog() {
  const dlg = el('dialog', { className: 'pin-setup' });
  const a = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'new-password', maxLength: 6, pattern: '\\d*', placeholder: '••••', ariaLabel: 'Yangi PIN' });
  const b = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'new-password', maxLength: 6, pattern: '\\d*', placeholder: '••••', ariaLabel: 'PIN’ni takrorlang' });
  const err = el('p', { className: 'form-error', hidden: true });
  const save = btn('PIN’ni saqlash', async (e) => {
    err.hidden = true;
    if (!/^\d{4,6}$/.test(a.value)) {
      err.textContent = 'PIN 4–6 ta raqam bo‘lsin.';
      err.hidden = false;
      return;
    }
    if (a.value !== b.value) {
      err.textContent = 'Ikkala PIN bir xil emas.';
      err.hidden = false;
      return;
    }
    await busy(e.currentTarget, 'Saqlanmoqda…', async () => {
      try {
        await setupPinHere(a.value);
        dlg.close();
        toast('Tayyor: keyingi safar shu kompyuterda faqat PIN bilan kirasiz.');
        $('#pin-offer').hidden = true;
        paintPinButton();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    });
  });
  dlg.append(
    el('h2', { textContent: 'Bu qurilmada PIN bilan kirish' }),
    el('p', { className: 'muted', textContent: 'Keyingi safar shu kompyuter (yoki telefon)da email va parol o‘rniga 4–6 xonali PIN. PIN faqat shu qurilmada ishlaydi; 5 marta xato terilsa o‘chadi.' }),
    el('label', { className: 'field' }, el('span', { textContent: 'Yangi PIN' }), a),
    el('label', { className: 'field' }, el('span', { textContent: 'Yana bir marta' }), b),
    err,
    el('div', { className: 'row' }, save, btn('Keyinroq', () => {
      try {
        localStorage.setItem('oq_admin_pin_later', String(Date.now()));
      } catch {}
      $('#pin-offer').hidden = true;
      dlg.close();
    }, 'btn-ghost')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  setTimeout(() => a.focus(), 30);
}
function paintPinButton() {
  const b = $('#pin-setup');
  const on = Boolean(pinDevice());
  b.textContent = on ? '🔢 PIN’ni o‘zgartirish' : '🔢 Bu qurilmada PIN bilan kirish';
  b.hidden = Boolean(ctx.me?.pin); // PIN bilan kirganda o'zgartirish uchun email kerak
}
$('#pin-setup').addEventListener('click', () => {
  closeNav();
  pinSetupDialog();
});
$('#pin-offer').addEventListener('click', pinSetupDialog);

/* ───────── Bo'limlar menyusi (☰): kompyuterda yig'iladi, telefonda chapdan chiqadi ───────── */
const navBtn = $('#nav-toggle');
const scrim = $('#nav-scrim');
const mobileNav = () => matchMedia('(max-width: 820px)').matches;
function setNav(open) {
  const shell = screens.app;
  if (mobileNav()) {
    shell.classList.toggle('nav-open', open);
    scrim.hidden = !open;
  } else {
    shell.classList.toggle('nav-collapsed', !open);
    try {
      localStorage.setItem('oq_admin_nav', open ? '1' : '0');
    } catch {}
  }
  navBtn.setAttribute('aria-expanded', String(open));
}
function closeNav() {
  if (mobileNav()) setNav(false);
}
navBtn.addEventListener('click', () => setNav(mobileNav() ? !screens.app.classList.contains('nav-open') : screens.app.classList.contains('nav-collapsed')));
scrim.addEventListener('click', () => setNav(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && screens.app.classList.contains('nav-open')) setNav(false);
});
$('#side-nav').addEventListener('click', (e) => {
  if (e.target.closest('a')) closeNav();
});
try {
  if (localStorage.getItem('oq_admin_nav') === '0') screens.app.classList.add('nav-collapsed');
} catch {}
navBtn.setAttribute('aria-expanded', String(!mobileNav() && !screens.app.classList.contains('nav-collapsed')));

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
  // egasi (owner) — faqat hisobotlar; admin — hamma bo'limlar
  const owner = ctx.me.role === 'owner';
  document.body.classList.toggle('is-owner', owner);
  for (const a of $$('.side-nav [data-page], .side-nav .nav-group')) a.hidden = owner ? a.dataset.page !== 'hisobot' : a.dataset.owner !== undefined;
  paintPinButton();
  show('app');
  route();
  // email bilan kirdi, bu qurilmada PIN yo'q — taklif (bir hafta ichida qayta so'ramaydi)
  let later = 0;
  try {
    later = Number(localStorage.getItem('oq_admin_pin_later')) || 0;
  } catch {}
  $('#pin-offer').hidden = hasPinSession() || Boolean(pinDevice()) || Date.now() - later < 7 * 86_400_000;
}

/* ───────── Sahifalar ───────── */
const key = () => location.hash.replace(/^#\/?/, '').split('?')[0];
let lastKey = null;

async function route() {
  if (screens.app.hidden) return;
  let k = PAGES[key()] ? key() : '';
  if (ctx.me?.role === 'owner' && k !== 'hisobot') k = 'hisobot';
  if (ctx.me?.role !== 'owner' && k === 'hisobot') k = '';
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
      if (hasPinSession()) return enter(); // PIN bilan kirilgan (12 soat)
      if (pinDevice()) return showPin(); // shu qurilmada PIN o'rnatilgan
      return show('login');
    }
    enter();
  });
}
