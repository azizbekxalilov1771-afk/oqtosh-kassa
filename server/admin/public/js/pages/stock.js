import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, fmtDateTime } from '../ui.js';

// Ombor sozlamasi: mahsulotlar (asosiy o'lchov + qadoqlar: "1 blok = 6 dona"), ta'minotchilar va kunlik hisobot.
// Omborchi o'z sahifasida (/xodim/ombor.html) kirim qiladi va qoldiqni yozadi.

const money = (n) => `${String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;
const q = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 1000) / 1000).replace('.', ','));

export async function render(root) {
  let data = await api('/stock');
  const units = Object.entries(data.units);
  const unitSel = (value) => el('select', {}, units.map(([k, v]) => el('option', { value: k, textContent: v, selected: k === value })));

  /* — mahsulot tahrirlash dialogi — */
  function productDialog(p = null) {
    const name = el('input', { value: p?.name || '', maxLength: 60, placeholder: 'Masalan: Coca-Cola 1 l' });
    const unit = unitSel(p?.unit || 'kg');
    const cat = el('input', { value: p?.category || '', maxLength: 40, placeholder: 'Ichimlik, Go‘sht, Sabzavot…' });
    const min = el('input', { value: p?.minQty || '', inputMode: 'decimal', placeholder: '0' });
    const on = el('input', { type: 'checkbox', className: 'switch', checked: p ? p.on : true });
    const packs = el('div', { className: 'stack' });
    const packRow = (pk = {}) => {
      const u = el('select', {}, el('option', { value: '', textContent: '— qadoq —' }), units.map(([k, v]) => el('option', { value: k, textContent: v, selected: k === pk.unit })));
      const size = el('input', { value: pk.size || '', inputMode: 'decimal', placeholder: 'nechta' });
      const row = el('div', { className: 'pack-row' }, el('span', { textContent: '1' }), u, el('span', { textContent: '=' }), size, el('span', { className: 'muted', textContent: 'asosiy birlik' }),
        btn('✕', () => row.remove(), 'btn-text btn-small danger'));
      row.get = () => ({ unit: u.value, size: size.value });
      return row;
    };
    for (const pk of p?.packs || []) packs.append(packRow(pk));
    const err = el('p', { className: 'form-error', hidden: true });
    const dlg = el('dialog', { className: 'pw-dialog perm-dialog' },
      el('h2', { textContent: p ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot' }),
      el('div', { className: 'grid-2' },
        el('div', { className: 'field' }, el('label', { textContent: 'Nomi' }), name),
        el('div', { className: 'field' }, el('label', { textContent: 'Kategoriya' }), cat),
        el('div', { className: 'field' }, el('label', { textContent: 'Asosiy o‘lchov (qoldiq shu birlikda)' }), unit),
        el('div', { className: 'field' }, el('label', { textContent: 'Eng kam qoldiq (ogohlantirish)' }), min)),
      el('div', { className: 'field' }, el('label', { textContent: 'Qanday qadoqda keladi' }), packs,
        btn('+ Qadoq', () => packs.append(packRow()), 'btn-ghost btn-small'),
        el('p', { className: 'hint', textContent: 'Masalan: 1 blok = 6 dona, 1 qop = 50 kg. Omborchi “3 blok” desa — o‘zi 18 dona deb hisoblaydi. kg ↔ g ↔ tonna, litr ↔ ml o‘zi aylanadi.' })),
      el('label', { className: 'toggle' }, on, el('span', { textContent: 'Faol (omborchiga ko‘rinadi)' })),
      err,
      el('div', { className: 'row' },
        btn('Saqlash', (e) => busy(e.currentTarget, '…', async () => {
          try {
            const body = { name: name.value, unit: unit.value, category: cat.value, minQty: min.value, on: on.checked, packs: [...packs.children].map((r) => r.get()).filter((x) => x.unit) };
            await api(p ? `/stock/products/${p.id}` : '/stock/products', { method: p ? 'PUT' : 'POST', body });
            dlg.close();
            toast('Saqlandi.');
            data = await api('/stock');
            paint();
          } catch (x) {
            err.textContent = x.message;
            err.hidden = false;
          }
        })),
        btn('Yopish', () => dlg.close(), 'btn-ghost')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function supplierDialog(s = null) {
    const name = el('input', { value: s?.name || '', maxLength: 60 });
    const phone = el('input', { value: s?.phone || '', maxLength: 30, type: 'tel', placeholder: '+998…' });
    const note = el('input', { value: s?.note || '', maxLength: 120, placeholder: 'Nima olib keladi, to‘lov sharti…' });
    const on = el('input', { type: 'checkbox', className: 'switch', checked: s ? s.on : true });
    const err = el('p', { className: 'form-error', hidden: true });
    const dlg = el('dialog', { className: 'pw-dialog' },
      el('h2', { textContent: s ? 'Ta’minotchi' : 'Yangi ta’minotchi' }),
      el('div', { className: 'field' }, el('label', { textContent: 'Nomi' }), name),
      el('div', { className: 'field' }, el('label', { textContent: 'Telefon' }), phone),
      el('div', { className: 'field' }, el('label', { textContent: 'Izoh' }), note),
      el('label', { className: 'toggle' }, on, el('span', { textContent: 'Faol' })), err,
      el('div', { className: 'row' },
        btn('Saqlash', (e) => busy(e.currentTarget, '…', async () => {
          try {
            await api(s ? `/stock/suppliers/${s.id}` : '/stock/suppliers', { method: s ? 'PUT' : 'POST', body: { name: name.value, phone: phone.value, note: note.value, on: on.checked } });
            dlg.close();
            data = await api('/stock');
            paint();
          } catch (x) {
            err.textContent = x.message;
            err.hidden = false;
          }
        })),
        btn('Yopish', () => dlg.close(), 'btn-ghost')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  const prodBox = el('div');
  const supBox = el('div');
  const repBox = el('div');
  function paint() {
    prodBox.replaceChildren(data.products.length ? el('table', { className: 'stock-table' },
      el('thead', {}, el('tr', {}, ...['Mahsulot', 'Kategoriya', 'O‘lchov', 'Qadoq', 'Eng kami', ''].map((t) => el('th', { textContent: t })))),
      el('tbody', {}, data.products.map((p) => el('tr', { className: p.on ? '' : 'is-off' },
        el('td', { textContent: p.name }), el('td', { className: 'muted', textContent: p.category || '—' }), el('td', { textContent: p.unitLabel }),
        el('td', { className: 'muted', textContent: p.packs.map((x) => `1 ${data.units[x.unit] || x.unit} = ${q(x.size)} ${p.unitLabel}`).join(', ') || '—' }),
        el('td', { textContent: p.minQty ? `${q(p.minQty)} ${p.unitLabel}` : '—' }),
        el('td', {}, btn('Tahrirlash', () => productDialog(p), 'btn-text btn-small')))))) : el('p', { className: 'muted', textContent: 'Hali mahsulot yo‘q.' }));
    supBox.replaceChildren(data.suppliers.length ? el('table', { className: 'stock-table' },
      el('thead', {}, el('tr', {}, ...['Ta’minotchi', 'Telefon', 'Izoh', ''].map((t) => el('th', { textContent: t })))),
      el('tbody', {}, data.suppliers.map((s) => el('tr', { className: s.on ? '' : 'is-off' },
        el('td', { textContent: s.name }), el('td', {}, s.phone ? el('a', { href: `tel:${s.phone.replace(/[^\d+]/g, '')}`, textContent: s.phone }) : '—'),
        el('td', { className: 'muted', textContent: s.note || '—' }), el('td', {}, btn('Tahrirlash', () => supplierDialog(s), 'btn-text btn-small')))))) : el('p', { className: 'muted', textContent: 'Hali ta’minotchi yo‘q.' }));
  }
  async function loadReport(day = data.today) {
    repBox.replaceChildren(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
    try {
      const { report: r } = await api(`/stock/report?day=${encodeURIComponent(day)}`);
      const dayIn = el('input', { type: 'date', value: r.day, max: data.today });
      dayIn.addEventListener('change', () => loadReport(dayIn.value));
      repBox.replaceChildren(
        el('div', { className: 'row align-end wrap' }, dayIn, el('p', { className: 'muted', textContent: `${r.counted ? `Qoldiq yozilgan: ${r.countedByName} · ${fmtDateTime(r.countedAt)}` : 'Bu kun qoldiq yozilmagan'} · kirim ${money(r.totalIn)}` })),
        el('table', { className: 'stock-table' },
          el('thead', {}, el('tr', {}, el('th', { textContent: 'Mahsulot' }), ...['Kecha', 'Keldi', 'Sarf', 'Qoldiq'].map((t) => el('th', { className: 'num', textContent: t })))),
          el('tbody', {}, r.rows.map((x) => el('tr', { className: x.low ? 'is-low' : '' },
            el('td', { textContent: `${x.name} (${x.unitLabel})` }), el('td', { className: 'num', textContent: q(x.open) }), el('td', { className: 'num', textContent: x.in ? `+${q(x.in)}` : '—' }),
            el('td', { className: 'num', textContent: q(x.used) }), el('td', { className: 'num', textContent: `${q(x.close)}${x.low ? ' ⚠' : ''}` }))))),
        r.moves.length ? el('details', {}, el('summary', { textContent: `Shu kungi kirimlar · ${r.moves.length} ta` }),
          ...r.moves.map((m) => el('div', { className: 'card-lite' },
            el('p', {}, el('strong', { textContent: m.supplierName || 'Ta’minotchisiz' }), ` · ${fmtDateTime(m.at)} · ${m.byName} · ${money(m.total)}`),
            el('p', { className: 'muted small', textContent: m.lines.map((l) => `${q(l.inQty ?? l.qty)} ${l.inUnitLabel || l.unit} ${l.name}`).join(', ') }),
            btn('O‘chirish', (e) => busy(e.currentTarget, '…', async () => {
              if (!confirm('Bu kirim o‘chirilsinmi?')) return;
              await api(`/stock/moves/${m.id}`, { method: 'DELETE' });
              loadReport(r.day);
            }), 'btn-text btn-small danger')))) : '');
    } catch (e) {
      repBox.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
  }
  paint();
  loadReport();
  root.append(
    pageHead('Ombor', 'Mahsulotlar, ta’minotchilar va kunlik qoldiq. Omborchi o‘z sahifasida kirim qiladi va qoldiqni yozadi.',
      el('a', { className: 'btn btn-ghost', href: '/xodim/ombor.html', target: '_blank', rel: 'noopener', textContent: 'Omborchi sahifasi' })),
    card('Kunlik hisobot', 'Sarf = kechagi qoldiq + kelgan − bugungi qoldiq. ⚠ — eng kam miqdordan kam qolgan.', repBox),
    card('Mahsulotlar', '', el('div', { className: 'row' }, btn('+ Mahsulot', () => productDialog())), prodBox),
    card('Ta’minotchilar', '', el('div', { className: 'row' }, btn('+ Ta’minotchi', () => supplierDialog())), supBox));
}
