import { $, el, api, formatPrice, applyInfo } from './common.js';
import { mountPinLogin } from './pinlogin.js';
import { setPerms, can, homeFor } from './perms.js';

// Ombor (omborchi): #kirim — kelgan mahsulot (ta'minotchi, miqdor, narx), #qoldiq — kunlik qoldiq (astatka),
// #hisobot — kechagi qoldiq + kelgan − bugungi qoldiq = sarf. Qadoqlar: "3 blok + 2 dona" o'zi donaga aylanadi.

const app = $('#app');
let profile = null;
let siteInfo = {};
let data = { products: [], suppliers: [], today: '' };
const TABS = ['kirim', 'qoldiq', 'hisobot'];
const num = (v) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
const q = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 1000) / 1000).replace('.', ','));
const unitL = (p, u) => (p.units || []).find((x) => x.unit === u)?.label || u;
const base = (p) => p.unitLabel || p.unit;

function gate(e) {
  if (e?.code === 'login' || e?.status === 401) {
    showLogin();
    return true;
  }
  if (e?.status === 403 && e.code === 'perm') {
    alert(e.message);
    return true;
  }
  if (e?.status === 403) {
    app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: 'Ruxsat yo‘q' }), el('p', { textContent: e.message }),
      el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Boshqa hisob bilan kirish', onclick: logout })));
    return true;
  }
  return false;
}
const toast = (text) => {
  const t = el('div', { className: 'k-toast', role: 'status', textContent: `✓ ${text}` });
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
};
async function reloadData() {
  data = await api('/api/ombor/data');
  setPerms(data.perms);
}
const productSelect = (value = '') => {
  const groups = new Map();
  for (const p of data.products) {
    const k = p.category || 'Boshqa';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return el('select', { className: 'om-product', ariaLabel: 'Mahsulot' }, el('option', { value: '', textContent: '— mahsulot —' }),
    ...[...groups].map(([g, list]) => el('optgroup', { label: g }, list.map((p) => el('option', { value: p.id, textContent: p.name, selected: p.id === value })))));
};

/* ───────── mahsulot va ta'minotchi qo'shish (ruxsat bo'lsa) ───────── */
function productDialog(onDone) {
  const dlg = el('dialog', { className: 'pay-dialog' });
  const name = el('input', { placeholder: 'Masalan: Coca-Cola 1 l', maxLength: 60 });
  const unit = el('select', {}, Object.entries(data.units || { kg: 'kg', dona: 'dona' }).map(([k, v]) => el('option', { value: k, textContent: v })));
  const cat = el('input', { placeholder: 'Kategoriya: Ichimlik, Go‘sht…', maxLength: 40 });
  const packUnit = el('select', {}, el('option', { value: '', textContent: '— qadoq yo‘q —' }), Object.entries(data.units || {}).map(([k, v]) => el('option', { value: k, textContent: v })));
  const packSize = el('input', { inputMode: 'decimal', placeholder: 'nechta', className: 'om-num' });
  const err = el('p', { className: 'form-error', hidden: true });
  const ok = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: 'Qo‘shish' });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const r = await api('/api/ombor/products', { method: 'POST', body: JSON.stringify({ name: name.value, unit: unit.value, category: cat.value, packs: packUnit.value ? [{ unit: packUnit.value, size: packSize.value }] : [] }) });
      dlg.close();
      await reloadData();
      onDone?.(r.item);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      ok.disabled = false;
    }
  });
  dlg.append(el('h2', { textContent: 'Yangi mahsulot' }),
    el('label', { className: 'om-field' }, el('span', { textContent: 'Nomi' }), name),
    el('label', { className: 'om-field' }, el('span', { textContent: 'Asosiy o‘lchov (qoldiq shu birlikda)' }), unit),
    el('label', { className: 'om-field' }, el('span', { textContent: 'Kategoriya' }), cat),
    el('div', { className: 'om-field' }, el('span', { textContent: 'Qanday qadoqda keladi (ixtiyoriy)' }),
      el('div', { className: 'ctl-row' }, el('span', { textContent: '1' }), packUnit, el('span', { textContent: '=' }), packSize, el('span', { className: 'muted', textContent: 'asosiy birlik' }))),
    err, el('div', { className: 'row' }, ok, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Bekor', onclick: () => dlg.close() })));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  name.focus();
}

/* ───────── Kirim ───────── */
async function viewIn() {
  const sup = el('select', { id: 'om-sup', ariaLabel: 'Ta’minotchi' }, el('option', { value: '', textContent: '— ta’minotchi —' }), data.suppliers.map((s) => el('option', { value: s.id, textContent: s.name })));
  const addSup = can('stock.suppliers') ? el('button', { type: 'button', className: 'btn btn-small btn-ghost', textContent: '+ Ta’minotchi', onclick: async () => {
    const name = prompt('Ta’minotchi nomi:', '');
    if (!name) return;
    const phone = prompt('Telefoni (ixtiyoriy):', '') || '';
    try {
      const r = await api('/api/ombor/suppliers', { method: 'POST', body: JSON.stringify({ name, phone }) });
      await reloadData();
      viewIn().then(() => { $('#om-sup').value = r.item.id; });
    } catch (e) {
      if (!gate(e)) alert(e.message);
    }
  } }) : '';
  const day = el('input', { type: 'date', value: data.today, max: data.today, ariaLabel: 'Sana' });
  const lines = el('div', { className: 'om-lines' });
  const total = el('strong', { className: 'om-total' });
  const note = el('input', { placeholder: 'Izoh (ixtiyoriy): faktura raqami…', maxLength: 200, className: 'pos-comment' });
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const paintTotal = () => {
    let t = 0;
    for (const row of lines.children) t += Math.round((num(row.qtyEl.value) || 0) * (num(row.priceEl.value) || 0));
    total.textContent = formatPrice(t);
  };
  const addLine = () => {
    const sel = productSelect();
    const qtyEl = el('input', { inputMode: 'decimal', placeholder: 'miqdor', className: 'om-num', ariaLabel: 'Miqdor' });
    const unitEl = el('select', { className: 'om-unit', ariaLabel: 'O‘lchov' });
    const priceEl = el('input', { inputMode: 'numeric', placeholder: 'narxi', className: 'om-num', ariaLabel: 'Narx (1 birlik)' });
    const conv = el('small', { className: 'muted om-conv' });
    const paintConv = () => {
      const p = data.products.find((x) => x.id === sel.value);
      const f = p?.units.find((u) => u.unit === unitEl.value)?.factor || 1;
      conv.textContent = p && f !== 1 && num(qtyEl.value) ? `= ${q(num(qtyEl.value) * f)} ${base(p)}` : '';
      paintTotal();
    };
    sel.addEventListener('change', () => {
      const p = data.products.find((x) => x.id === sel.value);
      unitEl.replaceChildren(...(p ? p.units.map((u) => el('option', { value: u.unit, textContent: u.label })) : []));
      // qadoqli mahsulot — odatda qadoqda keladi
      if (p?.packs?.length) unitEl.value = p.packs[0].unit;
      paintConv();
      qtyEl.focus();
    });
    for (const x of [qtyEl, priceEl]) x.addEventListener('input', paintConv);
    unitEl.addEventListener('change', paintConv);
    const row = el('div', { className: 'om-line' }, sel, el('div', { className: 'om-line-nums' }, qtyEl, unitEl, el('span', { className: 'muted', textContent: '×' }), priceEl,
      el('button', { type: 'button', className: 'line-void', ariaLabel: 'Qatorni olib tashlash', textContent: '×', onclick: () => { row.remove(); paintTotal(); } })), conv);
    Object.assign(row, { sel, qtyEl, unitEl, priceEl });
    lines.append(row);
  };
  addLine();
  addLine();
  const save = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: '✓ Kirimni saqlash' });
  save.addEventListener('click', async () => {
    err.hidden = true;
    const body = {
      supplierId: sup.value, day: day.value, note: note.value,
      lines: [...lines.children].filter((r) => r.sel.value && num(r.qtyEl.value)).map((r) => ({ productId: r.sel.value, qty: r.qtyEl.value, unit: r.unitEl.value, price: r.priceEl.value })),
    };
    if (!body.lines.length) {
      err.textContent = 'Mahsulot va miqdorini yozing.';
      err.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      const r = await api('/api/ombor/in', { method: 'POST', body: JSON.stringify(body) });
      toast(`Kirim saqlandi · ${formatPrice(r.move.total)}`);
      viewIn();
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      save.disabled = false;
    }
  });
  const recent = el('div', { className: 'kassa-tabs' });
  app.replaceChildren(
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Kirim — kelgan mahsulot' }),
      can('stock.products') ? el('button', { type: 'button', className: 'btn btn-small btn-ghost', textContent: '+ Yangi mahsulot', onclick: () => productDialog(() => viewIn()) }) : ''),
    !data.products.length ? el('p', { className: 'notice', textContent: 'Mahsulotlar ro‘yxati bo‘sh. Admin panel → Ombor bo‘limida qo‘shiladi.' }) : '',
    el('section', { className: 'card-lite om-form' },
      el('div', { className: 'ctl-row om-top' }, sup, addSup, day),
      lines,
      el('button', { type: 'button', className: 'btn btn-small btn-ghost', textContent: '+ Yana mahsulot', onclick: addLine }),
      el('div', { className: 'om-sum' }, el('span', { textContent: 'Jami' }), total),
      note, err, save),
    el('h2', { className: 'list-head', textContent: 'Oxirgi kirimlar (7 kun)' }), recent);
  paintTotal();
  try {
    const { items } = await api('/api/ombor/moves?days=7');
    recent.replaceChildren(...(items.length ? items.map((m) => el('details', { className: 'om-move' },
      el('summary', {}, el('span', { className: 'tab-card-table', textContent: m.supplierName || 'Ta’minotchisiz' }),
        el('span', { className: 'muted small', textContent: ` ${m.day} · ${new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${m.byName}` }),
        el('strong', { className: 'om-move-sum', textContent: formatPrice(m.total) })),
      el('ul', { className: 'order-lines' }, m.lines.map((l) => el('li', {}, el('span', { textContent: `${q(l.inQty ?? l.qty)} ${l.inUnitLabel || l.unit} · ${l.name}${l.inUnit && l.inUnit !== l.unit ? ` (= ${q(l.qty)} ${l.unit})` : ''}` }), el('span', { textContent: formatPrice(l.sum) })))),
      m.note ? el('p', { className: 'muted small', textContent: m.note }) : '',
      m.day === data.today && can('stock.receive') ? el('button', { type: 'button', className: 'btn-link danger', textContent: 'O‘chirish (xato yozilgan)', onclick: async () => {
        if (!confirm('Bu kirim o‘chirilsinmi?')) return;
        try {
          await api(`/api/ombor/moves/${m.id}`, { method: 'DELETE' });
          viewIn();
        } catch (e) {
          if (!gate(e)) alert(e.message);
        }
      } }) : '')) : [el('p', { className: 'empty-line', textContent: 'Hali kirim yo‘q.' })]));
  } catch (e) {
    if (!gate(e)) recent.replaceChildren(el('p', { className: 'muted', textContent: e.message }));
  }
}

/* ───────── Kunlik qoldiq ───────── */
async function viewCount(dayArg = data.today) {
  app.replaceChildren(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  let rep;
  try {
    ({ report: rep } = await api(`/api/ombor/report?day=${encodeURIComponent(dayArg)}`));
  } catch (e) {
    if (gate(e)) return;
    return app.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
  }
  const day = el('input', { type: 'date', value: rep.day, max: data.today, ariaLabel: 'Sana', onchange: (e) => viewCount(e.target.value) });
  const rows = [];
  const byCat = new Map();
  for (const r of rep.rows) {
    const p = data.products.find((x) => x.id === r.id) || { ...r, packs: [], units: r.units || [] };
    const packs = p.packs || [];
    const inputs = [...packs.map((pk) => ({ unit: pk.unit, label: (data.units || {})[pk.unit] || pk.unit, size: pk.size })), { unit: r.unit, label: r.unitLabel, size: 1 }];
    const fields = inputs.map((x) => el('input', { inputMode: 'decimal', className: 'om-num', placeholder: x.label, ariaLabel: `${r.name} — ${x.label}` }));
    // saqlangan qoldiq — asosiy birlik maydoniga
    if (r.close !== null) fields[fields.length - 1].value = q(r.close);
    const sum = el('small', { className: 'muted om-conv' });
    const paint = () => {
      const any = fields.some((f) => f.value.trim() !== '');
      const t = inputs.reduce((s, x, i) => s + (num(fields[i].value) || 0) * x.size, 0);
      sum.textContent = any && packs.length ? `= ${q(t)} ${r.unitLabel}` : '';
    };
    fields.forEach((f) => f.addEventListener('input', paint));
    paint();
    rows.push({ r, inputs, fields });
    const line = el('div', { className: `om-count${r.low ? ' is-low' : ''}` },
      el('div', { className: 'om-count-name' }, el('strong', { textContent: r.name }),
        el('small', { className: 'muted', textContent: `kecha ${q(r.open)} · keldi ${q(r.in)}${r.expected !== null ? ` · bo‘lishi kerak ~${q(r.expected)}` : ''} ${r.unitLabel}` })),
      el('div', { className: 'om-count-in' }, ...fields.flatMap((f, i) => [f, el('span', { className: 'muted small', textContent: inputs[i].label })]), sum));
    const k = r.category || 'Boshqa';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(line);
  }
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const save = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: '✓ Qoldiqni saqlash' });
  save.addEventListener('click', async () => {
    const lines = {};
    for (const { r, inputs, fields } of rows) {
      if (!fields.some((f) => f.value.trim() !== '')) continue;
      lines[r.id] = inputs.map((x, i) => ({ qty: fields[i].value.trim(), unit: x.unit })).filter((x) => x.qty !== '');
    }
    if (!Object.keys(lines).length) {
      err.textContent = 'Kamida bitta mahsulot qoldig‘ini yozing.';
      err.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      await api('/api/ombor/count', { method: 'POST', body: JSON.stringify({ day: rep.day, lines }) });
      toast('Qoldiq saqlandi');
      location.hash = 'hisobot';
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      save.disabled = false;
    }
  });
  app.replaceChildren(
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Kunlik qoldiq (astatka)' }), day),
    el('p', { className: 'muted', textContent: rep.counted ? `Saqlangan: ${rep.countedByName} · ${new Date(rep.countedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}. O‘zgartirib qayta saqlash mumkin.` : 'Omborda qolgan mahsulotni sanab yozing. Qadoqda bo‘lsa — qadoq va donani alohida yozing, jami o‘zi hisoblanadi.' }),
    ...(rows.length ? [...byCat].map(([cat, list]) => el('section', { className: 'card-lite' }, el('h3', { textContent: cat }), ...list)) : [el('p', { className: 'notice', textContent: 'Mahsulotlar ro‘yxati bo‘sh.' })]),
    err, can('stock.count') ? save : '');
}

/* ───────── Hisobot ───────── */
async function viewReport(dayArg = data.today) {
  app.replaceChildren(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  let rep;
  try {
    ({ report: rep } = await api(`/api/ombor/report?day=${encodeURIComponent(dayArg)}`));
  } catch (e) {
    if (gate(e)) return;
    return app.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
  }
  const day = el('input', { type: 'date', value: rep.day, max: data.today, ariaLabel: 'Sana', onchange: (e) => viewReport(e.target.value) });
  const th = (t, cls = '') => el('th', { className: cls, textContent: t });
  const td = (t, cls = '') => el('td', { className: cls, textContent: t });
  app.replaceChildren(
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Ombor hisoboti' }), day),
    el('p', { className: 'muted', textContent: `${rep.prevDay ? `Kechagi qoldiq: ${rep.prevDay}` : 'Oldingi qoldiq yozilmagan'} · ${rep.counted ? `bugungi qoldiq yozilgan (${rep.countedByName})` : 'bugungi qoldiq hali yozilmagan'} · kirim: ${formatPrice(rep.totalIn)}` }),
    el('div', { className: 'om-table-wrap' }, el('table', { className: 'om-table' },
      el('thead', {}, el('tr', {}, th('Mahsulot'), th('Kecha', 'num'), th('Keldi', 'num'), th('Sarf', 'num'), th('Bugun', 'num'))),
      el('tbody', {}, rep.rows.map((r) => el('tr', { className: r.low ? 'is-low' : '' },
        td(`${r.name} (${r.unitLabel})`), td(q(r.open), 'num'), td(r.in ? `+${q(r.in)}` : '—', 'num'), td(q(r.used), `num${r.used !== null && r.used < 0 ? ' is-bad' : ''}`), td(`${q(r.close)}${r.low ? ' ⚠' : ''}`, 'num')))))),
    rep.suppliers.length ? el('section', { className: 'card-lite' }, el('h3', { textContent: 'Ta’minotchilar' }),
      el('dl', { className: 'k-pay-rows' }, rep.suppliers.map((s) => el('div', {}, el('dt', { textContent: `${s.name} · ${s.count} ta kirim` }), el('dd', { textContent: formatPrice(s.total) }))))) : '',
    el('p', { className: 'muted small', textContent: 'Sarf = kechagi qoldiq + kelgan − bugungi qoldiq. ⚠ — admin belgilagan eng kam miqdordan kam qolgan.' }));
}

/* ───────── yo'naltirish va kirish ───────── */
function route() {
  const h = location.hash.slice(1);
  const tab = TABS.includes(h) ? h : 'kirim';
  const nav = $('#kassa-tabs');
  nav.hidden = false;
  const allowed = { kirim: can('stock.receive'), qoldiq: can('stock.count'), hisobot: can('stock.count') || can('stock.reports') };
  for (const a of nav.querySelectorAll('a')) {
    a.hidden = allowed[a.dataset.tab] === false;
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (tab === 'qoldiq' && allowed.qoldiq) return viewCount();
  if (tab === 'hisobot' && allowed.hisobot) return viewReport();
  if (allowed.kirim) return viewIn();
  return viewReport();
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  profile = null;
  $('#kassa-tabs').hidden = true;
  $('#staff-name').textContent = '';
  showLogin();
}

async function start() {
  setPerms(profile.perms);
  const other = homeFor('page.ombor');
  if (other) return location.replace(other);
  if (!can('page.ombor')) return gate({ status: 403, message: 'Sizga ombor sahifasi ochilmagan.' });
  $('#staff-name').textContent = profile.name || '';
  if (!$('.logout-mini')) $('.app-header').append(el('button', { type: 'button', className: 'logout-mini', textContent: 'Chiqish', onclick: logout }));
  try {
    await reloadData();
  } catch (e) {
    if (gate(e)) return;
  }
  route();
}

function showLogin() {
  $('#kassa-tabs').hidden = true;
  mountPinLogin(app, { title: 'Ombor', logo: siteInfo.logo || '/logo.jpg', name: siteInfo.name || 'Oqtosh Restoran', onSuccess(p) { profile = p; start(); } });
}

window.addEventListener('hashchange', () => profile && can('page.ombor') && route());

try {
  const [info, me] = await Promise.all([api('/api/info'), api('/api/me')]);
  siteInfo = info;
  applyInfo({ ...info, name: undefined });
  profile = me.profile;
  if (profile) start();
  else showLogin();
} catch {
  app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: 'Sahifani yuklab bo‘lmadi' }), el('p', { textContent: 'Internetni tekshiring va yangilang.' })));
}
