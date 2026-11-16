import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card } from '../ui.js';

// Mehmonlar: saytdan kim foydalangan, nechta buyurtma; tarixni bittalab yoki hammasini bir yo'la tozalash
const ROLE = { waiter: 'Ofitsiant', cashier: 'Kassir', courier: 'Kuryer' };
const fmt = (n) => `${String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;
const date = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export async function render(root) {
  let data = await api('/guests');
  const stats = el('div', { className: 'guest-stats' });
  const list = el('ul', { className: 'item-list guest-list' });
  const q = el('input', { type: 'search', placeholder: 'Ism, telefon yoki @username', className: 'search-input' });

  function paintStats() {
    const t = data.totals;
    const stat = (n, label) => el('div', { className: 'guest-stat' }, el('strong', { textContent: n }), el('span', { textContent: label }));
    stats.replaceChildren(stat(t.people, 'saytga kirgan'), stat(t.guests, 'mehmon'), stat(t.withOrders, 'buyurtma bergan'), stat(t.orders, 'buyurtma'));
  }

  function paint() {
    const text = q.value.trim().toLowerCase();
    const shown = data.items.filter((g) => !text || `${g.name} ${g.phone} ${g.username}`.toLowerCase().includes(text));
    list.replaceChildren(...(shown.length ? shown.slice(0, 400).map((g) => {
      const actions = [];
      if (g.orders) {
        actions.push(btn('Tarixini tozalash', (e) => {
          if (!confirm(`${g.name || g.phone}: ${g.orders} ta buyurtma va stol hisoblari o‘chirilsinmi?\nMison kassasidagi cheklar o‘zgarmaydi.`)) return;
          busy(e.currentTarget, '…', async () => {
            try {
              const r = await api(`/guests/${g.id}/history`, { method: 'DELETE' });
              toast(`${r.orders} ta buyurtma o‘chirildi.`);
              data = await api('/guests');
              paintStats();
              paint();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        }, 'btn-ghost btn-small'));
      }
      if (g.role === 'customer') {
        actions.push(btn('O‘chirish', (e) => {
          if (!confirm(`${g.name || g.phone} butunlay o‘chirilsinmi? Keyingi safar Telegram orqali qayta kira oladi.`)) return;
          busy(e.currentTarget, '…', async () => {
            try {
              await api(`/guests/${g.id}`, { method: 'DELETE' });
              toast('O‘chirildi.');
              data = await api('/guests');
              paintStats();
              paint();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        }, 'btn-text btn-small danger'));
      }
      return el('li', { className: 'item guest-item' },
        el('div', { className: 'item-main' },
          el('h3', {}, g.name || 'Ismsiz', ROLE[g.role] ? el('span', { className: `role-badge is-${g.role}`, textContent: ROLE[g.role] }) : ''),
          el('p', { className: 'muted', textContent: [g.phone, g.username && `@${g.username}`, `kirgan: ${date(g.since)}`].filter(Boolean).join(' · ') }),
          el('p', { className: 'guest-orders', textContent: g.orders ? `${g.orders} ta buyurtma · ${fmt(g.spent)} · oxirgisi ${date(g.lastOrderAt)}` : 'Buyurtma bermagan' })),
        el('div', { className: 'item-actions' }, ...actions));
    }) : [el('li', { className: 'empty', textContent: data.items.length ? 'Topilmadi.' : 'Hali hech kim kirmagan.' })]));
  }
  q.addEventListener('input', paint);

  // Hammasini tozalash
  const confirmInput = el('input', { type: 'text', placeholder: 'TOZALASH', className: 'search-input', autocomplete: 'off', ariaLabel: 'Tasdiqlash so‘zi' });
  const alsoGuests = el('input', { type: 'checkbox', className: 'switch' });
  const wipe = btn('Hammasini tozalash', (e) => busy(e.currentTarget, 'Tozalanmoqda…', async () => {
    if (confirmInput.value.trim() !== 'TOZALASH') return toast('Tasdiqlash uchun katta harflar bilan TOZALASH deb yozing.', 'error');
    try {
      const r = await api('/guests/clear', { method: 'POST', body: { confirm: 'TOZALASH', guests: alsoGuests.checked } });
      toast(`Tozalandi: ${r.orders} buyurtma, ${r.tabs} stol hisobi${r.guests ? `, ${r.guests} mehmon` : ''}.`);
      confirmInput.value = '';
      data = await api('/guests');
      paintStats();
      paint();
    } catch (err) {
      toast(err.message, 'error');
    }
  }), 'btn-danger');

  paintStats();
  paint();
  root.append(
    pageHead('Mehmonlar', 'Saytga Telegram orqali kirgan barcha odamlar va ularning buyurtmalari. Sinov buyurtmalarini shu yerda o‘chirasiz.'),
    stats,
    card('', '', el('div', { className: 'row align-center wrap' }, q), list),
    card('Hammasini tozalash', 'Barcha buyurtmalar, stol hisoblari va band stollar o‘chadi, buyurtma raqami 1 dan boshlanadi. Bu ishni qaytarib bo‘lmaydi. Mison kassasidagi cheklar o‘zgarmaydi — ularni kassada o‘zingiz bekor qilasiz.',
      el('div', { className: 'danger-zone' },
        el('label', { className: 'toggle' }, alsoGuests, el('span', { textContent: 'Mehmon hisoblarini ham o‘chirish (xodimlar qoladi)' })),
        el('div', { className: 'row align-center wrap' }, confirmInput, wipe))));
}
