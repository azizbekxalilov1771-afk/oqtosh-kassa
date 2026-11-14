import { el, api, inApp } from './common.js';

// Telegram orqali kirish bloki: buyurtma va ofitsiant sahifalarida bir xil.
// Telefon brauzeri Telegram'ga o'tganda sahifani qayta yuklashi mumkin — shuning uchun
// so'rov ID'si sessionStorage'da saqlanadi va qaytganda davom etadi.

const KEY = 'oq_login';
const store = {
  get() {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      return v && v.until > Date.now() ? v : null;
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(v));
    } catch {}
  },
  clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  },
};

const STATUS_TEXT = {
  pending: 'Telegram’da botni oching va “Start”ni bosing.',
  contact: 'Botda “📱 Raqamni yuborish” tugmasini bosing.',
  code_sent: 'Kod yuborildi. Telegram’dagi 6 xonali kodni shu yerga yozing.',
  expired: 'Vaqt tugadi. “Qaytadan boshlash”ni bosing.',
};

const TG_PATH = 'M21.4 4.3 18.3 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.5.4-1 .4l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.5 12.9l-4.6-1.4c-1-.3-1-1 .2-1.5L20 3.1c.8-.3 1.6.2 1.4 1.2z';
function tgIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('tg-icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', TG_PATH);
  svg.append(p);
  return svg;
}
const flowStep = (n, t, sub) => el('li', {}, el('span', { className: 'flow-n', textContent: n }), el('strong', { textContent: t }), el('small', { textContent: sub }));
const trackStep = (key, t, sub) => el('li', { className: `track-${key}` }, el('span', { className: 'track-dot', ariaHidden: 'true' }), el('span', {}, el('strong', { textContent: t }), el('small', { textContent: sub })));

// Xodim sahifalarida ikkinchi yo'l: telefon + parol (faqat restoran Wi‑Fi'sidan). Oxirgi tanlov eslab qolinadi.
const pref = {
  get(k) {
    try {
      return localStorage.getItem(k) || '';
    } catch {
      return '';
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export function mountLogin(root, { title, text, onSuccess, staff = false }) {
  let timer = null;
  let current = store.get();
  let pwInfo = null;

  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };

  function idle(errorText = '') {
    stop();
    const startBtn = el('button', { type: 'button', className: 'btn btn-telegram btn-wide' }, tgIcon(), el('span', { textContent: 'Telegram orqali kirish' }));
    const err = el('p', { className: 'form-error', role: 'alert', textContent: errorText, hidden: !errorText });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.lastChild.textContent = 'Tayyorlanmoqda…';
      try {
        const r = await api('/api/auth/start', { method: 'POST', body: '{}' });
        current = { id: r.id, botUrl: r.botUrl, until: Date.now() + r.expiresIn * 1000 };
        store.set(current);
        waiting();
        window.open(r.botUrl, '_blank', 'noopener');
      } catch (e) {
        idle(e.message);
      }
    });
    root.replaceChildren(el('div', { className: 'login login-v2' },
      el('div', { className: 'login-hero' },
        el('span', { className: 'login-logo', ariaHidden: 'true' }, el('img', { src: '/logo.jpg', alt: '', width: 84, height: 84, onerror() { this.remove(); } })),
        el('h1', { textContent: title }),
        el('p', { className: 'login-text', textContent: text })),
      el('ol', { className: 'login-flow', ariaLabel: 'Qanday ishlaydi' },
        flowStep('1', 'Telegram', 'botni oching'),
        flowStep('2', 'Raqam', 'bir tugma bilan'),
        flowStep('3', 'Kod', '6 ta raqam')),
      startBtn, err,
      el('p', { className: 'login-note' }, el('span', { textContent: '🔒', ariaHidden: 'true' }), ' Raqamingiz faqat Telegram’dan olinadi va buyurtmani tasdiqlash uchun ishlatiladi. Parol kerak emas.')));
    if (inApp) reviewBox(root.firstChild);
    if (staff) passwordEntry(root.firstChild, startBtn);
  }

  // Telegram tugmasi ostiga "Parol bilan kirish" (admin yoqqan bo'lsa)
  async function passwordEntry(box, after) {
    try {
      pwInfo = await api('/api/auth/password');
    } catch {
      return;
    }
    if (!pwInfo.enabled || !box.isConnected) return;
    if (pref.get('oq_login_mode') === 'pw' && pwInfo.onSite) return passwordView();
    const b = el('button', { type: 'button', className: 'btn btn-ghost btn-wide btn-pw' },
      el('span', { textContent: '🔑', ariaHidden: 'true' }), el('span', { textContent: ' Parol bilan kirish' }),
      el('small', { textContent: pwInfo.onSite ? ' · restoran Wi‑Fi ✓' : ' · faqat restoran Wi‑Fi’sida' }));
    b.addEventListener('click', () => passwordView());
    after.after(b);
    const lead = box.querySelector('.login-text');
    if (lead) lead.textContent = 'Telegram orqali yoki restoran Wi‑Fi’sida parol bilan kiring.';
    const note = box.querySelector('.login-note');
    if (note) note.lastChild.textContent = ' Telegram orqali kirishda raqamingiz Telegram’dan olinadi, parol kerak emas.';
  }

  function passwordView(errorText = '') {
    stop();
    pref.set('oq_login_mode', 'pw');
    const phone = el('input', { id: 'pw-phone', type: 'tel', inputMode: 'tel', autocomplete: 'tel', placeholder: '+998 90 123 45 67', value: pref.get('oq_staff_phone') || '+998 ' });
    const pass = el('input', { id: 'pw-pass', type: 'password', autocomplete: 'current-password', placeholder: 'Parol', maxLength: 64 });
    const eye = el('button', { type: 'button', className: 'pw-eye', ariaLabel: 'Parolni ko‘rsatish', textContent: '👁' });
    eye.addEventListener('click', () => {
      pass.type = pass.type === 'password' ? 'text' : 'password';
      pass.focus();
    });
    const err = el('p', { className: 'form-error', role: 'alert', textContent: errorText, hidden: !errorText });
    const submit = el('button', { type: 'submit', className: 'btn btn-wide', textContent: 'Kirish' });
    const net = el('div', { className: 'pw-net', role: 'status' });
    const paintNet = () => {
      const on = Boolean(pwInfo?.onSite);
      net.className = `pw-net ${on ? 'is-ok' : 'is-off'}`;
      net.replaceChildren(el('span', { textContent: on ? '✓ Restoran Wi‑Fi’siga ulangansiz' : '✕ Restoran Wi‑Fi’siga ulanmagansiz' }),
        on ? '' : el('small', { textContent: 'Wi‑Fi’ni yoqing va mobil internetni o‘chiring, keyin “Qayta tekshirish”.' }),
        on ? '' : el('button', { type: 'button', className: 'btn-link', textContent: 'Qayta tekshirish', onclick: recheck }));
    };
    async function recheck() {
      try {
        pwInfo = await api('/api/auth/password');
      } catch {}
      paintNet();
    }
    const form = el('form', { className: 'code-form pw-form', noValidate: true },
      el('label', { htmlFor: 'pw-phone', textContent: 'Telefon raqamingiz' }), phone,
      el('label', { htmlFor: 'pw-pass', textContent: 'Parol' }), el('div', { className: 'pw-field' }, pass, eye),
      err, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Tekshirilmoqda…';
      try {
        const r = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ phone: phone.value, password: pass.value }) });
        pref.set('oq_staff_phone', phone.value.trim());
        onSuccess(r.profile);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Kirish';
        if (ex.status === 403) recheck();
      }
    });
    const back = el('button', { type: 'button', className: 'btn-link', textContent: 'Telegram orqali kirish' });
    back.addEventListener('click', () => {
      pref.set('oq_login_mode', 'tg');
      idle();
    });
    paintNet();
    root.replaceChildren(el('div', { className: 'login login-v2' },
      el('div', { className: 'login-hero is-compact' },
        el('span', { className: 'login-logo', ariaHidden: 'true' }, el('img', { src: '/logo.jpg', alt: '', width: 56, height: 56, onerror() { this.remove(); } })),
        el('h1', { textContent: title })),
      el('p', { className: 'login-text pw-lead', textContent: 'Restoran Wi‑Fi’sida — telefon raqamingiz va admin bergan parol bilan.' }),
      net, form, el('div', { className: 'login-actions' }, back)));
    if (!pwInfo) recheck();
    setTimeout(() => (phone.value.length > 6 ? pass : phone).focus({ preventScroll: true }), 50);
  }

  // Faqat ilovada: Google Play tekshiruvchisi Telegram'siz sinov hisobiga kiradi (server kod yoqilgan bo'lsa)
  async function reviewBox(box) {
    try {
      if (!(await api('/api/auth/review')).enabled || !box.isConnected) return;
    } catch {
      return;
    }
    const input = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'off', className: 'review-input', placeholder: 'Sinov kodi', ariaLabel: 'Sinov kodi' });
    const go = el('button', { type: 'submit', className: 'btn btn-small', textContent: 'Kirish' });
    const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
    const form = el('form', { className: 'review-form', noValidate: true }, input, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      err.hidden = true;
      try {
        const r = await api('/api/auth/review', { method: 'POST', body: JSON.stringify({ code: input.value }) });
        store.clear();
        onSuccess(r.profile);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        go.disabled = false;
      }
    });
    box.append(el('details', { className: 'review-login' },
      el('summary', { textContent: 'Google Play sinovchisi uchun kirish' }), form, err));
  }

  function waiting() {
    const status = el('p', { className: 'login-status', ariaLive: 'polite', textContent: STATUS_TEXT.pending });
    const input = el('input', {
      id: 'login-code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, pattern: '[0-9]*',
      className: 'code-input otp-input', ariaLabel: '6 xonali kod',
    });
    const submit = el('button', { type: 'submit', className: 'btn btn-wide', textContent: 'Tasdiqlash' });
    const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
    const cells = el('div', { className: 'otp-cells', ariaHidden: 'true' }, Array.from({ length: 6 }, () => el('span')));
    const paintCells = () => [...cells.children].forEach((c, i) => {
      c.textContent = input.value[i] || '';
      c.classList.toggle('is-on', i === Math.min(input.value.length, 5) && document.activeElement === input);
      c.classList.toggle('is-full', Boolean(input.value[i]));
    });
    for (const ev of ['input', 'focus', 'blur']) input.addEventListener(ev, paintCells);
    const form = el('form', { className: 'code-form', noValidate: true },
      el('label', { htmlFor: 'login-code', textContent: 'Telegram’dan kelgan kod' }),
      el('div', { className: 'otp' }, cells, input), err, submit);

    async function verify() {
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 6) {
        err.textContent = 'Kod 6 ta raqamdan iborat.';
        err.hidden = false;
        return input.focus();
      }
      submit.disabled = true;
      submit.textContent = 'Tekshirilmoqda…';
      err.hidden = true;
      try {
        const r = await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ id: current.id, code }) });
        stop();
        store.clear();
        onSuccess(r.profile);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Tasdiqlash';
        input.select();
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      verify();
    });
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      if (input.value.length === 6 && !submit.disabled) verify();
    });

    const restart = el('button', { type: 'button', className: 'btn-link', textContent: 'Qaytadan boshlash' });
    restart.addEventListener('click', () => {
      store.clear();
      current = null;
      idle();
    });

    const steps = el('ol', { className: 'login-track' },
      trackStep('tg', 'Botda “Start”ni bosing', 'Telegram ochilmasa — pastdagi tugma'),
      trackStep('phone', '“📱 Raqamni yuborish”ni bosing', 'Faqat birinchi marta so‘raladi'),
      trackStep('code', 'Kodni shu yerga yozing', 'Bot yuborgan 6 ta raqam'));
    const paintTrack = (s) => {
      const at = { pending: 0, contact: 1, code_sent: 2 }[s] ?? 0;
      [...steps.children].forEach((li, i) => li.dataset.state = i < at ? 'done' : i === at ? 'now' : 'todo');
    };
    paintTrack('pending');
    root.replaceChildren(el('div', { className: 'login login-v2' },
      el('div', { className: 'login-hero is-compact' },
        el('span', { className: 'login-logo', ariaHidden: 'true' }, el('img', { src: '/logo.jpg', alt: '', width: 56, height: 56, onerror() { this.remove(); } })),
        el('h1', { textContent: title })),
      steps, status, form,
      el('div', { className: 'login-actions' },
        el('a', { className: 'btn btn-telegram', href: current.botUrl, target: '_blank', rel: 'noopener' }, tgIcon(), el('span', { textContent: 'Telegram’ni ochish' })),
        restart)));

    async function poll() {
      if (!current) return;
      try {
        const { status: s } = await api(`/api/auth/status?id=${encodeURIComponent(current.id)}`);
        status.textContent = STATUS_TEXT[s] || '';
        status.dataset.state = s;
        paintTrack(s);
        if (s === 'code_sent' && document.activeElement !== input) input.focus({ preventScroll: true });
        if (s === 'expired' || s === 'used') return stop();
      } catch {}
      timer = setTimeout(poll, document.hidden ? 8000 : 3000);
    }
    poll();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && timer) {
        stop();
        poll();
      }
    });
  }

  if (current) waiting();
  else idle();
  return { destroy: stop };
}
