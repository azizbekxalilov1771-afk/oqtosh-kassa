// Owner hisoboti — savdo, mijozlar (CRM), smenalar, chegirma/olib tashlash/bekor, ombor kirimi.
// Faqat ko'rish. Ikki joyda ishlatiladi: /owner/ sahifasi va admin panelning bosh sahifasi.
//   mountOwnerReport(container, { onAuth(e) })
import { api } from './auth.js';

const $ = (s, r = document) => r.querySelector(s);
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') n.className = v;
    else if (k === 'textContent') n.textContent = v;
    else if (k === 'style' && typeof v === 'string') n.setAttribute('style', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k === 'htmlFor' ? 'for' : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false && c !== '') n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of kids) n.append(c);
  return n;
};

const money = (n) => `${String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;
const plain = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const qtyFmt = (n) => (Number.isInteger(n) ? plain(n) : String(Math.round(n * 10) / 10).replace('.', ','));
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${String(Math.round(n / 1e8) / 10).replace('.', ',')} mlrd`;
  if (a >= 1e6) return `${String(Math.round(n / 1e5) / 10).replace('.', ',')} mln`;
  if (a >= 1e3) return `${Math.round(n / 1e3)} ming`;
  return String(Math.round(n));
}
const dayLabel = (d) => {
  const [, m, day] = d.split('-');
  return `${Number(day)}.${m}`;
};
const WD = ['Yak', 'Du', 'Se', 'Cho', 'Pa', 'Ju', 'Sha'];
const weekday = (d) => WD[new Date(`${d}T12:00:00Z`).getUTCDay()];

function toast(text, kind = 'ok') {
  let t = $('#toast');
  if (!t) document.body.append((t = el('div', { id: 'toast', className: 'toast', role: 'status' })));
  t.textContent = text;
  t.className = `toast is-shown${kind === 'error' ? ' is-error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 4000);
}

/* ───────── davr va manba ───────── */
const tz = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const PRESETS = [
  ['today', 'Bugun', () => [tz(), tz()]],
  ['yesterday', 'Kecha', () => [shift(tz(), -1), shift(tz(), -1)]],
  ['7', '7 kun', () => [shift(tz(), -6), tz()]],
  ['30', '30 kun', () => [shift(tz(), -29), tz()]],
  ['month', 'Bu oy', () => [`${tz().slice(0, 8)}01`, tz()]],
  ['lastmonth', 'O‘tgan oy', () => {
    const first = `${tz().slice(0, 8)}01`;
    const end = shift(first, -1);
    return [`${end.slice(0, 8)}01`, end];
  }],
];
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('oq_owner') || '{}');
  } catch {
    return {};
  }
})();
const state = { preset: saved.preset || '7', source: saved.source || '', from: '', to: '', data: null, sort: 'sum', productQuery: '', showAll: false };
const remember = () => {
  try {
    localStorage.setItem('oq_owner', JSON.stringify({ preset: state.preset, source: state.source }));
  } catch {}
};

/* ───────── grafiklar ───────── */
const tip = el('div', { className: 'ow-tip', role: 'tooltip', hidden: true });
document.body.append(tip);
function showTip(e, lines) {
  tip.replaceChildren(...lines.map((l, i) => el(i === 0 ? 'strong' : 'span', { textContent: l })));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2));
  const y = e.clientY - r.height - 14 < 8 ? e.clientY + 18 : e.clientY - r.height - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => (tip.hidden = true);

// Ustunli grafik: bitta qator ma'lumot (bitta rang), eng katta qiymat ustida yozuv, har ustunda hover
function columns(rows, { value = 'revenue', label, tipLines, height = 220, highlight } = {}) {
  const box = el('div', { className: 'ow-chart' });
  const draw = () => {
    const W = Math.max(280, box.clientWidth || 640);
    const H = height;
    const padL = 54;
    const padB = 26;
    const padT = 22;
    const max = Math.max(1, ...rows.map((r) => r[value]));
    const nice = (() => {
      const p = 10 ** Math.floor(Math.log10(max));
      return Math.ceil(max / p / (max / p > 5 ? 2 : 1)) * p * (max / p > 5 ? 2 : 1);
    })();
    const plotW = W - padL - 6;
    const plotH = H - padT - padB;
    const slot = plotW / rows.length;
    const bw = Math.max(3, Math.min(24, slot * 0.62));
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
    for (let i = 0; i <= 3; i++) {
      const v = (nice / 3) * i;
      const y = padT + plotH - (v / nice) * plotH;
      s.append(svg('line', { x1: padL, x2: W - 6, y1: y, y2: y, class: 'ow-grid' }));
      s.append(svg('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', class: 'ow-axis' }, document.createTextNode(compact(v))));
    }
    const step = Math.ceil(rows.length / Math.floor(plotW / 44));
    const maxIdx = rows.reduce((bi, r, i) => (r[value] > rows[bi][value] ? i : bi), 0);
    rows.forEach((r, i) => {
      const h = (r[value] / nice) * plotH;
      const x = padL + slot * i + (slot - bw) / 2;
      const y = padT + plotH - h;
      const g = svg('g', { class: `ow-col${highlight?.(r) ? ' is-hi' : ''}`, tabindex: '0' });
      g.append(svg('rect', { x: padL + slot * i, y: padT, width: slot, height: plotH, class: 'ow-hit' }));
      if (h > 0) {
        const rr = Math.min(4, bw / 2, h);
        g.append(svg('path', { d: `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + bw - rr},${y} Q${x + bw},${y} ${x + bw},${y + rr} L${x + bw},${y + h} Z`, class: 'ow-bar' }));
      }
      const t = tipLines(r);
      g.append(svg('title', {}, document.createTextNode(t.join(' · '))));
      g.addEventListener('pointermove', (e) => showTip(e, t));
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', (e) => {
        const b = e.currentTarget.getBoundingClientRect();
        showTip({ clientX: b.left + b.width / 2, clientY: b.top + 30 }, t);
      });
      g.addEventListener('blur', hideTip);
      s.append(g);
      if (i % step === 0 || i === rows.length - 1) s.append(svg('text', { x: padL + slot * i + slot / 2, y: H - 8, 'text-anchor': 'middle', class: 'ow-axis' }, document.createTextNode(label(r))));
      if (i === maxIdx && r[value] > 0) s.append(svg('text', { x: x + bw / 2, y: Math.max(12, y - 6), 'text-anchor': 'middle', class: 'ow-val' }, document.createTextNode(compact(r[value]))));
    });
    box.replaceChildren(s);
  };
  requestAnimationFrame(draw);
  new ResizeObserver(() => draw()).observe(box);
  return box;
}

// Gorizontal chiziqlar (kategoriya, to'lov turi, kanal...): nom — chiziq — qiymat
function hbars(rows, { value, name = (r) => r.name, sub = () => '', fmt = money } = {}) {
  const max = Math.max(1, ...rows.map((r) => r[value]));
  const total = rows.reduce((s, r) => s + r[value], 0) || 1;
  return el('ul', { className: 'ow-hbars' }, rows.map((r) => el('li', {},
    el('div', { className: 'ow-hb-top' }, el('span', { className: 'ow-hb-name', textContent: name(r) }), el('strong', { textContent: fmt(r[value]) })),
    el('div', { className: 'ow-hb-track' }, el('div', { className: 'ow-hb-fill', style: `width:${Math.max(1.5, (r[value] / max) * 100)}%` })),
    el('div', { className: 'ow-hb-sub muted small', textContent: [`${Math.round((r[value] / total) * 1000) / 10}%`.replace('.', ','), sub(r)].filter(Boolean).join(' · ') }))));
}

const delta = (cur, prev, { goodUp = true } = {}) => {
  if (!prev) return el('span', { className: 'ow-delta muted', textContent: 'oldingi davrda yo‘q' });
  const d = ((cur - prev) / prev) * 100;
  if (Math.abs(d) < 0.5) return el('span', { className: 'ow-delta muted', textContent: '≈ oldingi davr bilan teng' });
  const up = d > 0;
  return el('span', { className: `ow-delta ${up === goodUp ? 'is-good' : 'is-bad'}`, textContent: `${up ? '▲' : '▼'} ${String(Math.round(Math.abs(d) * 10) / 10).replace('.', ',')}% oldingi davrga nisbatan` });
};

function csv(name, header, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = `﻿${[header, ...rows].map((r) => r.map(esc).join(';')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

/* ───────── sahifa ───────── */
let container = null;
const hooks = {};
const root = () => container;

function filters() {
  const presets = el('div', { className: 'ow-chips', role: 'group', ariaLabel: 'Davr' }, PRESETS.map(([k, label]) => el('button', {
    type: 'button', className: `ow-chip${state.preset === k ? ' is-on' : ''}`, ariaPressed: String(state.preset === k), textContent: label,
    onclick: () => { state.preset = k; remember(); load(); },
  })));
  const from = el('input', { type: 'date', value: state.from, max: tz(), ariaLabel: 'Boshlanish' });
  const to = el('input', { type: 'date', value: state.to, max: tz(), ariaLabel: 'Tugash' });
  const apply = () => {
    if (!from.value || !to.value) return;
    state.preset = 'custom';
    state.from = from.value;
    state.to = to.value;
    load();
  };
  from.addEventListener('change', apply);
  to.addEventListener('change', apply);
  const d = state.data;
  const src = d?.sources?.mison ? el('div', { className: 'ow-seg', role: 'group', ariaLabel: 'Manba' },
    [['mison', 'Butun restoran (Mison)'], ['site', 'Sayt orqali']].map(([k, label]) => el('button', {
      type: 'button', className: `ow-seg-btn${(state.source || d.source) === k ? ' is-on' : ''}`, ariaPressed: String((state.source || d.source) === k), textContent: label,
      onclick: () => { state.source = k; remember(); load(); },
    }))) : '';
  return el('div', { className: 'ow-filters' }, presets, el('div', { className: 'ow-range' }, from, el('span', { className: 'muted', textContent: '—' }), to), src,
    el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Yangilash', onclick: () => load() }));
}

function tiles(d) {
  const t = d.totals;
  const p = d.prevTotals;
  const mison = d.source === 'mison';
  const tile = (label, value, cur, prev, hint) => el('div', { className: 'ow-tile' },
    el('span', { className: 'ow-tile-label', textContent: label }),
    el('strong', { className: 'ow-tile-value', textContent: value }),
    cur !== undefined ? delta(cur, prev) : '', hint ? el('span', { className: 'muted small', textContent: hint }) : '');
  return el('section', { className: 'ow-tiles' },
    tile('Tushum', money(t.revenue), t.revenue, p.revenue),
    tile('Cheklar', plain(t.cheques), t.cheques, p.cheques),
    tile('O‘rtacha chek', money(t.avg), t.avg, p.avg),
    mison ? tile('Mehmonlar', plain(t.guests), t.guests, p.guests) : tile('Mijozlar (sayt)', plain(t.customers), t.customers, p.customers),
    tile('Kunlik o‘rtacha', money(t.perDay), t.perDay, p.perDay),
    tile('Xizmat haqi', money(t.service), undefined, undefined, mison ? (t.returns ? `qaytarishlar: ${money(t.returns)}` : '') : (t.cancelled ? `bekor qilingan: ${t.cancelled} ta · ${money(t.cancelledSum)}` : '')));
}

function card(title, sub, ...children) {
  return el('section', { className: 'ow-card' }, el('div', { className: 'ow-card-head' }, el('h2', { textContent: title }), sub ? el('p', { className: 'muted small', textContent: sub }) : ''), ...children);
}

function productsCard(d) {
  const body = el('div');
  const paint = () => {
    const q = state.productQuery.trim().toLowerCase();
    const list = [...d.products].sort((a, b) => b[state.sort] - a[state.sort]).filter((x) => !q || x.name.toLowerCase().includes(q));
    const total = d.products.reduce((s, x) => s + x.sum, 0) || 1;
    const maxV = Math.max(1, ...list.map((x) => x[state.sort]));
    const shown = state.showAll ? list : list.slice(0, 15);
    const hasProfit = d.products.some((x) => x.profit);
    body.replaceChildren(
      list.length ? el('div', { className: 'ow-table-wrap' }, el('table', { className: 'ow-table' },
        el('thead', {}, el('tr', {}, el('th', { textContent: '#' }), el('th', { textContent: 'Taom' }), el('th', { className: 'num', textContent: 'Soni' }), el('th', { className: 'num', textContent: 'Summa' }), hasProfit ? el('th', { className: 'num', textContent: 'Foyda' }) : '', el('th', { className: 'share', textContent: 'Ulushi' }))),
        el('tbody', {}, shown.map((x, i) => el('tr', {},
          el('td', { className: 'muted', textContent: String(i + 1) }),
          el('td', {}, el('span', { className: 'ow-pname', textContent: x.name }), x.category ? el('span', { className: 'muted small', textContent: x.category }) : ''),
          el('td', { className: 'num', textContent: qtyFmt(x.qty) }),
          el('td', { className: 'num', textContent: plain(x.sum) }),
          hasProfit ? el('td', { className: 'num', textContent: plain(x.profit) }) : '',
          el('td', { className: 'share' }, el('div', { className: 'ow-share' }, el('div', { className: 'ow-mini' }, el('div', { className: 'ow-mini-fill', style: `width:${Math.max(1.5, (x[state.sort] / maxV) * 100)}%` })),
            el('span', { className: 'muted small', textContent: `${String(Math.round((x.sum / total) * 1000) / 10).replace('.', ',')}%` })))))))) : el('p', { className: 'muted', textContent: 'Bu davrda sotuv yo‘q.' }),
      list.length > 15 ? el('button', { type: 'button', className: 'btn btn-text btn-small', textContent: state.showAll ? 'Kamroq ko‘rsatish' : `Hammasi (${list.length})`, onclick: () => { state.showAll = !state.showAll; paint(); } }) : '');
  };
  const search = el('input', { type: 'search', placeholder: 'Taom qidirish…', className: 'ow-search', value: state.productQuery, ariaLabel: 'Taom qidirish' });
  search.addEventListener('input', () => { state.productQuery = search.value; paint(); });
  const sortBtns = el('div', { className: 'ow-seg small' }, [['sum', 'Summa'], ['qty', 'Soni']].map(([k, label]) => el('button', {
    type: 'button', className: `ow-seg-btn${state.sort === k ? ' is-on' : ''}`, textContent: label,
    onclick: (e) => { state.sort = k; for (const b of e.currentTarget.parentNode.children) b.classList.toggle('is-on', b === e.currentTarget); paint(); },
  })));
  paint();
  return card('Eng ko‘p sotilgan taomlar', 'Qaysi taom ko‘p ketyapti va qancha pul keltiryapti',
    el('div', { className: 'ow-tools' }, search, sortBtns, el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: '⬇ CSV', onclick: () => csv(`taomlar-${d.range.from}_${d.range.to}.csv`, ['Taom', 'Kategoriya', 'Soni', 'Summa', 'Foyda'], d.products.map((x) => [x.name, x.category || '', x.qty, x.sum, x.profit ?? ''])) })),
    body,
    d.unsold?.length ? el('details', { className: 'ow-unsold' }, el('summary', { textContent: `Bu davrda umuman sotilmagan taomlar — ${d.unsold.length} ta` }),
      el('p', { className: 'muted small', textContent: 'Menyudan olib tashlash yoki narxini, rasmini ko‘rib chiqish mumkin.' }),
      el('div', { className: 'ow-tags' }, d.unsold.map((x) => el('span', { className: 'ow-tag', textContent: x.name })))) : '');
}

function customersCard(d) {
  const c = d.customers || { top: [] };
  const stats = el('div', { className: 'ow-mini-stats' },
    el('div', {}, el('strong', { textContent: plain(c.count) }), el('span', { className: 'muted small', textContent: 'mijoz' })),
    c.returning !== null && c.returning !== undefined ? el('div', {}, el('strong', { textContent: plain(c.returning) }), el('span', { className: 'muted small', textContent: 'qaytib kelgan' })) : '',
    c.fresh !== null && c.fresh !== undefined ? el('div', {}, el('strong', { textContent: plain(c.fresh) }), el('span', { className: 'muted small', textContent: 'yangi' })) : '');
  return card('Mijozlar', d.source === 'mison' ? 'Mison kassasida telefon raqami kiritilgan mijozlar' : 'Sayt orqali (Telegram bilan kirgan) mijozlar',
    stats,
    c.top.length ? el('div', { className: 'ow-table-wrap' }, el('table', { className: 'ow-table' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Mijoz' }), el('th', { textContent: 'Telefon' }), el('th', { className: 'num', textContent: 'Buyurtma' }), el('th', { className: 'num', textContent: 'Summa' }), el('th', { textContent: 'Oxirgi' }))),
      el('tbody', {}, c.top.slice(0, 25).map((x) => el('tr', {},
        el('td', { textContent: x.name || '—' }),
        el('td', {}, x.phone ? el('a', { href: `tel:${x.phone.replace(/[^\d+]/g, '')}`, textContent: x.phone }) : '—'),
        el('td', { className: 'num', textContent: plain(x.orders) }),
        el('td', { className: 'num', textContent: plain(x.revenue) }),
        el('td', { className: 'muted small', textContent: x.last ? new Date(x.last).toLocaleDateString('ru-RU') : '—' })))))) : el('p', { className: 'muted', textContent: 'Bu davrda mijoz ma’lumoti yo‘q.' }),
    c.top.length ? el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: '⬇ Mijozlar CSV', onclick: () => csv(`mijozlar-${d.range.from}_${d.range.to}.csv`, ['Ism', 'Telefon', 'Buyurtmalar', 'Summa', 'Oxirgi'], c.top.map((x) => [x.name, x.phone, x.orders, x.revenue, x.last ? x.last.slice(0, 10) : ''])) }) : '');
}

function waitersCard(d) {
  if (!d.waiters?.length) return '';
  return card('Ofitsiantlar', 'Kim qancha savdo qildi',
    el('div', { className: 'ow-table-wrap' }, el('table', { className: 'ow-table' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Ofitsiant' }), el('th', { className: 'num', textContent: 'Cheklar' }), el('th', { className: 'num', textContent: 'Savdo' }), el('th', { className: 'num', textContent: 'O‘rtacha chek' }))),
      el('tbody', {}, d.waiters.map((w) => el('tr', {}, el('td', { textContent: w.name }), el('td', { className: 'num', textContent: plain(w.cheques) }), el('td', { className: 'num', textContent: plain(w.revenue) }), el('td', { className: 'num', textContent: plain(w.avg) })))))));
}

function render() {
  const d = state.data;
  const r = root();
  const single = d.range.from === d.range.to;
  const busiest = [...d.byHour].sort((a, b) => b.revenue - a.revenue)[0];
  const hours = d.byHour.filter((h, i, all) => {
    const first = all.findIndex((x) => x.cheques > 0);
    const last = all.length - 1 - [...all].reverse().findIndex((x) => x.cheques > 0);
    return first === -1 ? i >= 8 : i >= Math.min(first, 9) && i <= Math.max(last, 22);
  });
  const fresh = d.freshness?.[0]?.lastSync;
  r.replaceChildren(
    el('div', { className: 'ow-head' },
      el('h1', { textContent: 'Savdo hisobotlari' }),
      el('p', { className: 'muted', textContent: `${d.range.from === d.range.to ? d.range.from : `${d.range.from} — ${d.range.to}`} · ${d.source === 'mison' ? 'butun restoran (Mison kassasi)' : 'sayt orqali o‘tgan buyurtmalar'}${fresh ? ` · kassa ma’lumoti: ${fresh}` : ''}` })),
    filters(),
    d.note ? el('p', { className: 'notice warn', textContent: d.note }) : '',
    tiles(d),
    aiBox,
    el('div', { className: 'ow-grid2' },
      single ? '' : card('Tushum kunlar bo‘yicha', `${d.range.days} kun · eng yaxshi kun: ${(() => { const b = [...d.byDay].sort((a, x) => x.revenue - a.revenue)[0]; return b && b.revenue ? `${dayLabel(b.key)} (${money(b.revenue)})` : '—'; })()}`,
        columns(d.byDay, { label: (x) => dayLabel(x.key), tipLines: (x) => [money(x.revenue), `${weekday(x.key)}, ${dayLabel(x.key)}`, `${plain(x.cheques)} ta chek`], highlight: (x) => x.key === tz() })),
      card('Soatlar bo‘yicha', busiest?.revenue ? `eng gavjum vaqt: ${busiest.label}–${String(busiest.key + 1).padStart(2, '0')}:00` : 'savdo yo‘q',
        columns(hours, { label: (x) => String(x.key).padStart(2, '0'), tipLines: (x) => [money(x.revenue), `${x.label}–${String(x.key + 1).padStart(2, '0')}:00`, `${plain(x.cheques)} ta chek`] })),
      d.range.days >= 7 ? card('Hafta kunlari', 'o‘rtacha kunlik tushum',
        columns(d.byWeekday, { value: 'avgRevenue', height: 200, label: (x) => x.label.slice(0, 3), tipLines: (x) => [money(x.avgRevenue), `${x.label} (o‘rtacha)`, `${x.n} kun`] })) : ''),
    productsCard(d),
    el('div', { className: 'ow-grid3' },
      d.categories?.length ? card('Kategoriyalar', '', hbars(d.categories, { value: 'sum', sub: (x) => `${qtyFmt(x.qty)} dona` })) : '',
      d.payments?.length ? card('To‘lov turlari', '', hbars(d.payments, { value: 'amount', sub: (x) => `${plain(x.count)} ta chek` })) : card('To‘lov turlari', '', el('p', { className: 'muted small', textContent: 'Kassada yopilgan hisoblar bo‘yicha — bu davrda yo‘q.' })),
      d.types?.length ? card('Buyurtma turlari', '', hbars(d.types, { value: 'revenue', sub: (x) => `${plain(x.cheques)} ta chek` })) : '',
      d.channels?.length ? card('Qayerdan keldi', 'sayt buyurtmalari', hbars(d.channels, { value: 'revenue', sub: (x) => `${plain(x.cheques)} ta buyurtma` })) : ''),
    el('div', { className: 'ow-grid2' }, waitersCard(d), customersCard(d)),
    extrasBox,
    el('p', { className: 'muted small ow-foot', textContent: `Yangilangan: ${new Date(d.generatedAt).toLocaleString('ru-RU')}` }));
  loadExtras(d.range);
  loadInsights(d);
}

/* ───────── AI tahlil: eng yaxshi taomlar va xodimlar ─────────
   Raqamlar serverda hisoblanadi; AI faqat xulosa yozadi, uning matnidagi raqamlar tekshiriladi. */
const aiBox = el('section', { className: 'ow-ai' });
async function loadInsights(d, fresh = false) {
  aiBox.classList.add('is-loading');
  if (!aiBox.firstChild) aiBox.replaceChildren(el('p', { className: 'muted small', textContent: 'AI tahlil tayyorlanmoqda…' }));
  let x;
  try {
    x = await api(`/owner/insights?${new URLSearchParams({ from: d.range.from, to: d.range.to, ...(state.source ? { source: state.source } : {}), ...(fresh ? { fresh: '1' } : {}) })}`);
  } catch (e) {
    aiBox.classList.remove('is-loading');
    return aiBox.replaceChildren(el('p', { className: 'muted small', textContent: `AI tahlil: ${e.message}` }));
  }
  aiBox.classList.remove('is-loading');
  const f = x.facts;
  const rank = (list, main, sub) => (list.length ? el('ol', { className: 'ow-ai-rank' }, list.map((it, i) => el('li', {},
    el('span', { className: 'ow-ai-n', textContent: i + 1 }),
    el('span', { className: 'ow-ai-name' }, el('b', { textContent: it.name }), el('small', { textContent: sub(it) })),
    el('strong', { textContent: main(it) })))) : el('p', { className: 'muted small', textContent: 'Bu davrda ma’lumot yo‘q.' }));
  const again = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: '↻ Qayta tahlil', onclick: () => { again.disabled = true; loadInsights(d, true); } });
  aiBox.replaceChildren(
    el('div', { className: 'ow-ai-head' },
      el('div', {}, el('h2', { textContent: x.ai ? '✦ AI tahlil' : '✦ Tahlil' }),
        el('p', { className: 'muted small', textContent: x.ai ? 'Raqamlar hisobotdan olingan va tekshirilgan; xulosalarni AI yozdi.' : x.aiAvailable ? (x.aiNote || 'AI hozir javob bermadi — xulosalar hisobotdan.') : 'AI ulanmagan (Kalitlar → Groq) — xulosalar hisobotdan.' })),
      again),
    el('ul', { className: 'ow-ai-lines' }, x.lines.map((l) => el('li', { textContent: l }))),
    el('div', { className: 'ow-ai-grid' },
      el('div', { className: 'ow-ai-col' }, el('h3', { textContent: 'Eng yaxshi taomlar' }),
        rank(f.topProducts, (it) => money(it.sum), (it) => `${qtyFmt(it.qty)} dona · tushumning ${it.share}%`)),
      el('div', { className: 'ow-ai-col' }, el('h3', { textContent: 'Eng yaxshi xodimlar' }),
        rank(f.topStaff, (it) => money(it.revenue), (it) => `${plain(it.cheques)} ta chek · o‘rtacha ${money(it.avg)}`))),
    f.weakProducts.length || f.unsold.length ? el('p', { className: 'muted small ow-ai-weak' },
      el('b', { textContent: 'E’tibor bering: ' }),
      [f.weakProducts.length ? `kam sotilgan — ${f.weakProducts.map((w) => w.name).join(', ')}` : '', f.unsold.length ? `umuman sotilmagan — ${f.unsold.join(', ')}` : ''].filter(Boolean).join('; ')) : '');
}

/* ───────── kassa va ombor tafsilotlari ───────── */
const extrasBox = el('div', { className: 'ow-extras' });
const dtm = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function listTable(head, rows) {
  return el('div', { className: 'ow-table-wrap' }, el('table', { className: 'ow-table' },
    el('thead', {}, el('tr', {}, head.map(([t, cls]) => el('th', { className: cls || '', textContent: t })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map(([t, cls]) => el('td', { className: cls || '', textContent: t })))))));
}
async function loadExtras(range) {
  extrasBox.replaceChildren(el('p', { className: 'muted small', textContent: 'Smenalar va ombor yuklanmoqda…' }));
  let x;
  try {
    x = await api(`/owner/extra?${new URLSearchParams({ from: range.from, to: range.to })}`);
  } catch (e) {
    return extrasBox.replaceChildren(el('p', { className: 'muted small', textContent: `Smena va ombor ma’lumoti: ${e.message}` }));
  }
  const shifts = x.shifts.length ? card('Smenalar (kassa)', 'Kim ochdi, kim yopdi, kassada qancha bo‘lishi kerak edi va qancha sanaldi',
    listTable([['#'], ['Ochildi'], ['Yopildi'], ['Savdo', 'num'], ['Kiritildi / olindi', 'num'], ['Kutilgan naqd', 'num'], ['Sanaldi', 'num'], ['Farq', 'num']],
      x.shifts.map((s) => [[String(s.number)], [`${dtm(s.openedAt)} · ${s.openedByName}`], [s.status === 'closed' ? `${dtm(s.closedAt)} · ${s.closedByName}` : 'ochiq'], [s.revenue === null ? '—' : plain(s.revenue), 'num'],
        [`+${plain(s.cashIn)} / −${plain(s.cashOut)}`, 'num'], [s.expectedCash === null ? '—' : plain(s.expectedCash), 'num'], [s.countedCash === null ? '—' : plain(s.countedCash), 'num'], [s.diff === null ? '—' : `${s.diff > 0 ? '+' : ''}${plain(s.diff)}`, `num${s.diff ? ' is-bad' : ''}`]])),
    x.shifts.some((s) => s.ops.length) ? el('details', {}, el('summary', { textContent: 'Kassaga kiritilgan / olingan pullar' }),
      listTable([['Vaqt'], ['Smena'], ['Turi'], ['Sabab'], ['Kim'], ['Summa', 'num']], x.shifts.flatMap((s) => s.ops.map((o) => [[dtm(o.at)], [`#${s.number}`], [o.type === 'in' ? 'kiritildi' : 'olindi'], [o.reason || '—'], [o.byName], [`${o.type === 'in' ? '+' : '−'}${plain(o.amount)}`, 'num']])))) : '')
    : card('Smenalar (kassa)', '', el('p', { className: 'muted small', textContent: 'Bu davrda smena ochilmagan.' }));
  const ctl = (title, sub, pack, cols, row) => card(`${title} · ${pack.count} ta · ${money(pack.sum)}`, sub,
    pack.count ? listTable(cols, pack.list.map(row)) : el('p', { className: 'muted small', textContent: 'Yo‘q.' }));
  const st = x.stock;
  extrasBox.replaceChildren(
    el('h2', { className: 'ow-section', textContent: 'Kassa nazorati' }),
    el('div', { className: 'ow-mini-stats ow-strip' },
      el('div', {}, el('strong', { textContent: plain(x.discounts.count) }), el('span', { className: 'muted small', textContent: `chegirma · ${money(x.discounts.sum)}` })),
      el('div', {}, el('strong', { textContent: plain(x.voids.count) }), el('span', { className: 'muted small', textContent: `olib tashlangan taom · ${money(x.voids.sum)}` })),
      el('div', {}, el('strong', { textContent: plain(x.cancels.count) }), el('span', { className: 'muted small', textContent: `bekor buyurtma · ${money(x.cancels.sum)}` })),
      el('div', {}, el('strong', { textContent: plain(x.unpaid.count) }), el('span', { className: 'muted small', textContent: `to‘lovsiz yopilgan · ${money(x.unpaid.sum)}` })),
      el('div', {}, el('strong', { textContent: plain(x.moved) }), el('span', { className: 'muted small', textContent: 'stol ko‘chirildi' })),
      x.misonOpen ? el('div', {}, el('strong', { textContent: plain(x.misonOpen.count) }), el('span', { className: 'muted small', textContent: `hozir Mison kassasida ochiq stol · ${money(x.misonOpen.sum)}` })) : ''),
    shifts,
    el('div', { className: 'ow-stack' },
      ctl('Chegirmalar', 'Kim, qaysi stolga, nega', x.discounts, [['Vaqt'], ['Stol'], ['Sabab'], ['Kim'], ['Summa', 'num']], (v) => [[dtm(v.at)], [v.table], [v.reason || '—'], [v.byName], [plain(v.sum), 'num']]),
      ctl('Olib tashlangan taomlar', 'Oshxonaga yuborilgandan keyin', x.voids, [['Vaqt'], ['Taom'], ['Sabab'], ['Kim'], ['Summa', 'num']], (v) => [[dtm(v.at)], [`#${v.number} · ${qtyFmt(v.qty)} × ${v.name}`], [v.reason || '—'], [v.byName], [plain(v.sum), 'num']]),
      ctl('Bekor qilingan buyurtmalar', 'Qabul qilingandan keyin', x.cancels, [['Vaqt'], ['Buyurtma'], ['Sabab'], ['Kim'], ['Summa', 'num']], (v) => [[dtm(v.at)], [`#${v.number} · ${v.table}`], [v.reason || '—'], [v.byName], [plain(v.sum), 'num']])),
    st ? el('h2', { className: 'ow-section', textContent: 'Ombor' }) : '',
    st ? el('div', { className: 'ow-grid3' },
      card(`Kirim · ${money(st.totalIn)}`, `${st.receipts} ta kirim · ta’minotchilar bo‘yicha`, st.suppliers.length ? hbars(st.suppliers, { value: 'total', sub: (s) => `${s.count} ta kirim` }) : el('p', { className: 'muted small', textContent: 'Bu davrda kirim yo‘q.' })),
      card('Kelgan mahsulotlar', 'eng ko‘p pul ketganlari', st.products.length ? listTable([['Mahsulot'], ['Miqdor', 'num'], ['Summa', 'num']], st.products.map((p) => [[p.name], [`${qtyFmt(p.qty)} ${p.unit}`, 'num'], [plain(p.sum), 'num']])) : el('p', { className: 'muted small', textContent: '—' })),
      card('Kam qolgan mahsulotlar', st.lastCount ? `oxirgi qoldiq: ${st.lastCount.day} · ${st.lastCount.byName}` : 'qoldiq hali yozilmagan',
        st.low.length ? listTable([['Mahsulot'], ['Qoldi', 'num'], ['Eng kami', 'num']], st.low.map((p) => [[p.name], [`${qtyFmt(p.qty)} ${p.unit}`, 'num is-bad'], [`${qtyFmt(p.minQty)} ${p.unit}`, 'num']])) : el('p', { className: 'muted small', textContent: 'Hammasi yetarli.' }))) : '');
}

export function mountOwnerReport(el0, h = {}) {
  container = el0;
  Object.assign(hooks, h);
  if (!state.data) container.replaceChildren(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  load();
}

let loading = 0;
async function load() {
  const my = ++loading;
  const preset = PRESETS.find(([k]) => k === state.preset);
  if (preset) [state.from, state.to] = preset[2]();
  root().classList.add('is-loading');
  try {
    const q = new URLSearchParams({ from: state.from, to: state.to, ...(state.source ? { source: state.source } : {}) });
    const d = await api(`/owner/report?${q}`);
    if (my !== loading) return;
    state.data = d;
    state.showAll = false;
    render();
  } catch (e) {
    if (my !== loading) return;
    if ((e.status === 401 || e.status === 403) && hooks.onAuth) return hooks.onAuth(e);
    toast(e.message, 'error');
    if (!state.data) root().replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
  } finally {
    if (my === loading) root().classList.remove('is-loading');
  }
}

