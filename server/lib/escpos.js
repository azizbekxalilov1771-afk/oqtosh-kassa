import { qrMatrix } from './qrcode.js';
// ESC/POS: termoprinterlarning o'z tili. Chek matni shu yerda baytlarga aylanadi va printer dasturi
// (printer-agent) uni tarmoqdagi printerga (IP:9100) yoki USB printerga o'zgartirmasdan yuboradi.
// Barcha printerlarda bir xil chiqishi uchun matn ASCII'ga o'giriladi: o‘ → o', kirill → lotin.

const ESC = 0x1b;
const GS = 0x1d;

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
};

export function ascii(s) {
  return String(s ?? '')
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s*[·•|]\s*/g, ' - ')
    .replace(/×/g, 'x')
    .replace(/[Ѐ-ӿ]/g, (ch) => {
      const low = ch.toLowerCase();
      const t = CYR[low] ?? '';
      return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e\n]/g, '');
}

const num = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const kg = (q) => `${String(Math.round(q * 1000) / 1000).replace('.', ',')} kg`;
const time = (ms) => new Date(ms || Date.now()).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function wrap(text, width) {
  const out = [];
  for (const para of ascii(text).split('\n')) {
    let line = (para.match(/^ +/) || [''])[0].slice(0, 6); // boshidagi chekinish saqlanadi
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line.trim()) line += word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

// Matn → QR rasm (oq hoshiya bilan), eni ~dots nuqta
export function qrBitmap(text, dots = 264) {
  if (!text) return null;
  let m;
  try {
    m = qrMatrix(String(text).slice(0, 300), 'M');
  } catch {
    return null;
  }
  const quiet = 2;
  const n = m.length + quiet * 2;
  const scale = Math.max(2, Math.min(8, Math.floor(dots / n)));
  const w = Math.ceil((n * scale) / 8) * 8;
  const h = n * scale;
  const xb = w / 8;
  const out = Buffer.alloc(xb * h);
  for (let y = 0; y < h; y++) {
    const r = Math.floor(y / scale) - quiet;
    if (r < 0 || r >= m.length) continue;
    for (let x = 0; x < n * scale; x++) {
      const c = Math.floor(x / scale) - quiet;
      if (c >= 0 && c < m.length && m[r][c]) out[y * xb + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { w, h, b64: out.toString('base64') };
}

// Oddiy chek quruvchi: qatorlar, qalin/katta yozuv, markazlash, chap-o'ng (narx), kesish.
// Bir vaqtda ko'rinishni ham yozib boradi (admin "Chek ko'rinishi"dagi jonli namuna aynan shu qatorlardan chiziladi).
export class Ticket {
  constructor({ width = 48 } = {}) {
    this.width = width;
    this.bytes = [ESC, 0x40]; // init
    this.view = [];
  }

  raw(...b) {
    this.bytes.push(...b);
    return this;
  }

  text(s) {
    for (const ch of Buffer.from(ascii(s), 'latin1')) this.bytes.push(ch);
    return this;
  }

  align(a) {
    return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0);
  }

  style({ bold = false, size = 1 } = {}) {
    const n = size === 2 ? 0x11 : size === 'tall' ? 0x01 : 0x00;
    return this.raw(ESC, 0x45, bold ? 1 : 0, GS, 0x21, n);
  }

  cols(size) {
    return size === 2 ? Math.floor(this.width / 2) : this.width;
  }

  note(t, opts = {}) {
    this.view.push({ t, a: opts.align || 'left', b: Boolean(opts.bold), s: opts.size === 2 ? 2 : opts.size === 'tall' ? 'tall' : 1 });
  }

  line(s = '', opts = {}) {
    this.align(opts.align || 'left').style(opts);
    for (const l of wrap(s, this.cols(opts.size))) {
      this.text(l).raw(0x0a);
      this.note(l, opts);
    }
    return this.style();
  }

  pair(left, right, opts = {}) {
    const w = this.cols(opts.size);
    const r = ascii(right);
    const lines = wrap(left, Math.max(8, w - r.length - 1));
    this.align('left').style(opts);
    lines.forEach((l, i) => {
      const tail = i === lines.length - 1 ? r : '';
      const row = l + ' '.repeat(Math.max(1, w - l.length - tail.length)) + tail;
      this.text(row).raw(0x0a);
      this.note(row, { ...opts, align: 'left' });
    });
    return this.style();
  }

  rule(ch = '-') {
    this.note(ch.repeat(this.width));
    return this.align('left').style().text(ch.repeat(this.width)).raw(0x0a);
  }

  feed(n = 1) {
    for (let i = 0; i < n; i++) this.note('');
    return this.raw(ESC, 0x64, n);
  }

  // Rasm (logo, QR, pastki rasm): img = { w, h, b64 } — 1 bitli, qator bo'yicha, eng katta bit chapda (1 — qora).
  // GS v 0 (raster) — Epson, Xprinter, Rongta va boshqa ESC/POS printerlarda ishlaydi; uzun rasm bo'laklab yuboriladi.
  image(img, { align = 'center' } = {}) {
    if (!img?.w || !img?.h || !img.b64) return this;
    const bytes = Buffer.from(img.b64, 'base64');
    const xb = img.w / 8;
    if (!Number.isInteger(xb) || bytes.length < xb * img.h) return this;
    this.align(align);
    for (let y = 0; y < img.h; y += 120) {
      const rows = Math.min(120, img.h - y);
      this.raw(GS, 0x76, 0x30, 0, xb & 255, xb >> 8, rows & 255, rows >> 8);
      for (const b of bytes.subarray(y * xb, (y + rows) * xb)) this.bytes.push(b);
    }
    this.view.push({ img: { w: img.w, h: img.h, b64: img.b64 }, a: align });
    return this.align('left');
  }

  // QR kod — o'zimiz rasm qilib chizamiz (hamma printerda bir xil chiqadi, printerning QR buyrug'iga bog'liq emas)
  qr(text, { dots = 264 } = {}) {
    const img = qrBitmap(text, dots);
    return img ? this.image(img) : this;
  }

  beep() {
    this.view.push({ beep: true });
    return this.raw(ESC, 0x42, 3, 2); // ko'p oshxona printerlarida ovozli signal
  }

  cut(n = 3) {
    this.raw(ESC, 0x64, n, GS, 0x56, 0x42, 0x00);
    this.view.push({ cut: true });
    return this;
  }

  base64() {
    return Buffer.from(this.bytes).toString('base64');
  }
}

const itemLine = (i) => (i.unit === 'kg' ? `${kg(i.qty)} ${i.name}` : `${i.qty} x ${i.name}`);
const modsText = (m) => (m?.length ? m.map((x) => (x.qty > 1 ? `${x.name} x${x.qty}` : x.name)).join(', ') : '');
const out = (t, preview) => (preview ? t.view : t.base64());

const KITCHEN = { title: '', itemSize: 'tall', showNumber: true, showTime: true, showWaiter: true, showHall: false, showComment: true, showMods: true, separateItems: false, feed: 3 };

/* ───────── Oshxona cheki (tayyorlash joyiga) ───────── */
// fmt — admin "Chek ko'rinishi" → Oshxona cheki. cancel — bekor qilingan buyurtma (oshpaz to'xtatsin).
export function kitchenTicket({ station, order, items, width = 48, beep = false, reprint = false, cancel = false, fmt = {}, preview = false }) {
  const f = { ...KITCHEN, ...fmt };
  const t = new Ticket({ width });
  if (beep) t.beep();
  t.line(f.title || station, { align: 'center', bold: true, size: 2 });
  if (f.title && station && f.title.toUpperCase() !== station.toUpperCase()) t.line(station, { align: 'center', bold: true });
  if (cancel) t.line('*** BEKOR QILINDI ***', { align: 'center', bold: true, size: 2 });
  else if (reprint) t.line('(qayta chiqarildi)', { align: 'center' });
  t.rule('=');
  // katta harf bilan — faqat stol nomi (oshpaz uzoqdan ko'rsin), zal pastda kichik
  const hall = String(order.tableHall || '').trim();
  let table = String(order.table || '').trim();
  if (hall && table.startsWith(hall)) table = table.slice(hall.length).replace(/^\s*[·•|-]\s*/, '').trim();
  const where = order.mode === 'delivery' ? 'YETKAZIB BERISH'
    : order.mode === 'saboy' ? order.tableLabel || 'SABOY'
      : /^\d+$/.test(table) ? `Stol ${table}` : table || order.tableLabel || 'Stol';
  t.line(where, { bold: true, size: 2 });
  if (f.showHall && hall && order.mode === 'table') t.line(hall);
  if (order.takeaway && order.mode === 'table') t.line('*** SABOY (olib ketadi) ***', { bold: true });
  const left = [f.showNumber && `#${order.number}`, f.showTime && time(order.acceptedAtMs || order.createdAtMs)].filter(Boolean).join('  ');
  const right = f.showWaiter ? order.acceptedByName || order.createdByName || '' : '';
  if (left || right) t.pair(left, right);
  t.rule();
  const size = f.itemSize === 'big' ? 2 : f.itemSize === 'tall' ? 'tall' : 1;
  items.forEach((i, n) => {
    if (n && f.separateItems) t.rule('.');
    t.line(itemLine(i), { bold: true, size });
    const m = f.showMods ? modsText(i.mods) : '';
    if (m) t.line(`   + ${m}`);
    if (i.note) t.line(`   >> ${i.note}`, { bold: true });
  });
  t.rule();
  if (f.showComment && order.comment) t.line(`Izoh: ${order.comment}`, { bold: true });
  return out(t.cut(f.feed), preview);
}

/* ───────── Kassa: hisob, to'lov cheki, buyurtma, sinov ───────── */
const BILL = { title: '', extra: '', showAddress: true, showPhone: true, showWaiter: true, showDate: true, showMods: true, showUnitPrice: true, footer: '', showFiscalNote: true, showCheckNo: false };

function head(t, brand, f, title, right) {
  t.line(f.title || brand?.name || 'Restoran', { align: 'center', bold: true, size: 2 });
  if (f.showAddress && brand?.address) t.line(brand.address, { align: 'center' });
  if (f.showPhone && brand?.phone) t.line(brand.phone, { align: 'center' });
  for (const l of String(f.extra || '').split('\n').filter(Boolean)) t.line(l, { align: 'center' });
  t.rule();
  t.pair(title, right || '', { bold: true });
  if (f.showDate) t.pair('Sana', time());
}

function tabItems(t, tab, f) {
  const accepted = tab.rounds.filter((o) => o.status === 'qabul');
  const merge = (list) => {
    const m = new Map();
    for (const i of list) {
      const key = `${i.name}|${modsText(i.mods)}|${i.unit || ''}|${Math.round(i.qty ? i.sum / i.qty : i.sum)}`;
      const cur = m.get(key);
      if (cur) {
        cur.qty += i.qty;
        cur.sum += i.sum;
      } else m.set(key, { ...i });
    }
    return [...m.values()];
  };
  const hall = merge(accepted.filter((o) => !o.takeaway).flatMap((o) => o.items));
  const away = merge(accepted.filter((o) => o.takeaway).flatMap((o) => o.items));
  const rows = (list) => {
    for (const i of list) {
      const name = i.name + (f.showMods && i.mods?.length ? ` (${modsText(i.mods)})` : '');
      if (f.showUnitPrice) {
        t.line(name);
        t.pair(`   ${i.unit === 'kg' ? kg(i.qty) : `${i.qty} x ${num(i.qty ? i.sum / i.qty : i.sum)}`}`, num(i.sum));
      } else t.pair(`${i.unit === 'kg' ? kg(i.qty) : `${i.qty} x`} ${name}`, num(i.sum));
    }
  };
  rows(tab.kind === 'saboy' ? away : hall);
  if (tab.kind !== 'saboy' && away.length) {
    t.line('SABOY (olib ketadi)', { bold: true });
    rows(away);
  }
  t.rule();
  t.pair('Taomlar', num(tab.subtotal));
  if (tab.discountAmt) t.pair(`Chegirma${tab.discount?.type === 'pct' ? ` ${String(tab.discount.value).replace('.', ',')}%` : ''}`, `-${num(tab.discountAmt)}`);
  if (tab.servicePct && tab.kind !== 'saboy') t.pair(`Xizmat haqi ${String(tab.servicePct).replace('.', ',')}%${tab.takeaway ? ' (saboysiz)' : ''}`, num(tab.service));
  t.pair('JAMI', `${num(tab.total)} so'm`, { bold: true, size: 2 });
}

// Smena hisoboti: X (smena davomida) yoki Z (yopilganda)
const dt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: process.env.TIMEZONE || 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
function shiftLines(t, r, brand, f) {
  t.line(f.title || brand?.name || 'Restoran', { align: 'center', bold: true });
  t.line(`${r.status === 'closed' ? 'Z' : 'X'}-HISOBOT`, { align: 'center', bold: true, size: 2 });
  t.line(`Smena #${r.number}`, { align: 'center' });
  t.rule();
  t.pair('Ochildi', `${dt(r.openedAt)} ${r.openedByName || ''}`.trim());
  if (r.status === 'closed') t.pair('Yopildi', `${dt(r.closedAt)} ${r.closedByName || ''}`.trim());
  else t.pair('Hozir', dt(new Date().toISOString()));
  t.rule();
  t.pair('Savdo', num(r.revenue), { bold: true });
  t.pair('Cheklar', String(r.checks));
  t.pair("O'rtacha chek", num(r.avg));
  if (r.service) t.pair('Xizmat haqi', num(r.service));
  if (r.discount) t.pair(`Chegirmalar (${r.discountCount})`, `-${num(r.discount)}`);
  if (r.delivery) t.pair('Yetkazishlar', String(r.delivery));
  t.rule();
  t.line("TO'LOV TURLARI", { bold: true });
  for (const m of r.methods || []) t.pair(`${m.label} (${m.count})`, num(m.sum));
  if (!(r.methods || []).length) t.line("To'lov yo'q");
  t.rule();
  t.line('NAQD PUL', { bold: true });
  t.pair("Boshlang'ich", num(r.openingCash));
  t.pair('Naqd savdo', num(r.cashSales));
  if (r.cashIn) t.pair('Kiritildi', `+${num(r.cashIn)}`);
  if (r.cashOut) t.pair('Olindi', `-${num(r.cashOut)}`);
  t.pair("Kassada bo'lishi kerak", num(r.expectedCash), { bold: true });
  if (r.countedCash !== null && r.countedCash !== undefined) {
    t.pair('Sanaldi', num(r.countedCash));
    t.pair('Farq', `${r.diff > 0 ? '+' : ''}${num(r.diff)}`, { bold: true });
  }
  if ((r.ops || []).length) {
    t.rule();
    for (const o of r.ops) t.pair(`${o.type === 'in' ? '+' : '-'} ${o.reason || (o.type === 'in' ? 'kiritildi' : 'olindi')}`, num(o.amount));
  }
  if (r.unpaid?.count || r.cancelled?.count || r.voided?.count) {
    t.rule();
    if (r.unpaid?.count) t.pair(`To'lovsiz yopilgan (${r.unpaid.count})`, num(r.unpaid.sum));
    if (r.cancelled?.count) t.pair(`Bekor qilingan (${r.cancelled.count})`, num(r.cancelled.sum));
    if (r.voided?.count) t.pair(`Olib tashlangan taom (${r.voided.count})`, num(r.voided.sum));
  }
  if ((r.waiters || []).length) {
    t.rule();
    t.line('OFITSIANTLAR', { bold: true });
    for (const w of r.waiters) t.pair(`${w.name} (${w.count})`, num(w.sum));
  }
  if ((r.items || []).length) {
    t.rule();
    t.line('KO\'P SOTILGAN', { bold: true });
    for (const i of r.items.slice(0, 15)) t.pair(`${String(i.qty).replace('.', ',')} x ${i.name}`, num(i.sum));
  }
  if (r.openTabs) {
    t.rule();
    t.line(`Ochiq hisoblar: ${r.openTabs} ta`, { align: 'center' });
  }
  if (r.note) t.line(`Izoh: ${r.note}`);
  t.rule();
}

export function billTicket({ kind, data, brand, footer, width = 48, number = '', byName = '', fmt = {}, preview = false }) {
  const f = { ...BILL, ...fmt };
  const t = new Ticket({ width });
  // mijoz cheki: tepada logo (admin → Chek ko'rinishi)
  if (f.logo && ['tab', 'paid', 'order', 'paidorder'].includes(kind)) t.image(f.logo).feed(1);
  if (kind === 'test') {
    head(t, brand, f, 'SINOV CHEKI', '');
    t.rule();
    t.line('Printer ishlayapti', { align: 'center', bold: true, size: 2 });
    if (data?.printerName) t.line(data.printerName, { align: 'center' });
    if (data?.station) t.line(`Tayyorlash joyi: ${data.station}`, { align: 'center' });
    return out(t.cut(), preview);
  }
  if (kind === 'tab' || kind === 'paid') {
    head(t, brand, f, kind === 'paid' ? "TO'LOV CHEKI" : data.kind === 'saboy' ? 'SABOY' : 'HISOB', data.tableLabel || '');
    if (f.showWaiter && data.waiterName) t.pair('Ofitsiant', data.waiterName);
    t.rule();
    tabItems(t, data, f);
    if (kind === 'paid') {
      const p = data.payment || {};
      t.pair("To'lov turi", p.label || 'Naqd');
      if (p.method === 'naqd') {
        t.pair('Berildi', num(p.received));
        t.pair('Qaytim', num(p.change));
      }
      t.feed(1).line("*** TO'LANDI ***", { align: 'center', bold: true, size: 2 });
    } else if (data.pending) t.line(`Tasdiqlanmagan: ${num(data.pending)} so'm (jamiga kirmagan)`);
  } else if (kind === 'shift') {
    shiftLines(t, data, brand, f);
    return out(t.cut(), preview);
  } else if (kind === 'order' || kind === 'paidorder') {
    const o = data;
    head(t, brand, f, kind === 'paidorder' ? "TO'LOV CHEKI" : `BUYURTMA #${o.number}`, o.mode === 'delivery' ? `Yetkazish #${o.number}` : o.tableLabel || '');
    if (o.customerName) t.pair('Mijoz', `${o.customerName} ${o.mode === 'delivery' ? o.deliveryPhone || '' : o.customerPhone || ''}`.trim());
    if (o.mode === 'delivery' && o.address?.text) t.line(`Manzil: ${[o.address.text, o.address.apartment && `kv. ${o.address.apartment}`].filter(Boolean).join(', ')}`);
    t.rule();
    for (const i of o.items) t.pair(`${itemLine(i)}${f.showMods && i.mods?.length ? ` (${modsText(i.mods)})` : ''}`, num(i.sum));
    t.rule();
    if (o.deliveryFee) t.pair('Yetkazish', num(o.deliveryFee));
    t.pair('JAMI', `${num(o.total)} so'm`, { bold: true, size: 2 });
    if (o.comment) t.line(`Izoh: ${o.comment}`);
    if (kind === 'paidorder') {
      const p = o.payment || {};
      t.pair("To'lov turi", p.label || 'Naqd');
      if (p.method === 'naqd') {
        t.pair('Berildi', num(p.received));
        t.pair('Qaytim', num(p.change));
      }
      t.feed(1).line("*** TO'LANDI ***", { align: 'center', bold: true, size: 2 });
    }
  }
  t.rule();
  const foot = f.footer || footer;
  if (foot) t.line(foot, { align: 'center' });
  if (f.showFiscalNote) t.line(kind === 'paid' ? 'Fiskal chek alohida beriladi' : "To'lov uchun hisob. Fiskal chek kassada", { align: 'center' });
  if (f.showCheckNo && (number || byName)) t.line(`Chek ${number}${byName ? ` - ${byName}` : ''}`, { align: 'center' });
  // pastda: QR (sayt, menyu, fikr-mulohaza, Instagram…) va rasm (aksiya, Wi‑Fi…)
  if (f.qr) {
    t.feed(1).qr(f.qr, { dots: width === 32 ? 216 : 264 });
    if (f.qrLabel) t.line(f.qrLabel, { align: 'center', bold: true });
  }
  if (f.image) t.feed(1).image(f.image);
  return out(t.cut(), preview);
}
