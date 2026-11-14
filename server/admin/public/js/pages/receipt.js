import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, saveBar, textField, selectField, toggleField, group } from '../ui.js';

// Chek ko'rinishi: oshxona cheki, hisob va to'lov cheki, Mison'ga ketadigan izoh.
// O'ngdagi namuna server chizgan aynan o'sha qatorlardan — printerdan qanday chiqsa, shunday ko'rinadi.

export async function render(root) {
  const data = await api('/receipt');
  const r = data.receipt;
  const form = el('div', { className: 'receipt-form' });

  // ── oshxona ──
  const k = {
    title: textField({ label: 'Sarlavha', value: r.kitchen.title, maxlength: 30, placeholder: 'bo‘sh — tayyorlash joyi nomi (SALAT, SHASHLIK…)' }),
    itemSize: selectField({ label: 'Taom yozuvi', value: r.kitchen.itemSize, options: [['normal', 'Oddiy'], ['tall', 'Baland (tavsiya)'], ['big', 'Katta (2 barobar)']] }),
    feed: selectField({ label: 'Kesishdan oldin bo‘sh joy', value: String(r.kitchen.feed), options: [1, 2, 3, 4, 5, 6].map((n) => [String(n), `${n} qator`]) }),
    showNumber: toggleField({ label: 'Buyurtma raqami (#27)', checked: r.kitchen.showNumber }),
    showTime: toggleField({ label: 'Vaqt', checked: r.kitchen.showTime }),
    showWaiter: toggleField({ label: 'Ofitsiant ismi', checked: r.kitchen.showWaiter }),
    showHall: toggleField({ label: 'Zal nomi', checked: r.kitchen.showHall }),
    showMods: toggleField({ label: 'Qo‘shimchalar (+ go‘sht, sousiz…)', checked: r.kitchen.showMods }),
    showComment: toggleField({ label: 'Mijoz izohi', checked: r.kitchen.showComment }),
    separateItems: toggleField({ label: 'Taomlar orasida chiziq', checked: r.kitchen.separateItems }),
  };
  // ── kassa ──
  const b = {
    title: textField({ label: 'Sarlavha', value: r.bill.title, maxlength: 40, placeholder: 'bo‘sh — restoran nomi' }),
    extra: textField({ label: 'Qo‘shimcha qatorlar (3 tagacha)', value: r.bill.extra, rows: 3, maxlength: 150, placeholder: 'INN 123456789\nWi‑Fi: Oqtosh / parol 12345678' }),
    footer: textField({ label: 'Pastki yozuv', value: r.bill.footer, maxlength: 120, placeholder: data.footer || 'Rahmat! Yana kutib qolamiz' }),
    showAddress: toggleField({ label: 'Manzil', checked: r.bill.showAddress }),
    showPhone: toggleField({ label: 'Telefon', checked: r.bill.showPhone }),
    showDate: toggleField({ label: 'Sana va vaqt', checked: r.bill.showDate }),
    showWaiter: toggleField({ label: 'Ofitsiant', checked: r.bill.showWaiter }),
    showMods: toggleField({ label: 'Qo‘shimchalar', checked: r.bill.showMods }),
    showUnitPrice: toggleField({ label: 'Narxi alohida qatorda (2 x 45 000)', checked: r.bill.showUnitPrice }),
    showFiscalNote: toggleField({ label: '“Fiskal chek kassada” yozuvi', checked: r.bill.showFiscalNote }),
    showCheckNo: toggleField({ label: 'Chek raqami va kassir', checked: r.bill.showCheckNo }),
  };
  // ── Mison ──
  const m = {
    table: selectField({ label: 'Stol nomi izohda', value: r.mison.table, options: [['auto', 'Faqat Mison stolni topa olmasa (tavsiya)'], ['always', 'Har doim'], ['never', 'Hech qachon']] }),
    number: toggleField({ label: 'Sayt raqami (sayt #27)', checked: r.mison.number }),
    waiter: toggleField({ label: 'Buyurtma yozgan xodim ismi', checked: r.mison.waiter }),
  };

  const collect = () => ({
    kitchen: Object.fromEntries(Object.entries(k).map(([key, f]) => [key, key === 'feed' ? Number(f.get()) : f.get()])),
    bill: Object.fromEntries(Object.entries(b).map(([key, f]) => [key, f.get()])),
    mison: Object.fromEntries(Object.entries(m).map(([key, f]) => [key, f.get()])),
  });

  // ── namuna ──
  let kind = 'kitchen';
  let paper = data.paper === 58 ? 58 : 80;
  const paperBox = el('div', { className: `rp-paper w${paper}` });
  const misonBox = el('div', { className: 'rp-mison' });
  const tabs = el('div', { className: 'chips rp-tabs', role: 'tablist' });
  const paperSel = el('div', { className: 'chips rp-tabs' });
  const paintTabs = () => {
    tabs.replaceChildren(...[['kitchen', 'Oshxona cheki'], ['tab', 'Hisob'], ['paid', 'To‘lov cheki']].map(([v, label]) => el('button', {
      type: 'button', role: 'tab', className: `chip${kind === v ? ' is-on' : ''}`, ariaSelected: String(kind === v), textContent: label,
      onclick: () => { kind = v; paintTabs(); preview(); },
    })));
    paperSel.replaceChildren(...[80, 58].map((w) => el('button', {
      type: 'button', className: `chip${paper === w ? ' is-on' : ''}`, textContent: `${w} mm`,
      onclick: () => { paper = w; paintTabs(); preview(); },
    })));
  };
  paintTabs();

  let seq = 0;
  let timer = null;
  async function preview() {
    const my = ++seq;
    try {
      const res = await api('/receipt/preview', { method: 'POST', body: { receipt: collect(), kind, paper } });
      if (my !== seq) return;
      paperBox.className = `rp-paper w${paper}`;
      paperBox.style.setProperty('--cols', res.width);
      paperBox.replaceChildren(...res.lines.map((l) => {
        if (l.cut) return el('div', { className: 'rp-cut', textContent: '✂ — — — kesish — — —' });
        if (l.beep) return el('div', { className: 'rp-beep', textContent: '🔔 signal' });
        return el('div', { className: `rp-line a-${l.a}${l.b ? ' b' : ''}${l.s === 2 ? ' s2' : l.s === 'tall' ? ' st' : ''}`, textContent: l.t || ' ' });
      }));
      misonBox.replaceChildren(
        el('p', { className: 'muted small', textContent: 'Mison chekidagi izoh (stol Mison’da topilganda):' }),
        el('code', { textContent: res.misonComment || '—' }),
        res.misonCommentNoTable !== res.misonComment ? el('p', { className: 'muted small', textContent: `Stol topilmasa: ${res.misonCommentNoTable}` }) : '');
    } catch (e) {
      if (my === seq) paperBox.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
  }
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 250); });
  form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(preview, 100); });

  const bar = saveBar(form, async () => {
    await api('/receipt', { method: 'PUT', body: collect() });
  });

  const reset = btn('Odatiy holatga qaytarish', () => {
    if (!confirm('Barcha chek sozlamalari odatiy holatga qaytsinmi?')) return;
    const d = data.defaults;
    for (const [key, f] of Object.entries(k)) f.set(key === 'feed' ? String(d.kitchen[key]) : d.kitchen[key]);
    for (const [key, f] of Object.entries(b)) f.set(d.bill[key]);
    for (const [key, f] of Object.entries(m)) f.set(d.mison[key]);
    form.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'btn-ghost');

  form.append(
    card('Oshxona cheki', 'Tayyorlash joylariga (salat, issiq ovqat, shashlik…) chiqadigan chek. Stol nomi har doim katta harfda.',
      group({ a: k.title, b: k.itemSize }).node, group({ a: k.feed }).node,
      el('div', { className: 'toggle-grid' }, k.showNumber.node, k.showTime.node, k.showWaiter.node, k.showHall.node, k.showMods.node, k.showComment.node, k.separateItems.node)),
    card('Hisob va to‘lov cheki', 'Mijozga beriladigan chek (kassa printeri yoki kassa kompyuteri brauzeri).',
      group({ a: b.title, c: b.footer }).node, b.extra.node,
      el('div', { className: 'toggle-grid' }, b.showAddress.node, b.showPhone.node, b.showDate.node, b.showWaiter.node, b.showMods.node, b.showUnitPrice.node, b.showFiscalNote.node, b.showCheckNo.node)),
    card('Mison’ga ketadigan izoh', 'Mison kassasi o‘z chekida stol, mijoz va taomlarni baribir chiqaradi — izoh qanchalik qisqa bo‘lsa, chek shunchalik toza. Mison chekining qolgan ko‘rinishi Mison kabinetida sozlanadi.',
      group({ a: m.table }).node, el('div', { className: 'toggle-grid' }, m.number.node, m.waiter.node), misonBox),
    bar.node);

  root.append(
    pageHead('Chek ko‘rinishi', 'Oshxona va kassa cheklarida nima chiqishini tanlang — o‘ngda printerdan qanday chiqishi darhol ko‘rinadi.', reset),
    el('div', { className: 'receipt-layout' },
      form,
      el('aside', { className: 'receipt-preview' },
        el('div', { className: 'rp-head' }, tabs, paperSel),
        paperBox,
        el('p', { className: 'muted small', textContent: 'Printer kirill harflarni lotinga o‘giradi (Салат → Salat), o‘ → o\'.' }))));
  preview();
}
