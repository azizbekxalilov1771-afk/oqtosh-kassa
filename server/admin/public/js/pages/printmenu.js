import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, selectField, toggleField, textField } from '../ui.js';
import { qrSvg } from '../vendor/qrcode.js';

// Stolga qo'yiladigan bosma menyu: Mison menyusidan avtomatik. Bo'limlar rangli sarlavhalar bilan ustunlarga
// joylanadi, shrift varaqqa sig'adigan eng katta o'lchamga o'zi moslanadi. Pastda — buyurtma QR kodi.

const PAPERS = {
  a4l: { w: 297, h: 210, cols: 4, label: 'A4 yotiq' },
  a4p: { w: 210, h: 297, cols: 3, label: 'A4 tik' },
  a3l: { w: 420, h: 297, cols: 5, label: 'A3 yotiq (katta)' },
};
const THEMES = [['yorqin', 'Sariq va binafsha (yorqin)'], ['oqtosh', 'Oqtosh: krem va oltin'], ['oddiy', 'Oq-qora (arzon chop)']];
const SIZES = [['150', 'Avtomatik (varaqni to‘ldiradi)'], ['115', 'Katta'], ['100', 'O‘rtacha'], ['85', 'Kichik']];
// Ichimlik va shirinlik bo'limlari boshqa rangda (rasmdagidek)
const ALT = /ichimlik|choy|qahva|kofe|coffee|sharbat|limonad|kokteyl|smuzi|desert|shirinlik|muzqaymoq|salqin|napit|чай|кофе|напит|десерт|морожен/i;
const KEY = 'oq_printmenu';
const num = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export async function render(root) {
  let data = await api('/menu/print');
  const saved = loadPrefs();
  const st = {
    paper: PAPERS[saved.paper] ? saved.paper : 'a4l',
    theme: THEMES.some(([k]) => k === saved.theme) ? saved.theme : 'yorqin',
    size: SIZES.some(([k]) => k === saved.size) ? saved.size : '150',
    photos: saved.photos ?? true,
    stopped: saved.stopped ?? true,
    desc: saved.desc ?? false,
    qr: saved.qr || 'common',
    title: saved.title ?? data.restaurant.name,
    subtitle: saved.subtitle ?? data.restaurant.tagline,
    off: new Set(saved.off || []),
  };
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...st, off: [...st.off] }));
    } catch {}
  };

  const preview = el('div', { className: 'pm-preview' });
  const info = el('p', { className: 'pm-info muted', role: 'status' });
  const printArea = el('div', { className: 'pm-print-extra' });

  /* ───────── ma'lumot ───────── */
  const allCats = () => (data.categories.length ? data.categories : [...new Set(data.items.map((i) => i.category))]);
  const tables = () => data.halls.flatMap((h) => h.tables.map((t) => ({ ...t, hall: h.name })));
  const cats = () => allCats().filter((c) => !st.off.has(c))
    .map((c) => ({ name: c, items: data.items.filter((i) => i.category === c && (st.stopped || i.available)) }))
    .filter((c) => c.items.length);
  const site = () => data.siteUrl || '';
  const qrFor = (table) => (table ? `${site()}/buyurtma.html?stol_id=${encodeURIComponent(table.id)}` : `${site()}/buyurtma.html?restoranda`);

  /* ───────── varaq ───────── */
  function itemNode(i) {
    const v = i.variants || [];
    const name = el('span', { className: 'n' }, i.name, i.weight && !i.kg ? el('small', { textContent: ` ${i.weight}` }) : '');
    if (v.length > 2) {
      return el('li', { className: 'pm-item' }, el('div', { className: 'pm-row' }, name),
        el('ul', { className: 'pm-sub' }, v.map((x) => el('li', { className: 'pm-row' },
          el('span', { className: 'n', textContent: x.name }), el('span', { className: 'd' }), el('span', { className: 'p', textContent: num(x.price) })))));
    }
    const price = v.length === 2 ? `${num(v[0].price)} / ${num(v[1].price)}` : num(i.price);
    return el('li', { className: 'pm-item' },
      el('div', { className: 'pm-row' }, name, el('span', { className: 'd' }), el('span', { className: 'p' }, price, i.kg ? el('small', { textContent: ' /kg' }) : '')),
      v.length === 2 ? el('div', { className: 'pm-vn', textContent: `${v[0].name} / ${v[1].name}` }) : '',
      st.desc && i.description ? el('div', { className: 'pm-desc', textContent: i.description }) : '');
  }

  function catNode(c) {
    let photos = st.photos ? [...new Set(c.items.map((i) => i.image).filter(Boolean))].slice(0, 3) : [];
    if (st.photos && !photos.length && data.categoryImages[c.name]) photos = [data.categoryImages[c.name]];
    return el('section', { className: `pm-cat${ALT.test(c.name) ? ' is-alt' : ''}` },
      el('h2', { textContent: c.name }),
      photos.length ? el('div', { className: `pm-photos n${photos.length}` }, photos.map((src) => el('img', { src, alt: '', decoding: 'async', onerror() { this.style.visibility = 'hidden'; } }))) : '',
      el('ul', { className: 'pm-items' }, c.items.map(itemNode)));
  }

  function sheet(group, { page, pages, table, scale }) {
    const P = PAPERS[st.paper];
    const r = data.restaurant;
    const showQr = st.qr !== 'none';
    const s = el('article', { className: `pm-sheet theme-${st.theme}`, style: `--w:${P.w}mm;--h:${P.h}mm;--cols:${P.cols};--fs:${scale / 100}` },
      el('header', { className: 'pm-head' },
        el('img', { className: 'pm-logo', src: r.logo || '/logo.jpg', alt: '', onerror() { this.remove(); } }),
        el('div', { className: 'pm-title' }, el('h1', { textContent: st.title || r.name }), st.subtitle ? el('p', { textContent: st.subtitle }) : ''),
        el('div', { className: 'pm-note' },
          el('span', { textContent: 'Narxlar so‘mda' }),
          data.servicePct ? el('span', { textContent: `Xizmat haqi ${String(data.servicePct).replace('.', ',')}%` }) : '',
          pages > 1 ? el('span', { textContent: `${page}/${pages}` }) : '')),
      el('div', { className: 'pm-cols' }, group.map(catNode)),
      el('footer', { className: 'pm-foot' },
        showQr ? el('div', { className: 'pm-qr' }, qrSvg(qrFor(table), { label: 'Buyurtma QR kodi', margin: 1 })) : '',
        el('div', { className: 'pm-cta' }, showQr ? [
          el('b', { textContent: table ? `${table.label} · telefondan buyurtma` : 'Telefondan buyurtma bering' }),
          el('span', { textContent: 'QR kodni kamera bilan skanerlang → taom tanlang → ofitsiant tasdiqlaydi' }),
        ] : [el('b', { textContent: 'Yoqimli ishtaha!' })]),
        el('div', { className: 'pm-contact' },
          r.phone ? el('b', { textContent: r.phone }) : '',
          r.address ? el('span', { textContent: r.address }) : '',
          r.instagram ? el('span', { textContent: `Instagram: ${r.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//, '@').replace(/\/$/, '')}` }) : '')));
    return s;
  }

  // Bo'limlarni k varaqqa teng bo'lish (tartib saqlanadi)
  function split(list, k) {
    if (k === 1) return [list];
    const w = (c) => c.items.length + 3 + (st.photos ? 2 : 0);
    const total = list.reduce((s, c) => s + w(c), 0);
    const out = [];
    let cur = [];
    let acc = 0;
    for (const c of list) {
      const target = (total / k) * (out.length + 1);
      if (cur.length && out.length < k - 1 && acc + w(c) / 2 > target) {
        out.push(cur);
        cur = [];
      }
      cur.push(c);
      acc += w(c);
    }
    out.push(cur);
    return out;
  }

  const overflow = (sh) => {
    const c = sh.querySelector('.pm-cols');
    return c.scrollWidth > c.clientWidth + 2 || c.scrollHeight > c.clientHeight + 2;
  };
  const setScale = (sheets, v) => sheets.forEach((s) => s.style.setProperty('--fs', v / 100));

  // Eng katta sig'adigan shrift: 1 varaqdan boshlab, sig'masa 2, 3… varaq
  let plan = null;
  function layout() {
    const list = cats();
    if (!list.length) return { groups: [], scale: 100, ok: true };
    const max = Number(st.size);
    const MIN = 60;
    for (let k = 1; k <= 4; k++) {
      const groups = split(list, k);
      const sheets = groups.map((g, i) => sheet(g, { page: i + 1, pages: k, scale: max }));
      preview.replaceChildren(...sheets.map(frame));
      const fits = (v) => {
        setScale(sheets, v);
        return sheets.every((s) => !overflow(s));
      };
      if (fits(max)) return { groups, scale: max, ok: true };
      if (!fits(MIN)) continue;
      let lo = MIN;
      let hi = max;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      return { groups, scale: lo, ok: true };
    }
    return { groups: split(list, 4), scale: MIN, ok: false };
  }

  function frame(s) {
    return el('div', { className: 'pm-frame' }, s);
  }

  function zoom() {
    const P = PAPERS[st.paper];
    const avail = Math.max(280, preview.clientWidth || root.clientWidth || 900);
    const z = Math.min(1, avail / (P.w * 3.7795));
    preview.style.setProperty('--z', z.toFixed(4));
    preview.style.setProperty('--fw', `${P.w}mm`);
    preview.style.setProperty('--fh', `${P.h - 1}mm`);
  }

  function paint() {
    save();
    plan = layout();
    const firstTable = st.qr.startsWith('t:') ? tables().find((t) => `t:${t.id}` === st.qr) : st.qr === 'all' ? tables()[0] : null;
    const pages = plan.groups.length;
    preview.replaceChildren(...plan.groups.map((g, i) => frame(sheet(g, { page: i + 1, pages, table: firstTable, scale: plan.scale }))));
    zoom();
    const nItems = plan.groups.flat().reduce((s, c) => s + c.items.length, 0);
    const copies = st.qr === 'all' ? tables().length : 1;
    info.textContent = !pages
      ? 'Menyu bo‘sh — bo‘limlarni tanlang yoki menyuni Mison’dan yangilang.'
      : `${nItems} ta taom · ${pages} varaq${copies > 1 ? ` × ${copies} stol = ${pages * copies} sahifa` : ''} · shrift ${plan.scale}%${plan.ok ? '' : ' — sig‘madi, bo‘limlarni kamaytiring yoki A3 tanlang'}`;
    info.classList.toggle('is-warn', !plan.ok);
  }

  /* ───────── chop etish ───────── */
  const pageStyle = el('style', { id: 'pm-page-style' });
  const setPageSize = () => {
    const P = PAPERS[st.paper];
    pageStyle.textContent = `@page { size: ${P.w}mm ${P.h}mm; margin: 0; }`;
    if (!pageStyle.isConnected) document.head.append(pageStyle);
  };
  const onBefore = () => root.isConnected && setPageSize();
  const onAfter = () => {
    pageStyle.remove();
    printArea.replaceChildren();
    document.body.classList.remove('pm-printing');
  };
  window.addEventListener('beforeprint', onBefore);
  window.addEventListener('afterprint', onAfter);

  async function doPrint() {
    if (!plan?.groups.length) return toast('Chop etadigan narsa yo‘q.', 'error');
    // "Hamma stollar": har stolga o'z QR kodi bilan alohida to'plam
    if (st.qr === 'all' && tables().length > 1) {
      const pages = plan.groups.length;
      printArea.replaceChildren(...tables().slice(1).flatMap((t) => plan.groups.map((g, i) => sheet(g, { page: i + 1, pages, table: t, scale: plan.scale }))));
    }
    document.body.classList.add('pm-printing');
    const imgs = [...root.querySelectorAll('.pm-sheet img')];
    await Promise.race([
      Promise.all([document.fonts?.ready, ...imgs.map((i) => (i.complete ? null : new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })))]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    setPageSize();
    window.print();
  }

  /* ───────── boshqaruv ───────── */
  const paper = selectField({ label: 'Qog‘oz', value: st.paper, options: Object.entries(PAPERS).map(([k, p]) => [k, p.label]) });
  const theme = selectField({ label: 'Rang', value: st.theme, options: THEMES });
  const size = selectField({ label: 'Shrift', value: st.size, options: SIZES });
  const qrOpts = [['common', 'QR: umumiy (mijoz stolni tanlaydi)'], ['all', `QR: har stolga alohida (${tables().length} ta)`], ['none', 'QR kodsiz'],
    ...tables().map((t) => [`t:${t.id}`, `QR: faqat ${t.label}`])];
  const qr = selectField({ label: 'Buyurtma QR kodi', value: qrOpts.some(([k]) => k === st.qr) ? st.qr : 'common', options: qrOpts });
  st.qr = qr.get();
  const photos = toggleField({ label: 'Taom rasmlari', checked: st.photos });
  const stopped = toggleField({ label: 'Stopdagi taomlar ham (bosma menyu doimiy)', checked: st.stopped });
  const desc = toggleField({ label: 'Taom tarkibi (izoh)', checked: st.desc });
  const title = textField({ label: 'Sarlavha', value: st.title, maxlength: 60 });
  const subtitle = textField({ label: 'Kichik yozuv', value: st.subtitle, maxlength: 90, placeholder: 'Milliy taomlar · Toshkent' });
  const catBox = el('div', { className: 'pm-cats' });

  function paintCats() {
    catBox.replaceChildren(...allCats().map((c) => {
      const n = data.items.filter((i) => i.category === c).length;
      const box = el('input', { type: 'checkbox', checked: !st.off.has(c) });
      box.addEventListener('change', () => {
        if (box.checked) st.off.delete(c);
        else st.off.add(c);
        paint();
      });
      return el('label', { className: 'pm-chip' }, box, el('span', { textContent: `${c} · ${n}` }));
    }));
  }

  const bind = (f, key, read = () => f.get()) => f.input.addEventListener(f.input.type === 'checkbox' || f.input.tagName === 'SELECT' ? 'change' : 'input', () => {
    st[key] = read();
    paint();
  });
  bind(paper, 'paper');
  bind(theme, 'theme');
  bind(size, 'size');
  bind(qr, 'qr');
  bind(photos, 'photos');
  bind(stopped, 'stopped');
  bind(desc, 'desc');
  bind(title, 'title', () => title.input.value);
  bind(subtitle, 'subtitle', () => subtitle.input.value);

  const refresh = btn('Menyuni Mison’dan yangilash', (e) => busy(e.currentTarget, 'Yangilanmoqda…', async () => {
    try {
      const r = await api('/menu/refresh', { method: 'POST', body: {} });
      data = await api('/menu/print');
      paintCats();
      paint();
      toast(r.posError ? `Mison: ${r.posError}` : `${r.count} ta taom yangilandi.`, r.posError ? 'error' : 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  }), 'btn-ghost');
  const print = btn('🖨 Chop etish / PDF', doPrint);

  let rz = 0;
  const onResize = () => {
    if (!root.isConnected) return window.removeEventListener('resize', onResize);
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(zoom);
  };
  window.addEventListener('resize', onResize);

  root.append(
    pageHead('Stol menyusi', 'Stolga qo‘yiladigan bosma menyu — Mison’dagi taom va narxlardan o‘zi tuziladi. Narx o‘zgarsa, shu yerga kirib qayta chop etasiz.', refresh, print),
    card('Sozlamalar', '',
      el('div', { className: 'grid-3 pm-controls' }, paper.node, theme.node, size.node, qr.node, title.node, subtitle.node),
      el('div', { className: 'row wrap pm-toggles' }, photos.node, stopped.node, desc.node),
      el('h3', { className: 'pm-h3', textContent: 'Bo‘limlar' }), catBox,
      el('p', { className: 'muted small', textContent: 'Chop etish oynasida printerni tanlang yoki “PDF sifatida saqlash” → faylni bosmaxonaga berasiz. Laminatsiya qilinsa, uzoq xizmat qiladi. “Fon rasmlari”/“Background graphics” belgisi yoqilgan bo‘lsin.' })),
    info,
    preview,
    printArea);
  paintCats();
  // O'lchash uchun sahifa ekranda bo'lishi kerak (admin uni render'dan keyin qo'yadi) va shriftlar yuklangan bo'lsin
  const attached = () => new Promise((r) => {
    const t = () => (root.isConnected ? r() : requestAnimationFrame(t));
    t();
  });
  attached().then(() => {
    paint();
    document.fonts?.ready.then(() => root.isConnected && paint());
  });
  if (data.posError) toast(`Mison: ${data.posError} — oxirgi saqlangan menyu ko‘rsatildi.`, 'error');
}
