import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, fmtDateTime } from '../ui.js';

const formatPrice = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;
const CHIP = { yangi: 'is-warn', qabul: 'is-ok', rad: 'is-bad', bekor: 'is-muted' };

export async function render(root) {
  let { items, statuses } = await api('/orders');
  let filter = 'yangi';
  const chips = el('div', { className: 'filter-chips', role: 'group', ariaLabel: 'Holat bo‘yicha' });
  const list = el('ul', { className: 'complaint-list' });
  const summary = el('p', { className: 'muted' });

  function paintChips() {
    const opts = [['all', `Hammasi (${items.length})`], ...Object.entries(statuses).map(([k, l]) => [k, `${l} (${items.filter((o) => o.status === k).length})`])];
    chips.replaceChildren(...opts.map(([k, l]) => {
      const b = el('button', { type: 'button', textContent: l });
      b.setAttribute('aria-pressed', String(filter === k));
      b.addEventListener('click', () => {
        filter = k;
        paint();
      });
      return b;
    }));
    const today = new Date().toISOString().slice(0, 10);
    const accepted = items.filter((o) => o.status === 'qabul' && o.acceptedAt.slice(0, 10) === today);
    summary.textContent = `Bugun qabul qilingan: ${accepted.length} ta, ${formatPrice(accepted.reduce((s, o) => s + o.total, 0))}`;
  }

  function orderCard(o) {
    const actions = el('div', { className: 'row' });
    if (o.status === 'yangi') {
      actions.append(
        btn('Qabul qilish', (e) => busy(e.currentTarget, '…', async () => {
          try {
            const r = await api(`/orders/${o.id}/accept`, { method: 'POST', body: {} });
            Object.assign(o, r.order);
            toast(`#${o.number} qabul qilindi.`);
            paint();
          } catch (err) {
            toast(err.message, 'error');
          }
        }), 'btn-small'),
        btn('Rad etish', (e) => {
          const reason = prompt('Sabab (mijozga Telegram’da yuboriladi):', '');
          if (reason === null) return;
          busy(e.currentTarget, '…', async () => {
            try {
              const r = await api(`/orders/${o.id}/reject`, { method: 'POST', body: { reason } });
              Object.assign(o, r.order);
              toast(`#${o.number} rad etildi.`);
              paint();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        }, 'btn-text btn-small danger'));
    }
    if (o.status === 'qabul' && o.misonError && !o.misonOrderId) {
      actions.append(btn('Mison’ga qayta yuborish', (e) => busy(e.currentTarget, '…', async () => {
        try {
          const r = await api(`/orders/${o.id}/mison`, { method: 'POST', body: {} });
          Object.assign(o, r.order);
          toast(`#${o.number} Mison kassasiga tushdi.`);
        } catch (err) {
          o.misonError = err.message;
          toast(err.message, 'error');
        }
        paint();
      }), 'btn-ghost btn-small'));
    }
    const mison = o.status !== 'qabul' ? null
      : o.misonOrderId ? el('p', { className: 'mison-line is-ok', textContent: `Mison kassasida: № ${o.misonOrderId}${o.misonStatus ? ` · ${o.misonStatus}` : ''}` })
        : o.misonError ? el('p', { className: 'mison-line is-bad', textContent: `Mison’ga tushmadi: ${o.misonError}` }) : null;
    return el('li', { className: `complaint is-${o.status === 'yangi' ? 'yangi' : o.status === 'qabul' ? 'hal' : 'jarayonda'}` },
      el('div', { className: 'complaint-head' },
        el('div', {},
          el('p', { className: 'item-meta' }, fmtDateTime(o.createdAt), el('span', { className: `chip ${CHIP[o.status] || ''}`, textContent: o.statusLabel })),
          el('p', { className: 'complaint-who' },
            el('strong', { textContent: `#${o.number} · ${o.tableLabel || `Stol ${o.table}`}` }),
            ` — ${o.customerName || 'Mijoz'}`,
            o.customerPhone && ' · ', o.customerPhone && el('a', { href: `tel:${o.customerPhone}`, textContent: o.customerPhone }))),
        el('strong', { className: 'order-sum', textContent: formatPrice(o.total) })),
      o.mode === 'delivery' && o.address ? el('p', { className: 'addr-line' }, `🛵 ${[o.address.text, o.address.apartment && `xonadon ${o.address.apartment}`, o.address.entrance && `${o.address.entrance}-podyezd`, o.address.floor && `${o.address.floor}-qavat`].filter(Boolean).join(', ')}`,
        o.address.landmark ? ` (${o.address.landmark})` : '', ` · ${o.deliveryKm} km · yetkazish ${formatPrice(o.deliveryFee)}${o.courierName ? ` · kuryer: ${o.courierName}` : ''} · `,
        el('a', { href: `https://www.google.com/maps?q=${o.address.lat},${o.address.lng}`, target: '_blank', rel: 'noopener', textContent: 'xaritada' })) : '',
      el('ul', { className: 'order-items' }, o.items.map((i) => el('li', { textContent: `${i.unit === 'kg' ? `${String(i.qty).replace('.', ',')} kg${i.byAmount ? ` (${formatPrice(i.byAmount)}lik)` : ''}` : `${i.qty} ×`} ${i.name}${i.mods?.length ? ` (${i.mods.map((m) => (m.qty > 1 ? `${m.name} ×${m.qty}` : m.name)).join(', ')})` : ''} — ${formatPrice(i.sum)}` }))),
      o.comment && el('p', { className: 'muted', textContent: `Izoh: ${o.comment}` }),
      o.status === 'qabul' && el('p', { className: 'muted', textContent: `Qabul qildi: ${o.acceptedByName} · ${fmtDateTime(o.acceptedAt)}` }),
      o.status === 'rad' && o.rejectReason && el('p', { className: 'muted', textContent: `Sabab: ${o.rejectReason}` }),
      mison,
      actions.childElementCount ? actions : '');
  }

  function paint() {
    paintChips();
    const shown = items.filter((o) => filter === 'all' || o.status === filter);
    list.replaceChildren(...(shown.length ? shown.map(orderCard) : [el('li', { className: 'empty', textContent: filter === 'yangi' ? 'Tasdiqlash kutilayotgan buyurtma yo‘q.' : 'Bu holatda buyurtma yo‘q.' })]));
  }

  const reload = btn('Yangilash', (e) => busy(e.currentTarget, '…', async () => {
    ({ items, statuses } = await api('/orders'));
    paint();
  }), 'btn-ghost');
  paint();
  root.append(
    pageHead('Buyurtmalar', 'Saytdan berilgan buyurtmalar. Odatda ularni ofitsiant mijozning QR kodini skanerlab qabul qiladi.', reload),
    card('', '', summary, chips, list));
}
