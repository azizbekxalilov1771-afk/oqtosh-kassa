// Termoprinter uchun chek (80 yoki 58 mm). Kassa kompyuterida yashirin oynada chop etiladi.
// Bu — to'lov uchun hisob (oldindan chek). Fiskal chekni Mison kassasi beradi.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const kg = (q) => `${String(Math.round(q * 1000) / 1000).replace('.', ',')} kg`;
const when = (iso) => new Date(iso || Date.now()).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const mods = (m) => (m?.length ? m.map((x) => (x.qty > 1 ? `${x.name} ×${x.qty}` : x.name)).join(', ') : '');

// Bir xil taomlar (nomi, qo'shimchasi va narxi bir xil) bitta qatorga yig'iladi
function mergeItems(items) {
  const map = new Map();
  for (const i of items) {
    const unit = i.qty ? i.sum / i.qty : i.sum;
    const key = `${i.name}|${mods(i.mods)}|${i.unit || ''}|${Math.round(unit)}`;
    const m = map.get(key);
    if (m) {
      m.qty += i.qty;
      m.sum += i.sum;
    } else map.set(key, { name: i.name, mods: mods(i.mods), unit: i.unit || '', price: unit, qty: i.qty, sum: i.sum });
  }
  return [...map.values()];
}

const row = (a, b, cls = '') => `<div class="row ${cls}"><span>${a}</span><span>${b}</span></div>`;

// Admin → "Chek ko'rinishi" sozlamalari (job.fmt). Berilmagan bo'lsa — odatdagi ko'rinish.
const FMT = { title: '', extra: '', showAddress: true, showPhone: true, showWaiter: true, showDate: true, showMods: true, showUnitPrice: true, footer: '', showFiscalNote: true, showCheckNo: false };
let F = FMT;

const itemRows = (items) => mergeItems(items).map((i) => {
  const mods = F.showMods && i.mods ? ` <small>(${esc(i.mods)})</small>` : '';
  return F.showUnitPrice
    ? `<div class="item"><div class="name">${esc(i.name)}${mods}</div>${row(i.unit === 'kg' ? kg(i.qty) : `${num(i.qty)} × ${num(i.price)}`, num(i.sum), 'qty')}</div>`
    : `<div class="item">${row(`${i.unit === 'kg' ? kg(i.qty) : `${num(i.qty)} ×`} <span class="name">${esc(i.name)}</span>${mods}`, num(i.sum))}</div>`;
}).join('');

function head(job, title, right) {
  const b = job.brand || {};
  const extra = String(F.extra || '').split('\n').filter(Boolean).map((l) => `<div class="c small">${esc(l)}</div>`).join('');
  return `<div class="c brand">${esc(F.title || b.name || 'Restoran')}</div>${F.showAddress && b.address ? `<div class="c small">${esc(b.address)}</div>` : ''}${F.showPhone && b.phone ? `<div class="c small">${esc(b.phone)}</div>` : ''}${extra}
<hr>${row(`<b>${esc(title)}</b>`, `<b>${esc(right)}</b>`)}${F.showDate ? row('Sana', esc(when(job.createdAt))) : ''}`;
}

function foot(job, extra = '') {
  const footer = F.footer || job.footer;
  return `${extra}<hr>${footer ? `<div class="c">${esc(footer)}</div>` : ''}
${F.showFiscalNote ? `<div class="c small">${job.kind === 'paid' ? 'Fiskal chek alohida beriladi' : 'To‘lov uchun hisob · fiskal chek kassada beriladi'}</div>` : ''}
${F.showCheckNo ? `<div class="c small">Chek ${esc(job.number || '')}${job.byName ? ` · ${esc(job.byName)}` : ''}</div>` : ''}`;
}

// Stol hisobi taomlari: zalda yeyilgani va saboy (olib ketiladigan) alohida
function tabLines(t) {
  const accepted = t.rounds.filter((o) => o.status === 'qabul');
  const hall = accepted.filter((o) => !o.takeaway).flatMap((o) => o.items);
  const away = accepted.filter((o) => o.takeaway).flatMap((o) => o.items);
  const saboyTab = t.kind === 'saboy';
  return {
    accepted,
    html: `${itemRows(saboyTab ? away : hall)}${!saboyTab && away.length ? `<div class="sub-head">SABOY (olib ketadi)</div>${itemRows(away)}` : ''}`,
    sums: `${row('Taomlar', num(t.subtotal))}${t.discountAmt ? row(`Chegirma${t.discount?.type === 'pct' ? ` ${String(t.discount.value).replace('.', ',')}%` : ''}`, `−${num(t.discountAmt)}`) : ''}${t.servicePct && t.kind !== 'saboy' ? row(`Xizmat haqi ${String(t.servicePct).replace('.', ',')}%${t.takeaway ? ' (saboydan tashqari)' : ''}`, num(t.service)) : ''}`,
  };
}

function tabBody(job) {
  const t = job.data;
  const L = tabLines(t);
  return `${head(job, t.kind === 'saboy' ? 'SABOY' : 'HISOB', t.tableLabel || '')}
${F.showWaiter && t.waiterName ? row('Ofitsiant', esc(t.waiterName)) : ''}
<hr>${L.html}<hr>
${L.sums}
<div class="total">${row('JAMI', `${num(t.total)} so‘m`)}</div>
${foot(job, t.pending ? `<div class="small">Tasdiqlanmagan: ${num(t.pending)} so‘m (jamiga kirmagan)</div>` : '')}`;
}

// To'lov qilindi — mijozga beriladigan chek
function paidBody(job) {
  const t = job.data;
  const p = t.payment || {};
  const L = tabLines(t);
  return `${head(job, 'TO‘LOV CHEKI', t.tableLabel || '')}
${F.showWaiter && t.waiterName ? row('Ofitsiant', esc(t.waiterName)) : ''}${row('Kassir', esc(p.byName || t.closedByName || ''))}
<hr>${L.html}<hr>
${L.sums}
<div class="total">${row('JAMI', `${num(t.total)} so‘m`)}</div>
${row('To‘lov turi', esc(p.label || 'Naqd'))}${p.method === 'naqd' ? `${row('Berildi', num(p.received))}${row('Qaytim', num(p.change))}` : ''}
<div class="c paid">✓ TO‘LANDI</div>
${foot(job)}`;
}

function orderBody(job) {
  const o = job.data;
  const paid = job.kind === 'paidorder';
  const p = o.payment || {};
  const delivery = o.mode === 'delivery';
  const fee = delivery ? o.deliveryFee || 0 : 0;
  const addr = delivery && o.address ? [o.address.text, o.address.apartment && `kv. ${o.address.apartment}`, o.address.entrance && `${o.address.entrance}-podyezd`, o.address.floor && `${o.address.floor}-qavat`].filter(Boolean).join(', ') : '';
  return `${head(job, paid ? 'TO‘LOV CHEKI' : `BUYURTMA #${o.number}`, delivery ? `Yetkazish #${o.number}` : o.tableLabel || '')}
${o.customerName || o.customerPhone ? row('Mijoz', esc([o.customerName, delivery ? o.deliveryPhone : o.customerPhone].filter(Boolean).join(', '))) : ''}
${addr ? `<div class="small">Manzil: ${esc(addr)}</div>` : ''}${o.courierName ? row('Kuryer', esc(o.courierName)) : ''}
<hr>${itemRows(o.items)}<hr>
${delivery ? `${row('Taomlar', num(o.total - fee))}${row(`Yetkazish${o.deliveryKm ? ` (${String(o.deliveryKm).replace('.', ',')} km)` : ''}`, num(fee))}` : ''}
<div class="total">${row('JAMI', `${num(o.total)} so‘m`)}</div>
${o.comment ? `<div class="small">Izoh: ${esc(o.comment)}</div>` : ''}${!paid && o.statusLabel ? row('Holat', esc(o.statusLabel)) : ''}
${paid ? `${row('To‘lov turi', esc(p.label || 'Naqd'))}${p.method === 'naqd' ? `${row('Berildi', num(p.received))}${row('Qaytim', num(p.change))}` : ''}<div class="c paid">✓ TO‘LANDI</div>` : ''}
${foot(job)}`;
}

// Smena hisoboti (X — smena davomida, Z — yopilganda)
const dt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function shiftBody(job) {
  const r = job.data;
  const b = job.brand || {};
  const sec = (title, rows) => (rows ? `<hr><div class="sub-head">${title}</div>${rows}` : '');
  return `<div class="c brand">${esc(F.title || b.name || 'Restoran')}</div>
<div class="c total">${r.status === 'closed' ? 'Z' : 'X'}-HISOBOT</div><div class="c">Smena #${esc(r.number)}</div><hr>
${row('Ochildi', esc(`${dt(r.openedAt)} ${r.openedByName || ''}`))}${r.status === 'closed' ? row('Yopildi', esc(`${dt(r.closedAt)} ${r.closedByName || ''}`)) : row('Hozir', dt(new Date().toISOString()))}<hr>
<div class="total">${row('Savdo', num(r.revenue))}</div>${row('Cheklar', r.checks)}${row('O‘rtacha chek', num(r.avg))}${r.service ? row('Xizmat haqi', num(r.service)) : ''}${r.discount ? row(`Chegirmalar (${r.discountCount})`, `−${num(r.discount)}`) : ''}${r.delivery ? row('Yetkazishlar', r.delivery) : ''}
${sec('TO‘LOV TURLARI', (r.methods || []).map((m) => row(`${esc(m.label)} (${m.count})`, num(m.sum))).join('') || '<div class="small">To‘lov yo‘q</div>')}
${sec('NAQD PUL', `${row('Boshlang‘ich', num(r.openingCash))}${row('Naqd savdo', num(r.cashSales))}${r.cashIn ? row('Kiritildi', `+${num(r.cashIn)}`) : ''}${r.cashOut ? row('Olindi', `−${num(r.cashOut)}`) : ''}<b>${row('Kassada bo‘lishi kerak', num(r.expectedCash))}</b>${r.countedCash !== null && r.countedCash !== undefined ? `${row('Sanaldi', num(r.countedCash))}<b>${row('Farq', `${r.diff > 0 ? '+' : ''}${num(r.diff)}`)}</b>` : ''}`)}
${(r.ops || []).length ? `<hr>${r.ops.map((o) => row(`${o.type === 'in' ? '+' : '−'} ${esc(o.reason || (o.type === 'in' ? 'kiritildi' : 'olindi'))}`, num(o.amount))).join('')}` : ''}
${r.unpaid?.count || r.cancelled?.count || r.voided?.count ? `<hr>${r.unpaid?.count ? row(`To‘lovsiz yopilgan (${r.unpaid.count})`, num(r.unpaid.sum)) : ''}${r.cancelled?.count ? row(`Bekor qilingan (${r.cancelled.count})`, num(r.cancelled.sum)) : ''}${r.voided?.count ? row(`Olib tashlangan taom (${r.voided.count})`, num(r.voided.sum)) : ''}` : ''}
${sec('OFITSIANTLAR', (r.waiters || []).map((w) => row(`${esc(w.name)} (${w.count})`, num(w.sum))).join(''))}
${sec('KO‘P SOTILGAN', (r.items || []).slice(0, 15).map((i) => row(`${String(i.qty).replace('.', ',')} × ${esc(i.name)}`, num(i.sum))).join(''))}
${r.openTabs ? `<hr><div class="c small">Ochiq hisoblar: ${r.openTabs} ta</div>` : ''}${r.note ? `<div class="small">Izoh: ${esc(r.note)}</div>` : ''}<hr>`;
}

function testBody(job) {
  return `${head(job, 'SINOV CHEKI', '')}<hr>
<div class="c total">Printer ishlayapti ✓</div>
${job.data?.deviceName ? `<div class="c small">${esc(job.data.deviceName)}</div>` : ''}
<div class="c small">Telefondan bosilgan cheklar shu printerdan chiqadi.</div>${foot(job)}`;
}

export function receiptHtml(job) {
  F = { ...FMT, ...(job.fmt || {}) };
  const w = job.paper === 58 ? 48 : 72; // chop etiladigan eni, mm
  const body = job.kind === 'tab' ? tabBody(job) : job.kind === 'paid' ? paidBody(job) : job.kind === 'order' || job.kind === 'paidorder' ? orderBody(job) : job.kind === 'shift' ? shiftBody(job) : testBody(job);
  return `<!doctype html><html lang="uz"><head><meta charset="utf-8"><title>Chek ${esc(job.number || '')}</title><style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: ${w}mm; margin: 0 auto; padding: 3mm 0 6mm; font: ${job.paper === 58 ? 11 : 12}px/1.35 Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; }
.c { text-align: center; }
.brand { font-size: 1.45em; font-weight: 700; letter-spacing: .02em; }
.small { font-size: .85em; }
hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
.row { display: flex; justify-content: space-between; gap: 2mm; }
.row span:last-child { text-align: right; white-space: nowrap; }
.item { margin: 1mm 0; }
.item .name { font-weight: 600; }
.item small { font-weight: 400; }
.qty { padding-left: 3mm; }
.total { font-size: 1.35em; font-weight: 700; margin: 1.5mm 0; }
.sub-head { margin: 2mm 0 .5mm; font-weight: 700; font-size: .9em; letter-spacing: .04em; }
.paid { margin: 2.5mm 0 1mm; padding: 1.5mm 0; border: .5mm solid #000; font-size: 1.25em; font-weight: 700; letter-spacing: .06em; }
</style></head><body>${body}</body></html>`;
}
