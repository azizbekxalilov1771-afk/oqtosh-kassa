import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card } from '../ui.js';

// Og'irlik bo'yicha sotiladigan taomlar: mijoz "0,7 kg" yoki "100 000 so'mlik" buyurtma qiladi.
// Mison'da birligi kg bo'lgan taomlar o'zi yoqilgan; bu yerda istalgan taomni yoqish/o'chirish va qadamni sozlash mumkin.
export async function render(root) {
  let { items, config } = await api('/menu/items');
  const state = new Map(); // id → { on, step, min }
  for (const i of items) {
    const c = config.weighted?.[i.id];
    state.set(i.id, { on: c ? c.on !== false : i.perKg, step: c?.step ?? i.byWeight?.step ?? 0.1, min: c?.min ?? i.byWeight?.min ?? 0.1, custom: Boolean(c) });
  }
  const q = el('input', { type: 'search', placeholder: 'Taom qidirish', className: 'search-input' });
  const onlyOn = el('input', { type: 'checkbox', className: 'switch' });
  const list = el('ul', { className: 'item-list weight-list' });
  const fmt = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;

  function paint() {
    const text = q.value.trim().toLowerCase();
    const shown = items.filter((i) => (!text || i.name.toLowerCase().includes(text) || String(i.category).toLowerCase().includes(text)) && (!onlyOn.checked || state.get(i.id).on));
    list.replaceChildren(...(shown.length ? shown.slice(0, 300).map((i) => {
      const s = state.get(i.id);
      const on = el('input', { type: 'checkbox', className: 'switch', checked: s.on, ariaLabel: `${i.name}: og‘irlik bo‘yicha` });
      const step = el('input', { type: 'number', min: 0.01, max: 5, step: 0.01, value: s.step, className: 'pct-input', disabled: !s.on });
      const min = el('input', { type: 'number', min: 0.01, max: 10, step: 0.01, value: s.min, className: 'pct-input', disabled: !s.on });
      on.addEventListener('change', () => { s.on = on.checked; s.custom = true; step.disabled = min.disabled = !s.on; });
      step.addEventListener('input', () => { s.step = Number(step.value); s.custom = true; });
      min.addEventListener('input', () => { s.min = Number(min.value); s.custom = true; });
      return el('li', { className: `item${s.on ? ' is-on' : ''}` },
        el('div', { className: 'item-main' },
          el('h3', { textContent: i.name }),
          el('p', { className: 'muted', textContent: `${i.category || ''} · ${fmt(i.price)}${s.on ? ' / kg' : ''}${i.weight ? ` · ${i.weight}` : ''}${i.perKg ? ' · Mison: kg' : ''}` })),
        el('div', { className: 'weight-ctl' },
          el('label', { className: 'toggle' }, on, el('span', { textContent: 'kg bilan' })),
          el('label', { className: 'mini-field' }, el('span', { textContent: 'qadam, kg' }), step),
          el('label', { className: 'mini-field' }, el('span', { textContent: 'eng kami, kg' }), min)));
    }) : [el('li', { className: 'empty', textContent: items.length ? 'Topilmadi.' : 'Menyu bo‘sh — avval Kalitlar → Mison’ni ulang.' })]));
  }
  q.addEventListener('input', paint);
  onlyOn.addEventListener('change', paint);

  const save = btn('Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
    const weighted = {};
    for (const [id, s] of state) {
      const item = items.find((i) => i.id === id);
      // faqat Mison'dagidan farq qiladiganlari saqlanadi
      if (s.custom && (s.on !== item.perKg || s.on)) weighted[id] = s.on ? { on: true, step: s.step || 0.1, min: s.min || s.step || 0.1 } : { on: false };
    }
    try {
      await api('/menu/config', { method: 'PUT', body: { weighted } });
      toast('Saqlandi. Saytda 1 daqiqa ichida ko‘rinadi.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));
  paint();
  root.append(
    pageHead('Menyu: og‘irlik bo‘yicha', 'Masalan: jiz 1 kg = 100 000 so‘m. Yoqilgan taomni mijoz 0,5 / 0,7 / 1,5 kg yoki “100 000 so‘mlik” qilib buyurtma qiladi — summasi o‘zi hisoblanadi.', save),
    card('', '',
      el('div', { className: 'row align-center wrap' }, q, el('label', { className: 'toggle' }, onlyOn, el('span', { textContent: 'Faqat yoqilganlar' }))),
      list));
}
