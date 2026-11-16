import { el, api } from './common.js';

// Xodim kirishi: faqat 4 xonali PIN — telefon raqamisiz, Telegram'siz. PIN kimniki bo'lsa, o'sha xodim kiradi
// (admin har bir xodimga alohida PIN beradi, ikkitasida bir xil bo'lmaydi).
// Chapda restoran logosi va soat, o'ngda PIN qismi. Klaviaturadan ham terish mumkin (raqamlar, Backspace, Enter).
//   mountPinLogin(root, { title, logo, name, onSuccess(profile) })

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const WEEK = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];

export function mountPinLogin(root, { title, logo = '/logo.jpg', name = 'Oqtosh Restoran', onSuccess }) {
  let pin = '';
  let busy = false;
  let clockTimer = null;
  try {
    localStorage.removeItem('oq_staff_recent'); // eski (telefon + PIN) usuldan qolgan ro'yxat
  } catch {}

  const clock = el('p', { className: 'pin-clock' });
  const tick = () => {
    if (!clock.isConnected && clockTimer) return clearInterval(clockTimer);
    const d = new Date();
    clock.replaceChildren(el('strong', { textContent: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }),
      el('span', { textContent: `${d.getDate()}-${MONTHS[d.getMonth()]}, ${WEEK[d.getDay()]}` }));
  };
  const dots = el('div', { className: 'pin-dots', ariaHidden: 'true' }, [0, 1, 2, 3].map(() => el('span')));
  const status = el('p', { className: 'visually-hidden', role: 'status' });
  const err = el('p', { className: 'form-error pin-error', role: 'alert', hidden: true });
  const note = el('p', { className: 'pin-note muted small', hidden: true });
  const panel = el('section', { className: 'pin-panel', ariaLabel: 'PIN bilan kirish' });

  const paintDots = () => {
    [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i < pin.length));
    status.textContent = `${pin.length} ta raqam terildi`;
  };
  const say = (text) => {
    err.textContent = text;
    err.hidden = !text;
  };
  const shake = () => {
    dots.classList.remove('is-shake');
    void dots.offsetWidth;
    dots.classList.add('is-shake');
  };

  async function submit() {
    if (busy || pin.length !== 4) return;
    busy = true;
    panel.classList.add('is-busy');
    say('');
    try {
      const r = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ pin }) });
      clearInterval(clockTimer);
      document.removeEventListener('keydown', onKey);
      onSuccess(r.profile);
    } catch (e) {
      say(e.message);
      shake();
      pin = '';
      paintDots();
    } finally {
      busy = false;
      panel.classList.remove('is-busy');
    }
  }

  const press = (k) => {
    if (busy) return;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'clear') pin = '';
    else if (/^\d$/.test(k) && pin.length < 4) pin += k;
    say('');
    paintDots();
    if (pin.length === 4) submit();
  };
  const onKey = (e) => {
    if (!panel.isConnected) return document.removeEventListener('keydown', onKey);
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Escape') press('clear');
    else if (e.key === 'Enter') submit();
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  const pad = el('div', { className: 'pin-pad' },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => el('button', { type: 'button', className: 'pin-key', textContent: n, onclick: () => press(n) })),
    el('button', { type: 'button', className: 'pin-key is-soft', ariaLabel: 'Tozalash', textContent: 'C', onclick: () => press('clear') }),
    el('button', { type: 'button', className: 'pin-key', textContent: '0', onclick: () => press('0') }),
    el('button', { type: 'button', className: 'pin-key is-soft', ariaLabel: 'O‘chirish', textContent: '⌫', onclick: () => press('del') }));

  panel.append(
    el('h2', { textContent: 'PIN’ingizni tering' }),
    el('p', { className: 'muted', textContent: 'Admin bergan shaxsiy 4 xonali PIN — telefon raqami shart emas.' }),
    dots, status, err, pad, note);
  paintDots();

  root.replaceChildren(el('div', { className: 'pin-login' },
    el('aside', { className: 'pin-brand' },
      el('img', { className: 'pin-logo', src: logo, alt: '', width: 160, height: 160, onerror() { this.src = '/logo.jpg'; this.onerror = null; } }),
      el('h1', { textContent: name }),
      el('p', { className: 'pin-title', textContent: title }),
      clock),
    panel));
  tick();
  clockTimer = setInterval(tick, 20_000);

  // restoran Wi‑Fi talabi bo'lsa — eslatma
  api('/api/auth/password').then((w) => {
    if (w.wifiOnly && !w.onSite) {
      note.textContent = '📶 Ofitsiant, kassir va omborchi faqat restoran Wi‑Fi’siga ulanganda kira oladi.';
      note.hidden = false;
    }
  }).catch(() => {});
}
