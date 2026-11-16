import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, selectField, toggleField, imageField } from '../ui.js';

// O'z menyumiz va stollarimiz (Misonsiz rejim uchun). Mison rejimida bu yerdagi o'zgarishlar saytga chiqmaydi.
const num = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export async function render(root) {
  let { menu, status } = await api('/own/menu');
  const wrapBox = el('div', { className: 'stack' });
  let tab = 'taomlar';

  async function reload() {
    ({ menu, status } = await api('/own/menu'));
    paint();
  }

  const modeNote = () => (status.mode === 'own'
    ? el('p', { className: 'notice ok-note', textContent: 'Misonsiz rejim yoqilgan — bu yerdagi menyu va stollar saytda ishlayapti. O‘zgarish 1 daqiqa ichida saytga chiqadi.' })
    : el('p', { className: 'notice warn' }, 'Hozir Mison rejimi: saytdagi menyu Mison’dan keladi. Bu yerdagi o‘zgarishlar ', el('b', { textContent: '“Misonsiz ishlash”' }), ' bo‘limida rejimni almashtirgandan keyin ishlaydi.'));

  /* ───────── taom tahriri ───────── */
  function editItem(item) {
    const isNew = !item;
    const i = item || { name: '', price: '', category: menu?.categories?.[0] || '', available: true };
    const name = textField({ label: 'Nomi', value: i.name, maxlength: 120 });
    const NEW = '__new__';
    const cats = menu?.categories || [];
    const category = selectField({ label: 'Bo‘lim', value: cats.includes(i.category) ? i.category : (cats[0] || NEW), options: [...cats.map((c) => [c, c]), [NEW, '+ Yangi bo‘lim…']] });
    const newCat = textField({ label: 'Yangi bo‘lim nomi', value: '', maxlength: 60 });
    newCat.node.hidden = category.get() !== NEW;
    category.input.addEventListener('change', () => (newCat.node.hidden = category.get() !== NEW));
    const price = textField({ label: 'Narxi (so‘m)', value: i.price === '' ? '' : String(i.price), inputmode: 'numeric', maxlength: 12 });
    const weight = textField({ label: 'Og‘irligi / hajmi', value: i.weight || '', placeholder: '350 g yoki 0,5 l', maxlength: 30 });
    const perKg = toggleField({ label: 'Narx 1 kg uchun (og‘irlik bo‘yicha sotiladi)', checked: Boolean(i.perKg) });
    const desc = textField({ label: 'Tarkibi / izoh', value: i.description || '', rows: 3, maxlength: 300 });
    const image = imageField({ label: 'Rasm', value: i.image || '' });
    const available = toggleField({ label: 'Sotuvda bor (o‘chirilsa — stop-listda)', checked: i.available !== false });
    const err = el('p', { className: 'form-error', hidden: true });
    const dlg = el('dialog', { className: 'edit-dialog' });
    const close = () => dlg.close();
    const save = btn(isNew ? 'Qo‘shish' : 'Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
      err.hidden = true;
      try {
        await api(`/own/items/${isNew ? 'new' : encodeURIComponent(i.id)}`, {
          method: 'PUT',
          body: {
            name: name.get(), category: category.get() === NEW ? newCat.get() : category.get(), price: price.get(),
            weight: weight.get(), perKg: perKg.get(), description: desc.get(), image: image.get(), available: available.get(),
          },
        });
        toast(isNew ? 'Taom qo‘shildi.' : 'Saqlandi.');
        close();
        await reload();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    }));
    const del = isNew ? '' : btn('O‘chirish', (e) => {
      if (!confirm(`“${i.name}” menyudan o‘chirilsinmi?`)) return;
      busy(e.currentTarget, '…', async () => {
        try {
          await api(`/own/items/${encodeURIComponent(i.id)}`, { method: 'DELETE' });
          close();
          await reload();
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });
    }, 'btn-text danger');
    dlg.append(
      el('h2', { textContent: isNew ? 'Yangi taom' : i.name }),
      el('div', { className: 'grid-2' }, name.node, price.node, category.node, newCat.node, weight.node),
      perKg.node, desc.node, image.node, available.node,
      i.options?.length ? el('p', { className: 'muted small', textContent: `Qo‘shimchalar (Mison’dan): ${i.options.map((g) => `${g.name}: ${g.items.map((m) => m.name).join(', ')}`).join(' · ')}` }) : '',
      err,
      el('div', { className: 'row wrap dialog-actions' }, save, btn('Bekor', close, 'btn-ghost'), del));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    setTimeout(() => (isNew ? name.input : price.input).focus(), 30);
  }

  /* ───────── taomlar ro'yxati ───────── */
  function itemsView() {
    if (!menu?.items?.length) {
      return card('Menyu hali yo‘q', '',
        el('p', { textContent: 'Mison’dagi menyudan nusxa oling (tavsiya) yoki birinchi taomni qo‘lda qo‘shing.' }),
        el('div', { className: 'row wrap' },
          btn('Mison’dan nusxa olish', (e) => busy(e.currentTarget, 'Nusxa olinmoqda…', async () => {
            try {
              const r = await api('/own/import', { method: 'POST', body: {} });
              toast(`${r.items} taom, ${r.tables} stol ko‘chirildi.`);
              await reload();
            } catch (err) {
              toast(err.message, 'error');
            }
          })),
          btn('+ Taom qo‘shish', () => editItem(null), 'btn-ghost')));
    }
    const q = el('input', { type: 'search', className: 'search-input', placeholder: 'Taom qidirish…' });
    const filter = el('select', {}, el('option', { value: '', textContent: 'Barcha bo‘limlar' }), ...menu.categories.map((c) => el('option', { value: c, textContent: c })));
    const list = el('div', { className: 'stack' });
    const paintList = () => {
      const text = q.value.trim().toLowerCase();
      const groups = menu.categories.filter((c) => !filter.value || c === filter.value).map((c) => {
        const items = menu.items.filter((i) => i.category === c && (!text || i.name.toLowerCase().includes(text)));
        if (!items.length) return null;
        return el('section', { className: 'own-cat' },
          el('h3', { textContent: `${c} · ${items.length}` }),
          el('ul', { className: 'item-list own-items' }, items.map((i) => {
            const sw = el('input', { type: 'checkbox', className: 'switch', checked: i.available !== false, title: 'Sotuvda bor' });
            sw.addEventListener('change', async () => {
              try {
                await api(`/own/items/${encodeURIComponent(i.id)}/available`, { method: 'PUT', body: { available: sw.checked } });
                i.available = sw.checked;
                toast(sw.checked ? `${i.name} — sotuvda` : `${i.name} — stop-listda`);
              } catch (err) {
                sw.checked = !sw.checked;
                toast(err.message, 'error');
              }
            });
            return el('li', { className: `item own-item${i.available === false ? ' is-off' : ''}` },
              i.image ? el('img', { className: 'own-thumb', src: i.image, alt: '', loading: 'lazy' }) : el('span', { className: 'own-thumb is-empty', textContent: '🍽' }),
              el('div', { className: 'item-main' },
                el('h3', { textContent: i.name }),
                el('p', { className: 'muted', textContent: [i.weight, i.perKg ? '1 kg narxi' : '', i.options?.length ? `${i.options.length} ta qo‘shimcha guruhi` : ''].filter(Boolean).join(' · ') || ' ' })),
              el('strong', { className: 'own-price', textContent: `${num(i.price)} so‘m` }),
              el('label', { className: 'toggle' }, sw),
              btn('Tahrirlash', () => editItem(i), 'btn-ghost btn-small'));
          })));
      }).filter(Boolean);
      list.replaceChildren(...(groups.length ? groups : [el('p', { className: 'empty', textContent: 'Topilmadi.' })]));
    };
    q.addEventListener('input', paintList);
    filter.addEventListener('change', paintList);
    paintList();

    // Bo'limlar: tartib, nom, o'chirish
    const catRows = menu.categories.map((c, idx) => {
      const n = menu.items.filter((i) => i.category === c).length;
      const move = (d) => async () => {
        const order = [...menu.categories];
        const j = idx + d;
        if (j < 0 || j >= order.length) return;
        [order[idx], order[j]] = [order[j], order[idx]];
        try {
          await api('/own/categories', { method: 'PUT', body: { order } });
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      return el('li', { className: 'cat-row' },
        el('span', { textContent: `${c} · ${n}` }),
        el('div', { className: 'row' },
          btn('↑', move(-1), 'btn-ghost btn-small'), btn('↓', move(1), 'btn-ghost btn-small'),
          btn('Nomi', async () => {
            const to = prompt('Bo‘lim nomi:', c);
            if (!to || to === c) return;
            try {
              await api('/own/categories', { method: 'PUT', body: { rename: { from: c, to } } });
              await reload();
            } catch (err) {
              toast(err.message, 'error');
            }
          }, 'btn-ghost btn-small'),
          n ? '' : btn('O‘chirish', async () => {
            try {
              await api('/own/categories', { method: 'PUT', body: { remove: c } });
              await reload();
            } catch (err) {
              toast(err.message, 'error');
            }
          }, 'btn-text btn-small danger')));
    });

    return el('div', { className: 'stack' },
      el('div', { className: 'row wrap align-center own-toolbar' }, q, filter, btn('+ Taom qo‘shish', () => editItem(null))),
      el('details', { className: 'card cat-manager' }, el('summary', { textContent: `Bo‘limlar tartibi va nomlari (${menu.categories.length})` }), el('ul', { className: 'cat-list' }, catRows)),
      list);
  }

  /* ───────── stollar ───────── */
  async function tablesView() {
    const r = await api('/own/tables');
    let halls = structuredClone(r.own?.halls || r.current?.halls || []);
    const box = el('div', { className: 'stack' });
    const paintHalls = () => {
      box.replaceChildren(...halls.map((h, hi) => {
        const hname = el('input', { type: 'text', value: h.name, maxLength: 40, className: 'hall-name', ariaLabel: 'Zal nomi' });
        hname.addEventListener('input', () => (h.name = hname.value));
        const add = el('input', { type: 'text', placeholder: 'Stol nomi yoki 1-12', maxLength: 40, className: 'search-input' });
        const addBtn = btn('Qo‘shish', () => {
          const v = add.value.trim();
          if (!v) return;
          const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(v);
          const names = range ? Array.from({ length: Math.min(100, Math.max(0, range[2] - range[1] + 1)) }, (_, k) => String(Number(range[1]) + k)) : [v];
          for (const n of names) if (!h.tables.some((t) => t.name === n)) h.tables.push({ id: '', name: n });
          add.value = '';
          paintHalls();
        }, 'btn-ghost btn-small');
        add.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), addBtn.click()));
        return el('div', { className: 'card hall-card' },
          el('div', { className: 'row align-center wrap' }, hname, el('span', { className: 'muted', textContent: `${h.tables.length} stol` }),
            halls.length > 1 ? btn('Zalni o‘chirish', () => {
              if (h.tables.length && !confirm(`${h.name} va undagi ${h.tables.length} stol o‘chirilsinmi?`)) return;
              halls.splice(hi, 1);
              paintHalls();
            }, 'btn-text btn-small danger') : ''),
          el('div', { className: 'table-chips' }, h.tables.map((t, ti) => el('span', { className: 'table-chip' },
            el('button', { type: 'button', className: 'chip-name', textContent: t.name, title: 'Nomini o‘zgartirish', onclick: () => {
              const v = prompt('Stol nomi:', t.name);
              if (v && v.trim()) {
                t.name = v.trim().slice(0, 40);
                paintHalls();
              }
            } }),
            t.id ? '' : el('small', { textContent: 'yangi' }),
            el('button', { type: 'button', className: 'chip-x', ariaLabel: `${t.name} o‘chirish`, textContent: '×', onclick: () => {
              h.tables.splice(ti, 1);
              paintHalls();
            } })))),
          el('div', { className: 'row align-center' }, add, addBtn));
      }));
    };
    paintHalls();
    const save = btn('Stollarni saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
      try {
        const res = await api('/own/tables', { method: 'PUT', body: { halls } });
        halls = structuredClone(res.halls);
        paintHalls();
        toast('Stollar saqlandi. Yangi stollar uchun QR stikerni “Stollar” bo‘limidan chop eting.');
      } catch (err) {
        toast(err.message, 'error');
      }
    }));
    return el('div', { className: 'stack' },
      el('p', { className: 'muted', textContent: r.own ? 'O‘z stollarimiz.' : 'Hozircha Mison’dagi stollar ko‘rsatildi — saqlasangiz, o‘zimizniki bo‘ladi.' }),
      box,
      el('div', { className: 'row wrap' }, btn('+ Zal qo‘shish', () => {
        halls.push({ id: '', name: `Zal ${halls.length + 1}`, tables: [] });
        paintHalls();
      }, 'btn-ghost'), save),
      el('p', { className: 'muted small', textContent: 'Mavjud stollarning ID’si o‘zgarmaydi — stollardagi QR stikerlar ishlayveradi. Stolni o‘chirsangiz, uning stikeri ishlamay qoladi.' }));
  }

  async function paint() {
    const tabs = el('div', { className: 'seg' },
      ...[['taomlar', `Taomlar${menu?.items ? ` (${menu.items.length})` : ''}`], ['stollar', 'Stollar']].map(([k, l]) => el('button', {
        type: 'button', className: `seg-btn${tab === k ? ' is-on' : ''}`, textContent: l, onclick: () => {
          tab = k;
          paint();
        },
      })));
    const body = tab === 'taomlar' ? itemsView() : await tablesView();
    wrapBox.replaceChildren(modeNote(), tabs, body);
  }

  root.append(pageHead('Menyu tahriri', 'O‘z menyumiz va stollarimiz: narx, rasm, yangi taom, stop-list, bo‘limlar tartibi. Misonsiz rejimda sayt shu yerdan ishlaydi.'), wrapBox);
  await paint();
}
