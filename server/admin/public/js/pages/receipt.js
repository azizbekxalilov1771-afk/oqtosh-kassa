import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, saveBar, textField, selectField, toggleField, group } from '../ui.js';

// Chek ko'rinishi: oshxona cheki, hisob va to'lov cheki, Mison'ga ketadigan izoh.
// O'ngdagi namuna server chizgan aynan o'sha qatorlardan — printerdan qanday chiqsa, shunday ko'rinadi.


// ── chek rasmlari: brauzerda printer nuqtalariga (1 bit, Floyd–Steinberg) aylantiriladi ──
const MAX_W = 384;
const MAX_H = 480;
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Rasmni ochib bo‘lmadi. JPG yoki PNG tanlang.'));
    img.src = src;
  });
}
async function toBitmap(src, { width = MAX_W } = {}) {
  const img = await loadImage(src);
  let w = Math.min(width, MAX_W, img.naturalWidth || width);
  w = Math.max(8, Math.floor(w / 8) * 8);
  let h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  if (h > MAX_H) {
    w = Math.max(8, Math.floor(((MAX_H / h) * w) / 8) * 8);
    h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  }
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255;
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    g[i] = 255 - a * (255 - lum);
  }
  // qora fonli logo (masalan, saytdagi) — teskari qilinadi: chekda qora to'rtburchak emas, oq fonda qora logo chiqadi
  let edge = 0;
  let cnt = 0;
  for (let x = 0; x < w; x++) { edge += g[x] + g[(h - 1) * w + x]; cnt += 2; }
  for (let y = 0; y < h; y++) { edge += g[y * w] + g[y * w + w - 1]; cnt += 2; }
  if (edge / cnt < 110) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
  // oq fondagi mayda nuqtalar (JPEG shovqini) chiqmasin: deyarli oq — oq, deyarli qora — qora
  for (let i = 0; i < g.length; i++) g[i] = g[i] > 205 ? 255 : g[i] < 40 ? 0 : g[i];
  const xb = w / 8;
  const out = new Uint8Array(xb * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = g[i];
      const v = old < 128 ? 0 : 255;
      if (!v) out[y * xb + (x >> 3)] |= 0x80 >> (x & 7);
      const e = old - v;
      if (x + 1 < w) g[i + 1] += (e * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) g[i + w - 1] += (e * 3) / 16;
        g[i + w] += (e * 5) / 16;
        if (x + 1 < w) g[i + w + 1] += e / 16;
      }
    }
  }
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return { w, h, b64: btoa(bin) };
}
export function bitmapCanvas(bm) {
  const cv = document.createElement('canvas');
  cv.width = bm.w;
  cv.height = bm.h;
  const ctx = cv.getContext('2d');
  const data = ctx.createImageData(bm.w, bm.h);
  const bits = Uint8Array.from(atob(bm.b64), (c) => c.charCodeAt(0));
  const xb = bm.w / 8;
  for (let y = 0; y < bm.h; y++) for (let x = 0; x < bm.w; x++) {
    const on = bits[y * xb + (x >> 3)] & (0x80 >> (x & 7));
    const k = (y * bm.w + x) * 4;
    data.data[k] = data.data[k + 1] = data.data[k + 2] = on ? 0 : 255;
    data.data[k + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return cv;
}
const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('Faylni o‘qib bo‘lmadi.'));
  r.readAsDataURL(file);
});

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
    showLogo: toggleField({ label: 'Tepada logo', checked: r.bill.showLogo }),
    qr: textField({ label: 'Pastdagi QR kod (manzil yoki matn)', value: r.bill.qr, maxlength: 300, placeholder: 'https://oqtoshrestoran.uz/menyu — bo‘sh bo‘lsa QR chiqmaydi' }),
    qrLabel: textField({ label: 'QR ostidagi yozuv', value: r.bill.qrLabel, maxlength: 48, placeholder: 'Menyu va fikr-mulohaza' }),
    showImage: toggleField({ label: 'Eng pastda rasm', checked: r.bill.showImage }),
  };
  // rasmlar (logo va pastki rasm) — alohida saqlanadi, darhol
  const media = { logo: data.media?.logo || null, image: data.media?.image || null };
  const mediaBox = (key, title, hint, { width, fromSite = false }) => {
    const thumb = el('div', { className: 'rp-media-thumb' });
    const msg = el('p', { className: 'muted small' });
    const paint = () => {
      thumb.replaceChildren(media[key] ? bitmapCanvas(media[key]) : el('span', { className: 'muted small', textContent: 'rasm yo‘q' }));
      msg.textContent = media[key] ? `${media[key].w}×${media[key].h} nuqta · printer shunday chiqaradi` : hint;
    };
    const save = async (bm) => {
      msg.textContent = 'Saqlanmoqda…';
      try {
        const res = await api('/receipt/media', { method: 'PUT', body: { [key]: bm } });
        media[key] = res.media[key];
        paint();
        preview();
        toast(bm ? 'Rasm saqlandi' : 'Rasm olib tashlandi');
      } catch (e) {
        msg.textContent = e.message;
      }
    };
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        await save(await toBitmap(await readFile(f), { width }));
      } catch (e) {
        msg.textContent = e.message;
      }
    });
    paint();
    return el('div', { className: 'rp-media' },
      el('b', { textContent: title }), thumb, msg,
      el('div', { className: 'row' },
        btn('Rasm yuklash', () => file.click(), 'btn-small'),
        fromSite ? btn('Sayt logosidan', async () => { try { await save(await toBitmap('/logo.jpg', { width })); } catch (e) { msg.textContent = e.message; } }, 'btn-small btn-ghost') : '',
        btn('Olib tashlash', () => save(null), 'btn-small btn-ghost')),
      file);
  };
  const logoBox = mediaBox('logo', 'Logo', 'Oq fonli, aniq logo yaxshi chiqadi (printer faqat qora rangda).', { width: 256, fromSite: true });
  const imageBox = mediaBox('image', 'Pastki rasm', 'Aksiya, Wi‑Fi paroli, Instagram — oq-qora rasm.', { width: 384 });
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
        if (l.img) {
          const cv = bitmapCanvas(l.img);
          cv.className = 'rp-img';
          cv.style.width = `${Math.round((l.img.w / (res.width === 32 ? 384 : 576)) * 100)}%`;
          return el('div', { className: `rp-line rp-imgline a-${l.a || 'center'}` }, cv);
        }
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
    card('Mijoz chekidagi logo, QR va rasm', 'Hisob va to‘lov chekida: tepada logo, pastda QR kod (sayt, menyu, fikr-mulohaza yoki Instagram) va rasm. Printer rasmni nuqtalar bilan qora rangda chiqaradi.',
      el('div', { className: 'toggle-grid' }, b.showLogo.node, b.showImage.node),
      el('div', { className: 'rp-media-grid' }, logoBox, imageBox),
      group({ a: b.qr, c: b.qrLabel }).node),
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
