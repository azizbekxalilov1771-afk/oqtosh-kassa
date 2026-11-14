import { api } from '../auth.js';
import { el, btn, pageHead, card, textField, selectField, toggleField, imageField, listField, saveBar } from '../ui.js';

const TYPE_LABEL = { builtin: 'Tayyor bo‘lim', text: 'Matn va rasm', gallery: 'Rasmlar galereyasi', banner: 'E’lon banneri' };
const BUILTIN_HINT = {
  news: 'Matni "Yangiliklar" sahifasidan boshqariladi.',
  about: 'Matni "Restoran ma’lumotlari" sahifasidan.',
  contact: 'Telefon va ijtimoiy tarmoqlar "Restoran ma’lumotlari"dan.',
  locations: 'Filiallar "Manzillar" sahifasidan.',
};
const newId = () => `s_${Math.random().toString(36).slice(2, 10)}`;

// Bitta bo'lim tahrirlovchisi: { node, get() }
function sectionEditor(s) {
  const f = {
    title: textField({ label: 'Sarlavha', value: s.title, maxlength: s.type === 'builtin' ? 60 : 80 }),
  };
  if (s.type === 'text') {
    f.text = textField({ label: 'Matn', value: s.text, rows: 6, maxlength: 4000 });
    f.image = imageField({ label: 'Rasm', value: s.image });
    f.imageSide = selectField({ label: 'Rasm joyi', value: s.imageSide, options: [['right', 'O‘ngda'], ['left', 'Chapda']] });
    f.buttonLabel = textField({ label: 'Tugma yozuvi', value: s.buttonLabel, placeholder: 'Masalan: Stol band qilish', maxlength: 40 });
    f.buttonUrl = textField({ label: 'Tugma havolasi', value: s.buttonUrl, placeholder: 'https://... , /menyu.html yoki tel:+998...', maxlength: 600 });
  } else if (s.type === 'gallery') {
    f.text = textField({ label: 'Qisqa matn', value: s.text, rows: 2, maxlength: 600 });
    f.images = listField({
      label: 'Rasmlar', items: s.images || [], max: 24, addLabel: 'Rasm qo‘shish',
      itemTitle: (i) => `${i + 1}-rasm`, blank: () => '',
      make: (img) => imageField({ value: img }),
    });
  } else if (s.type === 'banner') {
    f.text = textField({ label: 'Matn', value: s.text, rows: 3, maxlength: 1000 });
    f.buttonLabel = textField({ label: 'Tugma yozuvi', value: s.buttonLabel, maxlength: 40 });
    f.buttonUrl = textField({ label: 'Tugma havolasi', value: s.buttonUrl, placeholder: 'https://... , /menyu.html yoki tel:+998...', maxlength: 600 });
  }
  const node = el('div', { className: 'section-editor stack-sm' },
    s.type === 'builtin' && el('p', { className: 'hint', textContent: BUILTIN_HINT[s.key] }),
    Object.values(f).map((x) => x.node));
  return { node, get: () => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.get()])) };
}

export async function render(root) {
  const { sections } = await api('/sections');
  let rows = [];
  const listBox = el('ol', { className: 'section-list' });

  function makeRow(s, open = false) {
    const row = { s, editor: sectionEditor(s) };
    const visible = toggleField({ label: 'Saytda', checked: s.visible });
    const nav = toggleField({ label: 'Menyuda', checked: s.nav });
    row.get = () => ({ ...s, ...row.editor.get(), visible: visible.get(), nav: nav.get() });
    const titleText = el('strong', { textContent: s.title });
    row.editor.node.addEventListener('input', () => (titleText.textContent = row.editor.get().title || 'Sarlavhasiz'));
    const details = el('details', { className: 'section-body', open }, el('summary', { textContent: 'Tahrirlash' }), row.editor.node);
    const up = el('button', { type: 'button', className: 'icon-btn', textContent: '↑', ariaLabel: 'Yuqoriga', onclick: () => move(row, -1) });
    const down = el('button', { type: 'button', className: 'icon-btn', textContent: '↓', ariaLabel: 'Pastga', onclick: () => move(row, 1) });
    const del = s.type !== 'builtin' && el('button', { type: 'button', className: 'icon-btn danger', textContent: '×', ariaLabel: 'Bo‘limni o‘chirish', onclick: () => {
      if (!confirm(`"${row.get().title}" bo‘limini o‘chirasizmi?`)) return;
      rows = rows.filter((r) => r !== row);
      paint();
      listBox.dispatchEvent(new Event('input', { bubbles: true }));
    } });
    row.up = up;
    row.down = down;
    row.node = el('li', { className: 'section-row' },
      el('div', { className: 'section-row-head' },
        el('div', { className: 'section-title' }, titleText, el('span', { className: 'chip is-muted', textContent: TYPE_LABEL[s.type] })),
        el('div', { className: 'row section-toggles' }, visible.node, nav.node),
        el('div', { className: 'row' }, up, down, del)),
      details);
    return row;
  }

  function paint() {
    listBox.replaceChildren(...rows.map((r) => r.node));
    rows.forEach((r, i) => {
      r.up.disabled = i === 0;
      r.down.disabled = i === rows.length - 1;
    });
  }
  function move(row, delta) {
    const i = rows.indexOf(row);
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    paint();
    listBox.dispatchEvent(new Event('input', { bubbles: true }));
  }

  rows = sections.map((s) => makeRow(s));
  paint();

  const type = selectField({ label: 'Yangi bo‘lim turi', value: 'text', options: [['text', 'Matn va rasm'], ['gallery', 'Rasmlar galereyasi'], ['banner', 'E’lon banneri (rangli)']] });
  const add = btn('Bo‘lim qo‘shish', () => {
    const t = type.get();
    const s = { id: newId(), type: t, title: '', visible: true, nav: false, text: '', image: '', imageSide: 'right', buttonLabel: '', buttonUrl: '', images: [] };
    const row = makeRow(s, true);
    rows.push(row);
    paint();
    row.node.querySelector('input')?.focus();
    row.node.scrollIntoView({ block: 'center' });
    listBox.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'btn-ghost');

  const page = el('div', { className: 'stack' },
    card('Saytdagi tartib', 'Logo har doim birinchi turadi. Qolgan bo‘limlarni ↑ ↓ bilan suring, keraksizini yashiring. "Menyuda" — sayt tepasidagi havolalar.', listBox),
    card('Yangi bo‘lim', 'Aksiya, banket zali, oshpaz haqida, fotogalereya — istalgan narsani alohida bo‘lim qilib qo‘shing.', el('div', { className: 'row align-end' }, type.node, add)));

  const bar = saveBar(page, async () => {
    const saved = await api('/sections', { method: 'PUT', body: { sections: rows.map((r) => r.get()) } });
    rows = saved.sections.map((s) => makeRow(s));
    paint();
  });

  root.append(pageHead('Bo‘limlar', 'Saytda qaysi bo‘limlar, qaysi tartibda ko‘rinishi.'), page, bar.node);
}
