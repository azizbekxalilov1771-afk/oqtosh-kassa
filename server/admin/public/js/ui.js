// Admin panel uchun DOM yordamchilari va forma maydonlari.
// Hamma matn textContent orqali chiqariladi — innerHTML ishlatilmaydi.
import { api } from './auth.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const { dataset, attrs, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false && c !== '') node.append(c);
  return node;
}

export function btn(label, onClick, kind = '') {
  const b = el('button', { type: 'button', className: `btn ${kind}`.trim(), textContent: label });
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// Tugma bosilganda kutish holati: yozuvi o'zgaradi, ikki marta bosilmaydi
export async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

let toastTimer;
export function toast(message, kind = 'ok') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast is-${kind} is-shown`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-shown'), kind === 'error' ? 6000 : 3000);
}

export const pageHead = (title, desc, ...actions) =>
  el('div', { className: 'page-head' },
    el('div', {}, el('h1', { textContent: title, tabIndex: -1 }), desc && el('p', { className: 'muted', textContent: desc })),
    actions.length ? el('div', { className: 'page-actions' }, actions) : '');

export const card = (title, desc, ...children) =>
  el('section', { className: 'card' },
    title && el('h2', { textContent: title }),
    desc && el('p', { className: 'muted card-desc', textContent: desc }),
    children);

let uid = 0;
const nextId = () => `f${++uid}`;

function wrap(label, control, hint, extraClass = '') {
  const id = control.id || (control.id = nextId());
  return el('div', { className: `field ${extraClass}`.trim() },
    label && el('label', { htmlFor: id, textContent: label }),
    control,
    hint && el('p', { className: 'hint', textContent: hint }));
}

/* ───────── maydonlar: har biri { node, get(), set() } ───────── */

export function textField({ label, value = '', hint, type = 'text', placeholder = '', maxlength = 300, rows = 0, inputmode }) {
  const input = rows
    ? el('textarea', { rows, value: value ?? '', placeholder, maxLength: maxlength })
    : el('input', { type, value: value ?? '', placeholder, maxLength: maxlength });
  if (inputmode) input.inputMode = inputmode;
  return { node: wrap(label, input, hint), input, get: () => input.value.trim(), set: (v) => (input.value = v ?? '') };
}

export function selectField({ label, value, options, hint }) {
  const select = el('select', {}, options.map(([v, l]) => el('option', { value: v, textContent: l })));
  select.value = value ?? options[0][0];
  return { node: wrap(label, select, hint), input: select, get: () => select.value, set: (v) => (select.value = v) };
}

export function toggleField({ label, checked = true, hint }) {
  const input = el('input', { type: 'checkbox', checked: Boolean(checked), className: 'switch' });
  const node = el('label', { className: 'toggle' }, input, el('span', { textContent: label }));
  return { node: hint ? el('div', { className: 'field' }, node, el('p', { className: 'hint', textContent: hint })) : node, input, get: () => input.checked, set: (v) => (input.checked = !!v) };
}

// Rasm: brauzerda kichraytiriladi (≤ 880 KB, WEBP), serverga yuklanadi, havolasi saqlanadi
async function compressImage(file) {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('JPG, PNG, WEBP yoki GIF rasm tanlang.');
  const toDataUrl = (blob) => new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = fail;
    r.readAsDataURL(blob);
  });
  if (file.type === 'image/gif' && file.size <= 880_000) return toDataUrl(file);
  const bitmap = await createImageBitmap(file);
  let max = 1800;
  let quality = 0.86;
  for (let i = 0; i < 7; i++) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob && blob.size <= 880_000) return toDataUrl(blob);
    max *= 0.8;
    quality -= 0.08;
  }
  throw new Error('Rasm juda katta — kichikroq rasm tanlang.');
}

export function imageField({ label, value = '', hint }) {
  let current = value || '';
  const preview = el('div', { className: 'image-preview' });
  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', className: 'visually-hidden' });
  const upload = btn('Rasm yuklash', () => file.click(), 'btn-ghost btn-small');
  const remove = btn('Olib tashlash', () => set(''), 'btn-text btn-small');
  const urlInput = el('input', { type: 'url', placeholder: 'yoki rasm havolasi: https://...', maxLength: 600 });
  urlInput.addEventListener('change', () => set(urlInput.value.trim(), true));

  function set(v, fromInput = false) {
    current = v || '';
    preview.replaceChildren(current ? el('img', { src: current, alt: '' }) : el('span', { className: 'muted', textContent: 'Rasm yo‘q' }));
    remove.hidden = !current;
    if (!fromInput) urlInput.value = current.startsWith('https://') ? current : '';
    preview.dispatchEvent(new Event('input', { bubbles: true }));
  }

  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    await busy(upload, 'Yuklanmoqda…', async () => {
      try {
        const dataUrl = await compressImage(f);
        const { url } = await api('/media', { method: 'POST', body: { dataUrl } });
        set(url);
        toast('Rasm yuklandi. Saqlashni unutmang.');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  set(current);
  const node = el('div', { className: 'field' },
    label && el('span', { className: 'field-label', textContent: label }),
    el('div', { className: 'image-field' }, preview, el('div', { className: 'image-controls' }, el('div', { className: 'row' }, upload, remove), urlInput, file)),
    hint && el('p', { className: 'hint', textContent: hint }));
  return { node, get: () => current, set };
}

// Teglar: "Oilaviy zal", "Wi-Fi" ...
export function chipsField({ label, values = [], placeholder = 'Yozing va Enter bosing', max = 20, hint }) {
  let items = [...values];
  const list = el('ul', { className: 'chips-edit' });
  const input = el('input', { placeholder, maxLength: 40 });
  const add = btn('Qo‘shish', () => push(), 'btn-ghost btn-small');
  function render() {
    list.replaceChildren(...items.map((v, i) => el('li', {}, el('span', { textContent: v }),
      el('button', { type: 'button', className: 'chip-x', textContent: '×', ariaLabel: `${v} — o‘chirish`, onclick: () => { items.splice(i, 1); render(); list.dispatchEvent(new Event('input', { bubbles: true })); } }))));
  }
  function push() {
    const v = input.value.trim();
    if (!v || items.includes(v) || items.length >= max) return;
    items.push(v);
    input.value = '';
    render();
    input.focus();
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      push();
    }
  });
  render();
  return {
    node: el('div', { className: 'field' }, el('label', { htmlFor: input.id = nextId(), textContent: label }), list, el('div', { className: 'row' }, input, add), hint && el('p', { className: 'hint', textContent: hint })),
    get: () => items,
  };
}

// Takrorlanuvchi qatorlar: ish vaqti, filiallar, savol-javob, rasmlar...
export function listField({ label, items = [], make, blank, addLabel = 'Qo‘shish', max = 30, itemTitle, hint }) {
  let rows = [];
  const box = el('div', { className: 'list-rows' });
  const addBtn = btn(addLabel, () => {
    addRow(blank());
    rows.at(-1).node.querySelector('input, textarea, select')?.focus();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'btn-ghost btn-small');

  function renumber() {
    rows.forEach((r, i) => {
      r.title.textContent = itemTitle ? itemTitle(i) : `${i + 1}`;
      r.up.disabled = i === 0;
      r.down.disabled = i === rows.length - 1;
    });
    addBtn.hidden = rows.length >= max;
  }
  function move(row, delta) {
    const i = rows.indexOf(row);
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    box.replaceChildren(...rows.map((r) => r.node));
    renumber();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function addRow(item) {
    const inner = make(item);
    const row = { inner };
    row.title = el('span', { className: 'list-row-title' });
    row.up = el('button', { type: 'button', className: 'icon-btn', textContent: '↑', ariaLabel: 'Yuqoriga', onclick: () => move(row, -1) });
    row.down = el('button', { type: 'button', className: 'icon-btn', textContent: '↓', ariaLabel: 'Pastga', onclick: () => move(row, 1) });
    const del = el('button', { type: 'button', className: 'icon-btn danger', textContent: '×', ariaLabel: 'O‘chirish', onclick: () => {
      rows = rows.filter((r) => r !== row);
      row.node.remove();
      renumber();
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } });
    row.node = el('div', { className: 'list-row' }, el('div', { className: 'list-row-head' }, row.title, el('div', { className: 'row' }, row.up, row.down, del)), inner.node);
    rows.push(row);
    box.append(row.node);
    renumber();
  }
  items.forEach(addRow);
  renumber();
  return {
    node: el('div', { className: 'field' }, label && el('span', { className: 'field-label', textContent: label }), hint && el('p', { className: 'hint', textContent: hint }), box, addBtn),
    get: () => rows.map((r) => r.inner.get()),
    add(item) {
      if (rows.length >= max) return false;
      addRow(item);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
  };
}

// Bir nechta maydondan iborat obyekt (masalan, bitta filial)
export function group(fields, className = 'grid-2') {
  return {
    node: el('div', { className }, Object.values(fields).map((f) => f.node)),
    get: () => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.get()])),
    fields,
  };
}

// Pastda yopishib turadigan "Saqlash" paneli; o'zgarish bo'lsa ko'rsatadi
export function saveBar(root, onSave, label = 'Saqlash') {
  const status = el('span', { className: 'save-status', textContent: 'O‘zgarishlar saqlangan' });
  const button = btn(label, async () => {
    await busy(button, 'Saqlanmoqda…', async () => {
      try {
        await onSave();
        setDirty(false);
        toast('Saqlandi. Saytda 1 daqiqa ichida ko‘rinadi.');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
  const node = el('div', { className: 'save-bar' }, status, button);
  function setDirty(d) {
    node.classList.toggle('is-dirty', d);
    status.textContent = d ? 'Saqlanmagan o‘zgarishlar bor' : 'O‘zgarishlar saqlangan';
    window.__adminDirty = d;
  }
  root.addEventListener('input', () => setDirty(true));
  root.addEventListener('change', () => setDirty(true));
  setDirty(false);
  return { node, setDirty };
}

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
