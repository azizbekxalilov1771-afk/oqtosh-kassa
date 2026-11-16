import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, fmtDateTime } from '../ui.js';
import { mountOwnerReport } from '../owner-report.js';

const SOURCE = { pos: 'Mison POS’dan', cache: 'Firestore keshidan', demo: 'Demo menyu', none: 'Menyu yo‘q' };

export async function render(root) {
  const o = await api('/overview');

  const status = (ok, label, okText, badText, href) =>
    el('a', { className: `status ${ok ? 'is-ok' : 'is-bad'}`, href },
      el('span', { className: 'status-dot', ariaHidden: 'true' }),
      el('span', { className: 'status-label', textContent: label }),
      el('span', { className: 'status-text', textContent: ok ? okText : badText }));

  const menuInfo = el('div', { className: 'menu-state' });
  const showMenu = (m) => {
    menuInfo.replaceChildren(
      el('p', {}, el('strong', { textContent: `${m.count} ta taom` }), ` — ${SOURCE[m.source] || m.source}`),
      m.updatedAt ? el('p', { className: 'muted', textContent: `Oxirgi yangilanish: ${fmtDateTime(m.updatedAt)}` }) : '',
      m.posError ? el('p', { className: 'form-error', textContent: `POS xatosi: ${m.posError}` }) : '');
  };
  showMenu(o.menu);
  const refresh = btn('Menyuni hozir yangilash', (e) => busy(e.currentTarget, 'Yangilanmoqda…', async () => {
    try {
      const m = await api('/menu/refresh', { method: 'POST', body: {} });
      showMenu(m);
      toast(m.source === 'pos' ? `Menyu yangilandi: ${m.count} ta taom.` : 'POS’dan olib bo‘lmadi — xatoni o‘qing.', m.source === 'pos' ? 'ok' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  }), 'btn-ghost');

  // Birinchi qism — Owner hisoboti (savdo, taomlar, smenalar, chegirmalar, ombor); pastda sayt holati
  const report = el('div', { className: 'owner-main owner-embed' });
  root.append(report);
  mountOwnerReport(report, { onAuth: (e) => report.replaceChildren(el('p', { className: 'notice warn', textContent: e.message })) });
  root.append(
    pageHead('Sayt holati', 'Ulanishlar va tezkor amallar.', o.publicSiteUrl ? el('a', { className: 'btn', href: o.publicSiteUrl, target: '_blank', rel: 'noopener', textContent: 'Saytni ochish' }) : ''),
    el('div', { className: 'status-grid' },
      status(o.firebase, 'Firebase', 'Ulangan', 'Ulanmagan', '#/kalitlar'),
      status(o.integrations.pos, 'Mison POS', 'Ulangan', 'Kalit kiritilmagan', '#/kalitlar'),
      status(o.integrations.groq, 'AI yordamchi (Groq)', 'Ulangan', 'Kalit kiritilmagan', '#/kalitlar'),
      status(o.integrations.telegram, 'Telegram bot', 'Ulangan', 'Token yoki chat ID yo‘q', '#/kalitlar')),
    el('div', { className: 'grid-3 gap-lg' },
      card('Menyu', 'Narxlar Mison POS’dan olinadi va saytda avtomatik yangilanadi.', menuInfo, refresh),
      card('Buyurtmalar', o.loginReady ? '' : 'Telegram bot ulanmagan — mijozlar buyurtma bera olmaydi.',
        el('p', { className: 'big-number', textContent: o.pendingOrders ?? '—' }),
        el('p', { className: 'muted', textContent: `ta buyurtma ofitsiantni kutmoqda · mijozlar: ${o.customers ?? '—'}` }),
        el('a', { className: 'btn btn-ghost', href: '#/buyurtmalar', textContent: 'Buyurtmalarni ko‘rish' })),
      card('Shikoyatlar', '',
        el('p', { className: 'big-number', textContent: o.newComplaints ?? '—' }),
        el('p', { className: 'muted', textContent: 'ta yangi, ko‘rib chiqilmagan shikoyat' }),
        el('a', { className: 'btn btn-ghost', href: '#/shikoyatlar', textContent: 'Shikoyatlarni ko‘rish' }))),
    card('Nimadan boshlash kerak', '',
      el('ol', { className: 'steps' },
        el('li', {}, el('a', { href: '#/kalitlar', textContent: 'Kalitlar va ulanishlar' }), ' — Mison POS, Groq va Telegram kalitlarini kiriting, har birini "Tekshirish" bilan sinang.'),
        el('li', {}, el('a', { href: '#/restoran', textContent: 'Restoran ma’lumotlari' }), ' — nom, logo, telefon, ish vaqti, restoran haqida matn.'),
        el('li', {}, el('a', { href: '#/manzillar', textContent: 'Manzillar' }), ' — filiallar va ularning xaritadagi joyi.'),
        el('li', {}, el('a', { href: '#/yangiliklar', textContent: 'Yangiliklar' }), ' va ', el('a', { href: '#/bolimlar', textContent: 'Bo‘limlar' }), ' — saytda nima va qaysi tartibda ko‘rinishi.'),
        el('li', {}, el('a', { href: '#/xodimlar', textContent: 'Xodimlar' }), ' — ofitsiantlarni qo‘shing, ular mijozlar buyurtmasini QR orqali qabul qiladi.'))),
  );
}
