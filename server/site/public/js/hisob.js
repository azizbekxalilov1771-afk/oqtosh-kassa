import { $, el, api, applyInfo } from './common.js';
import { mountLogin } from './tglogin.js';

// Ilovasiz hisobni o'chirish (Google Play talabi): Telegram orqali tasdiqlash → o'chirish
const zone = $('#delete-zone');

function done() {
  zone.replaceChildren(el('div', { className: 'result-card is-ok' },
    el('h2', { textContent: 'Hisobingiz o‘chirildi' }),
    el('p', { textContent: 'Xohlasangiz, istalgan vaqtda Telegram orqali qaytadan kirishingiz mumkin.' })));
}

function ask(profile) {
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const btn = el('button', { type: 'button', className: 'btn btn-leave btn-wide', textContent: 'Hisobimni o‘chirish' });
  btn.addEventListener('click', async () => {
    if (!confirm('Hisobingiz va shaxsiy ma’lumotlaringiz o‘chirilsinmi? Bu ishni qaytarib bo‘lmaydi.')) return;
    btn.disabled = true;
    err.hidden = true;
    try {
      await api('/api/me/delete', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      done();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  zone.replaceChildren(el('div', { className: 'delete-panel' },
    el('p', {}, 'Siz kirgansiz: ', el('b', { textContent: profile.name || 'Mijoz' }), profile.phone ? ` (${profile.phone})` : ''),
    err, btn));
}

try {
  const [info, me] = await Promise.all([api('/api/info'), api('/api/me')]);
  applyInfo(info);
  if (me.profile) ask(me.profile);
  else if (info.loginReady === false) zone.replaceChildren(el('p', { className: 'notice', textContent: 'Kirish hozir ishlamayapti. Shikoyat va takliflar shakli orqali yozing — qo‘lda o‘chiramiz.' }));
  else {
    mountLogin(zone, {
      title: 'Hisobingizni tasdiqlang',
      text: 'Hisobni faqat egasi o‘chira oladi — Telegram orqali kiring.',
      onSuccess: (p) => ask(p),
    });
  }
} catch {
  zone.replaceChildren(el('p', { className: 'form-error', textContent: 'Sahifani yuklab bo‘lmadi. Internetni tekshiring.' }));
}
