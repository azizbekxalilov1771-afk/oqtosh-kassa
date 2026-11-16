import { el, formatPrice } from './common.js';

// Stollar: chapda zallar (kategoriya kabi) va "Ochiq stollar", o'ngda tanlangan zal stollari — buyurtma oynasidagidek.
//   floorLayout({ data, key, tableBtn, onKey }) → element
//   data: /api/staff/tables javobi { halls: [{ id, name, tables: [{ id, name, tab, mison }] }], loose: [tab], mison? }
//   key: tanlangan zal id'si yoki 'open' (faqat band stollar)
// Ranglar: bo'sh — oddiy, band — sariq, hisob cheki chiqqan — yashil (stolda ofitsiant ismi),
// Mison kassasining o'zida ochilgan hisob — ko'k (bosilsa, Mison'dagi hisob ko'rinadi; to'lov Mison kassasida).
export const OPEN = 'open';

const busyOf = (t) => Boolean(t.tab || t.mison);

export function busyTables(data) {
  return [
    ...data.halls.flatMap((h) => h.tables.filter(busyOf).map((t) => ({ ...t, hall: h.name }))),
    ...data.loose.map((t) => ({ id: `tab:${t.id}`, name: t.tableLabel, tab: t, loose: true })),
    ...(data.mison?.loose || []).map((t) => ({ ...t, loose: true })),
  ];
}

// Ochiq stollar soni va summasi (sayt hisoblari + Mison kassasidagilar)
export function openTotals(data) {
  const tabs = [...data.halls.flatMap((h) => h.tables.map((t) => t.tab).filter(Boolean)), ...data.loose];
  const uniq = [...new Map(tabs.map((t) => [t.id, t])).values()];
  const misonOnly = busyTables(data).filter((t) => !t.tab && t.mison);
  const misonSum = busyTables(data).reduce((s, t) => s + (t.mison?.total || 0), 0);
  return { count: uniq.length + misonOnly.length, sum: uniq.reduce((s, t) => s + t.total, 0) + misonSum, mison: misonOnly.length };
}

export function pickKey(data, key) {
  if (key === OPEN) return OPEN;
  if (data.halls.some((h) => String(h.id) === String(key))) return String(key);
  return data.halls[0] ? String(data.halls[0].id) : OPEN;
}

const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
const since = (iso) => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} daq` : `${Math.floor(m / 60)} soat ${m % 60} daq`;
};

// Mison kassasidagi hisob (faqat ko'rish): taomlar, summa, ofitsiant, mehmonlar, ochilgan vaqt
export function openMisonBill(t, data) {
  const ids = new Set(t.mison?.ids || []);
  const list = (data.mison?.cheques || []).filter((c) => ids.has(c.id));
  const block = (c) => {
    const mods = new Map();
    for (const i of c.items) if (i.parent) mods.set(i.parent, [...(mods.get(i.parent) || []), i]);
    const lines = c.items.filter((i) => !i.parent).map((i) => el('li', {},
      el('span', { className: 'mb-name' }, el('span', {}, el('strong', { textContent: i.name || '—' }), ` × ${i.qty}`),
        ...(mods.get(i.line) || []).map((m) => el('small', { textContent: `+ ${m.name}${m.qty > 1 ? ` × ${m.qty}` : ''}` })),
        i.comment ? el('small', { className: 'muted', textContent: `“${i.comment}”` }) : ''),
      el('span', { className: 'mb-sum', textContent: formatPrice(i.sum + (mods.get(i.line) || []).reduce((s, m) => s + m.sum, 0)) })));
    const row = (k, v, cls = '') => (v ? el('div', { className: cls }, el('dt', { textContent: k }), el('dd', { textContent: v })) : '');
    return el('section', { className: 'mb-cheque' },
      el('p', { className: 'muted small', textContent: [c.number ? `Chek №${c.number}` : '', c.waiterName && `👤 ${c.waiterName}`, c.guests && `${c.guests} mehmon`, c.openedAt && `${hm(c.openedAt)} dan · ${since(c.openedAt)}`].filter(Boolean).join(' · ') }),
      el('ul', { className: 'mb-items' }, lines.length ? lines : [el('li', { className: 'muted', textContent: 'Taomlar hali kiritilmagan.' })]),
      el('dl', { className: 'mb-total' },
        c.discount ? row('Taomlar', formatPrice(c.goods)) : '', c.discount ? row('Chegirma', `− ${formatPrice(c.discount)}`) : '',
        c.service ? row('Xizmat haqi', formatPrice(c.service)) : '', row('Jami', formatPrice(c.total), 'is-total')));
  };
  const dlg = el('dialog', { className: 'pay-dialog mison-bill' },
    el('h2', { textContent: `${t.name} · Mison kassasi` }),
    t.hall ? el('p', { className: 'muted', textContent: t.hall }) : '',
    ...(list.length ? list.map(block) : [el('p', { className: 'muted', textContent: 'Hisob ma’lumoti hali kelmadi — birozdan keyin qayta oching.' })]),
    el('p', { className: 'notice mb-note', textContent: 'Bu hisob Mison kassasining o‘zida ochilgan. Unga qo‘shish, to‘lov va yopish — Mison kassasida.' }),
    el('div', { className: 'row' }, el('button', { type: 'button', className: 'btn', textContent: 'Yopish', onclick: () => dlg.close() })));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// Faqat Mison kassasida ochilgan stol (saytda hisob yo'q)
const misonTile = (t, data, showHall) => el('button', {
  type: 'button', className: 'floor-table is-busy is-mison', onclick: () => openMisonBill(t, data), title: 'Mison kassasida ochilgan hisob',
},
el('span', { className: 'floor-name', textContent: t.name }),
el('span', { className: 'floor-meta', textContent: t.mison.total ? formatPrice(t.mison.total) : 'bo‘sh chek' }),
el('span', { className: `floor-waiter${t.mison.waiterName ? '' : ' is-none'}`, textContent: t.mison.waiterName ? `👤 ${t.mison.waiterName}` : 'ofitsiant yo‘q' }),
el('span', { className: 'floor-mison-tag', textContent: `Mison${t.mison.openedAt ? ` · ${since(t.mison.openedAt)}` : ''}` }),
showHall && t.hall ? el('span', { className: 'floor-hall-tag', textContent: t.hall }) : '');

export function floorLayout({ data, key, tableBtn, onKey }) {
  const busy = busyTables(data);
  const k = pickKey(data, key);
  const tile = (t) => {
    if (!t.tab && t.mison) return misonTile(t, data, k === OPEN);
    const b = tableBtn(t);
    // saytdagi hisobdan tashqari Mison kassasida ham alohida chek bor
    if (t.mison) b.append(el('span', { className: 'floor-mison-extra', textContent: `+ Mison ${formatPrice(t.mison.total)}`, onclick: (e) => { e.stopPropagation(); openMisonBill(t, data); } }));
    return b;
  };
  const side = el('nav', { className: 'floor-halls', role: 'tablist', ariaLabel: 'Zallar', ariaOrientation: 'vertical' },
    el('button', { type: 'button', role: 'tab', className: `floor-hall-btn is-open${k === OPEN ? ' is-on' : ''}`, ariaSelected: String(k === OPEN), onclick: () => onKey(OPEN) },
      el('span', { textContent: 'Ochiq stollar' }), el('span', { className: 'floor-hall-n', textContent: busy.length })),
    ...data.halls.map((h) => {
      const on = String(h.id) === k;
      const n = h.tables.filter(busyOf).length;
      return el('button', { type: 'button', role: 'tab', className: `floor-hall-btn${on ? ' is-on' : ''}`, ariaSelected: String(on), onclick: () => onKey(String(h.id)) },
        el('span', { textContent: h.name }), el('span', { className: 'floor-hall-n', textContent: `${n}/${h.tables.length}` }));
    }));
  let title;
  let tables;
  if (k === OPEN) {
    title = busy.length ? `Ochiq stollar · ${busy.length}` : 'Ochiq stol yo‘q';
    tables = busy;
  } else {
    const h = data.halls.find((x) => String(x.id) === k);
    title = `${h.name} · ${h.tables.filter(busyOf).length}/${h.tables.length} band`;
    tables = h.tables;
  }
  const grid = el('div', { className: 'floor-grid', role: 'tabpanel' }, tables.length ? tables.map(tile) : [el('p', { className: 'empty-line', textContent: k === OPEN ? 'Hozir hamma stol bo‘sh.' : 'Bu zalda stol yo‘q.' })]);
  const legend = el('p', { className: 'floor-legend', ariaHidden: 'true' },
    el('span', { className: 'lg is-free', textContent: 'Bo‘sh' }), el('span', { className: 'lg is-busy', textContent: 'Band' }), el('span', { className: 'lg is-billed', textContent: 'Chek chiqqan' }),
    data.mison ? el('span', { className: 'lg is-mison', textContent: 'Mison kassasida' }) : '');
  return el('div', { className: 'floor2' }, side, el('div', { className: 'floor2-main' },
    el('div', { className: 'floor2-head' }, el('h2', { className: 'list-head', textContent: title }), legend),
    misonNote(data), grid));
}

// Mison bilan bog'lanish holati (xato bo'lsa — nima qilish kerakligi)
function misonNote(data) {
  const m = data.mison;
  if (!m) return '';
  let text = '';
  let bad = true;
  if (m.error === 'ruxsat') text = 'Mison kassasidagi ochiq stollar ko‘rinmayapti: Mison kabinetida API kalitga “Доступ к отчётам” ruxsatini yoqing.';
  else if (m.error) text = `Mison kassasidagi stollar yangilanmadi: ${m.error}`;
  else if (!m.onlineEnabled) text = 'Mison’da “онлайн-чеки” o‘chirilgan — kassada ochilgan stollar bu yerda ko‘rinmaydi.';
  else {
    bad = false;
    text = `Mison kassasi bilan birga · ${hm(m.at)} da yangilandi${m.lastSyncAt && Date.now() - Date.parse(m.lastSyncAt) > 10 * 60_000 ? ` · kassa oxirgi marta ${hm(m.lastSyncAt)} da yuborgan` : ''}`;
  }
  return el('p', { className: `floor-mison-note${bad ? ' is-bad' : ''}`, textContent: text });
}
