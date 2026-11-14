import { el, api, formatPrice } from './common.js';

// Xodim buyurtma oynasi (ofitsiant va kassa): menyudan taom tanlab stolga, ochiq hisobga yoki saboyga yozish.
// Yuborilgan buyurtma darhol "qabul" bo'ladi (QR va kod kerak emas) va Mison yoqilgan bo'lsa kassaga tushadi.
//   openPos({ title, target: 'tab'|'table'|'saboy', tabId, tableId, takeaway, allowTakeaway, onDone })

let menuCache = null;
async function loadMenu() {
  if (menuCache && Date.now() - menuCache.at < 60_000) return menuCache.data;
  const data = await api('/api/menu');
  menuCache = { data, at: Date.now() };
  return data;
}

const kg = (q) => `${String(Math.round(q * 1000) / 1000).replace('.', ',')} kg`;
const lineKey = (l) => `${l.id}|${(l.mods || []).map((m) => `${m.id}:${m.qty}`).sort().join(',')}`;

// Qo'shimchalar va og'irlik tanlash
function chooseOptions(item) {
  return new Promise((resolve) => {
    const groups = item.options || [];
    const picked = new Map(); // mod id → qty
    for (const g of groups) for (const m of g.items) if (m.def > 0 && !m.off) picked.set(m.id, m.def);
    const dlg = el('dialog', { className: 'pos-opts' });
    const err = el('p', { className: 'form-error', hidden: true });
    let weight = null;
    if (item.byWeight) {
      weight = el('input', { type: 'number', min: item.byWeight.min, step: item.byWeight.step, value: Math.max(item.byWeight.min, 0.5), inputMode: 'decimal', className: 'pos-kg' });
    }
    const groupNode = (g) => {
      const single = g.max === 1;
      const box = el('div', { className: 'pos-chips' });
      const paint = () => box.replaceChildren(...g.items.map((m) => {
        const on = picked.has(m.id);
        return el('button', {
          type: 'button', className: `pos-chip${on ? ' is-on' : ''}`, disabled: Boolean(m.off), ariaPressed: String(on),
          onclick: () => {
            if (single) {
              for (const x of g.items) picked.delete(x.id);
              if (!on) picked.set(m.id, 1);
            } else if (on) picked.delete(m.id);
            else {
              const count = g.items.filter((x) => picked.has(x.id)).length;
              if (g.max && count >= g.max) return;
              picked.set(m.id, 1);
            }
            paint();
          },
        }, m.name, m.price ? el('small', { textContent: ` +${formatPrice(m.price)}` }) : '', m.off ? el('small', { textContent: ' · tugagan' }) : '');
      }));
      paint();
      return el('fieldset', { className: 'pos-group' },
        el('legend', { textContent: `${g.name}${g.required ? ' *' : ''}${g.max > 1 ? ` (ko‘pi bilan ${g.max})` : ''}` }), box);
    };
    const done = (v) => {
      dlg.close();
      resolve(v);
    };
    const add = el('button', { type: 'button', className: 'btn btn-wide', textContent: 'Qo‘shish' });
    add.addEventListener('click', () => {
      for (const g of groups) {
        const n = g.items.filter((m) => picked.has(m.id)).length;
        if (g.required && n < Math.max(1, g.min || 0)) {
          err.textContent = `${g.name} — tanlang.`;
          err.hidden = false;
          return;
        }
      }
      const mods = [...picked].map(([id, qty]) => ({ id, qty }));
      let qty = 1;
      if (weight) {
        qty = Math.round(Number(String(weight.value).replace(',', '.')) * 1000) / 1000;
        if (!(qty >= item.byWeight.min)) {
          err.textContent = `Eng kami ${item.byWeight.min} kg.`;
          err.hidden = false;
          return;
        }
      }
      done({ mods, qty });
    });
    dlg.append(
      el('h3', { textContent: item.name }),
      weight ? el('label', { className: 'pos-kg-row' }, el('span', { textContent: `Og‘irligi (kg) · 1 kg — ${formatPrice(item.price)}` }), weight) : '',
      ...groups.map(groupNode), err,
      el('div', { className: 'row' }, add, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Bekor', onclick: () => done(null) })));
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(null);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export async function openPos({ title, target, tabId = '', tableId = '', takeaway = false, allowTakeaway = false, onDone } = {}) {
  const dlg = el('dialog', { className: 'pos' });
  const lines = []; // { key, id, name, price, qty, mods, modNames, kg }
  const list = el('div', { className: 'pos-items', role: 'tabpanel' });
  const listHead = el('h3', { className: 'pos-list-head' });
  // chapda kategoriyalar ustuni: kategoriya bosiladi → o'ngda faqat o'sha kategoriya taomlari
  const cats = el('nav', { className: 'pos-cats', role: 'tablist', ariaLabel: 'Kategoriyalar', ariaOrientation: 'vertical' });
  const q = el('input', { type: 'search', className: 'pos-search', placeholder: 'Taom qidirish (hamma kategoriyadan)…', ariaLabel: 'Taom qidirish' });
  const cartList = el('ul', { className: 'pos-cart-list' });
  const totalEl = el('strong', { className: 'pos-total' });
  const countEl = el('span', { className: 'pos-count' });
  const comment = el('textarea', { className: 'pos-comment', rows: 2, maxLength: 300, placeholder: 'Izoh (oshxonaga): achchiqsiz, tezroq…' });
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const saboy = el('input', { type: 'checkbox', className: 'switch', checked: takeaway });
  const send = el('button', { type: 'button', className: 'btn btn-pay pos-send', textContent: 'Yuborish' });
  const cart = el('section', { className: 'pos-cart' });
  let active = '';
  let menu = { items: [], categories: [] };
  let catBtns = []; // [{ name, btn }]
  const catOf = (i) => i.category || 'Boshqa';

  const close = () => dlg.close();
  const total = () => lines.reduce((s, l) => s + Math.round(l.price * l.qty), 0);

  function paintCart() {
    cartList.replaceChildren(...(lines.length ? lines.map((l) => el('li', { className: 'pos-line' },
      el('div', { className: 'pos-line-main' }, el('strong', { textContent: l.name }), l.modNames ? el('small', { textContent: l.modNames }) : ''),
      l.kg
        ? el('span', { className: 'pos-qty-kg', textContent: kg(l.qty) })
        : el('div', { className: 'pos-qty' },
          el('button', { type: 'button', ariaLabel: 'Kamaytirish', textContent: '−', onclick: () => { l.qty -= 1; if (l.qty <= 0) lines.splice(lines.indexOf(l), 1); paintCart(); } }),
          el('span', { textContent: l.qty }),
          el('button', { type: 'button', ariaLabel: 'Ko‘paytirish', textContent: '+', onclick: () => { l.qty = Math.min(50, l.qty + 1); paintCart(); } })),
      el('span', { className: 'pos-line-sum', textContent: formatPrice(Math.round(l.price * l.qty)) }),
      el('button', { type: 'button', className: 'pos-x', ariaLabel: 'Olib tashlash', textContent: '×', onclick: () => { lines.splice(lines.indexOf(l), 1); paintCart(); } })))
      : [el('li', { className: 'pos-empty', textContent: 'Taom tanlang — chapdan bosing.' })]));
    const n = lines.reduce((s, l) => s + (l.kg ? 1 : l.qty), 0);
    countEl.textContent = n ? `${n} ta` : '';
    totalEl.textContent = formatPrice(total());
    send.disabled = !lines.length;
    send.textContent = lines.length ? `Yuborish · ${formatPrice(total())}` : 'Yuborish';
    cart.classList.toggle('has-items', lines.length > 0);
  }

  async function addItem(item) {
    let pick = { mods: [], qty: 1 };
    if (item.options?.length || item.byWeight) {
      pick = await chooseOptions(item);
      if (!pick) return;
    }
    const groups = item.options || [];
    const modItems = groups.flatMap((g) => g.items);
    const extra = pick.mods.reduce((s, m) => {
      const it = modItems.find((x) => x.id === m.id);
      const paid = it?.incl ? Math.max(0, m.qty - (it.def || 0)) : m.qty;
      return s + paid * (it?.price || 0);
    }, 0);
    const line = { id: item.id, name: item.name, price: item.price + extra, qty: pick.qty, mods: pick.mods, kg: Boolean(item.byWeight), modNames: pick.mods.map((m) => modItems.find((x) => x.id === m.id)?.name).filter(Boolean).join(', ') };
    line.key = lineKey(line);
    const same = !line.kg && lines.find((l) => l.key === line.key);
    if (same) same.qty = Math.min(50, same.qty + 1);
    else lines.push(line);
    paintCart();
    navigator.vibrate?.(15);
  }

  function paintMenu() {
    const text = q.value.trim().toLowerCase();
    const shown = text ? menu.items.filter((i) => i.name.toLowerCase().includes(text)) : menu.items.filter((i) => catOf(i) === active);
    listHead.textContent = text ? `Qidiruv · ${shown.length} ta` : active;
    list.replaceChildren(...(shown.length ? shown.map((i) => el('button', {
      type: 'button', className: `pos-item${i.available === false ? ' is-off' : ''}`, disabled: i.available === false,
      onclick: () => addItem(i),
    },
    el('span', { className: 'pos-item-name', textContent: i.name }),
    text ? el('span', { className: 'pos-item-cat', textContent: catOf(i) }) : '',
    el('span', { className: 'pos-item-price', textContent: `${formatPrice(i.price)}${i.byWeight ? ' /kg' : ''}` }),
    i.available === false ? el('span', { className: 'pos-item-tag', textContent: 'stop' }) : i.options?.length ? el('span', { className: 'pos-item-tag', textContent: '+ tanlov' }) : '')) : [el('p', { className: 'muted', textContent: text ? 'Topilmadi.' : 'Bu kategoriyada taom yo‘q.' })]));
    list.scrollTop = 0;
  }

  // Kategoriyalar menyudagi tartibda; bo'sh kategoriyalar ko'rsatilmaydi, ro'yxatda yo'q kategoriyalar oxiriga qo'shiladi.
  function buildCats() {
    const count = new Map();
    for (const i of menu.items) count.set(catOf(i), (count.get(catOf(i)) || 0) + 1);
    const known = (menu.categories || []).filter((c) => count.has(c));
    const names = [...new Set([...known, ...count.keys()])];
    catBtns = names.map((name) => ({
      name,
      btn: el('button', {
        type: 'button', role: 'tab', className: 'pos-cat',
        onclick: () => {
          active = name;
          q.value = '';
          paintCats();
          paintMenu();
        },
      }, el('span', { className: 'pos-cat-name', textContent: name }), el('span', { className: 'pos-cat-n', textContent: count.get(name) })),
    }));
    cats.replaceChildren(...catBtns.map((c) => c.btn));
    if (!names.includes(active)) active = names[0] || '';
  }

  function paintCats() {
    const searching = Boolean(q.value.trim());
    for (const { name, btn } of catBtns) {
      const on = !searching && name === active;
      btn.classList.toggle('is-on', on);
      btn.ariaSelected = String(on);
      btn.tabIndex = on || (searching && btn === catBtns[0].btn) ? 0 : -1;
      if (on) btn.scrollIntoView({ block: 'nearest' });
    }
  }

  // klaviatura: ↑ ↓ bilan kategoriya almashtirish
  cats.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const btns = catBtns.map((c) => c.btn);
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns[j].focus();
    btns[j].click();
  });
  q.addEventListener('input', () => {
    paintCats();
    paintMenu();
  });
  send.addEventListener('click', async () => {
    if (!lines.length) return;
    send.disabled = true;
    err.hidden = true;
    send.textContent = 'Yuborilmoqda…';
    try {
      const r = await api('/api/staff/orders/new', {
        method: 'POST',
        body: JSON.stringify({ target, tabId, tableId, takeaway: saboy.checked, comment: comment.value.trim(), items: lines.map((l) => ({ id: l.id, qty: l.qty, mods: l.mods })) }),
      });
      close();
      onDone?.(r);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      paintCart();
    }
  });

  cart.append(
    el('div', { className: 'pos-cart-head' }, el('h3', {}, 'Buyurtma ', countEl), totalEl),
    cartList,
    allowTakeaway ? el('label', { className: 'toggle pos-saboy' }, saboy, el('span', {}, el('b', { textContent: '🥡 Saboy' }), ' — olib ketadi, xizmat foizi qo‘shilmaydi')) : '',
    comment, err, send);
  dlg.append(
    el('header', { className: 'pos-head' },
      el('h2', { textContent: title }),
      el('button', { type: 'button', className: 'pos-close', ariaLabel: 'Yopish', textContent: '×', onclick: close })),
    el('div', { className: 'pos-body' },
      el('section', { className: 'pos-menu' }, q, cats, el('div', { className: 'pos-main' }, listHead, list)),
      cart));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  paintCart();
  list.replaceChildren(el('p', { className: 'muted', textContent: 'Menyu yuklanmoqda…' }));
  try {
    menu = await loadMenu();
    buildCats();
    paintCats();
    paintMenu();
  } catch (e) {
    list.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
  }
}
