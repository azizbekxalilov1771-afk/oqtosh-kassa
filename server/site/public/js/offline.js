import { el, netState, isNetUp } from './common.js';

// Xodim sahifalari internetsiz ham ochiladi (kassa kompyuteri, planshet, telefon, kompyuter dasturi):
//   1) /xodim/sw.js sahifa fayllarining nusxasini saqlaydi — internet uzilsa sahifa shu nusxadan ochiladi;
//   2) aloqa uzilganda tepada qizil yo'lak: "Internet yo'q"; har 4 soniyada server tekshiriladi;
//   3) aloqa qaytsa — yo'lak yo'qoladi va sahifa ma'lumotlarni yangilaydi ("oq:online" hodisasi).
// Buyurtma va to'lov faqat server orqali saqlanadi (ikki joyda ikki xil hisob bo'lmasin), shuning uchun
// internetsiz yangi buyurtma yozilmaydi — xodim buni yo'lakda ko'radi.

if ('serviceWorker' in navigator && location.pathname.startsWith('/xodim/') && window.isSecureContext) {
  navigator.serviceWorker.register('/xodim/sw.js', { scope: '/xodim/' }).catch(() => {});
}

const bar = el('div', { className: 'net-banner', role: 'status', hidden: true },
  el('span', { className: 'net-dot', ariaHidden: 'true' }),
  el('b', { textContent: 'Internet yo‘q' }),
  el('span', { className: 'net-text', textContent: 'Server bilan aloqa uzildi. Yangi buyurtma va to‘lov saqlanmaydi — ulanish qaytishi bilan hammasi yangilanadi.' }));
document.body.prepend(bar);

let probe = null;
async function check() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    if (r.ok) netState(true);
  } catch {}
}
function paint(up) {
  bar.hidden = up;
  document.body.classList.toggle('is-offline', !up);
  clearInterval(probe);
  probe = up ? null : setInterval(check, 4000);
  if (up) window.dispatchEvent(new Event('oq:online'));
}
window.addEventListener('oq:net', (e) => paint(e.detail.up));
window.addEventListener('offline', () => netState(false));
window.addEventListener('online', check);
if (!navigator.onLine) netState(false);
else if (!isNetUp()) paint(false);

// Sahifa umuman yuklanmasa (birinchi so'rov o'tmadi): kutish ekrani, aloqa qaytsa sahifa o'zi qayta ochiladi
export function offlineScreen(app, err) {
  const retry = () => location.reload();
  if (err && !err.offline) {
    return app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: 'Sahifani yuklab bo‘lmadi' }),
      el('p', { textContent: err.message || 'Qayta urinib ko‘ring.' }), el('button', { type: 'button', className: 'btn btn-primary', textContent: '↻ Qayta urinish', onclick: retry })));
  }
  app.replaceChildren(el('div', { className: 'empty-state net-wait' },
    el('div', { className: 'net-wait-ic', ariaHidden: 'true', textContent: '📡' }),
    el('h2', { textContent: 'Server bilan aloqa yo‘q' }),
    el('p', { textContent: 'Internet yoki Wi‑Fi’ni tekshiring. Ulanish qaytishi bilan sahifa o‘zi ochiladi.' }),
    el('p', { className: 'muted small net-wait-tick', textContent: 'Ulanish kutilmoqda' }),
    el('button', { type: 'button', className: 'btn btn-primary', textContent: '↻ Qayta urinish', onclick: retry })));
  netState(false);
  window.addEventListener('oq:online', retry, { once: true });
}
