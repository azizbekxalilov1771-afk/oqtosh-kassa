import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, fmtDateTime } from '../ui.js';

export async function render(root) {
  const { items, statuses } = await api('/complaints');
  let filter = 'yangi';
  const chips = el('div', { className: 'filter-chips', role: 'group', ariaLabel: 'Holat bo‘yicha' });
  const list = el('ul', { className: 'complaint-list' });

  function paintChips() {
    const counts = Object.fromEntries(Object.keys(statuses).map((s) => [s, items.filter((c) => c.status === s).length]));
    const opts = [['all', `Hammasi (${items.length})`], ...Object.entries(statuses).map(([k, l]) => [k, `${l} (${counts[k]})`])];
    chips.replaceChildren(...opts.map(([k, l]) => {
      const b = el('button', { type: 'button', textContent: l });
      b.setAttribute('aria-pressed', String(filter === k));
      b.addEventListener('click', () => {
        filter = k;
        paint();
      });
      return b;
    }));
  }

  function complaintCard(c) {
    const select = el('select', { ariaLabel: 'Holat' }, Object.entries(statuses).map(([k, l]) => el('option', { value: k, textContent: l })));
    select.value = c.status;
    select.addEventListener('change', async () => {
      try {
        await api(`/complaints/${c.id}`, { method: 'PATCH', body: { status: select.value } });
        c.status = select.value;
        toast(`Holat: ${statuses[c.status]}`);
        paint();
      } catch (err) {
        select.value = c.status;
        toast(err.message, 'error');
      }
    });
    const note = el('textarea', { rows: 2, value: c.note, maxLength: 1000, placeholder: 'Ichki izoh (mijozga ko‘rinmaydi)', ariaLabel: 'Izoh' });
    const saveNote = btn('Izohni saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
      try {
        await api(`/complaints/${c.id}`, { method: 'PATCH', body: { note: note.value } });
        c.note = note.value;
        toast('Izoh saqlandi.');
      } catch (err) {
        toast(err.message, 'error');
      }
    }), 'btn-ghost btn-small');
    return el('li', { className: `complaint is-${c.status}` },
      el('div', { className: 'complaint-head' },
        el('div', {},
          el('p', { className: 'item-meta' }, fmtDateTime(c.createdAt), el('span', { className: 'chip is-muted', textContent: c.topic }),
            !c.telegramSent && el('span', { className: 'chip is-warn', textContent: 'Telegram’ga bormagan' })),
          el('p', { className: 'complaint-who' },
            el('strong', { textContent: c.name || 'Ismsiz' }),
            c.phone && ' — ', c.phone && el('a', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}`, textContent: c.phone }),
            c.visitDate && el('span', { className: 'muted', textContent: ` · tashrif: ${c.visitDate}` }))),
        select),
      el('p', { className: 'complaint-text', textContent: c.message }),
      el('div', { className: 'complaint-note' }, note, saveNote));
  }

  function paint() {
    paintChips();
    const shown = items.filter((c) => filter === 'all' || c.status === filter);
    list.replaceChildren(...(shown.length ? shown.map(complaintCard) : [el('li', { className: 'empty', textContent: filter === 'yangi' ? 'Yangi shikoyat yo‘q.' : 'Bu holatda shikoyat yo‘q.' })]));
  }
  paint();
  root.append(pageHead('Shikoyatlar', 'Saytdan kelgan shikoyatlar. Har biri Telegram botga ham yuboriladi.'), card('', '', chips, list));
}
