import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, fmtDateTime } from '../ui.js';

// Misonsiz ishlash: Mison'dan kelayotgan hamma narsa bizning bazada (zaxira) va rejim almashtirgich.
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

export async function render(root) {
  let st = await api('/zaxira');
  const statusBox = el('div', { className: 'stack' });
  const modeBox = el('div', { className: 'mode-pick' });
  const ownBox = el('div', { className: 'stack' });
  const bar = el('div', { className: 'zx-bar' }, el('span'));
  const log = el('p', { className: 'muted small zx-log', role: 'status' });

  const stat = (n, label, sub = '') => el('div', { className: 'guest-stat' }, el('strong', { textContent: n }), el('span', { textContent: label }), sub ? el('small', { className: 'muted', textContent: sub }) : '');

  function paintStatus() {
    const pct = st.imagesTotal ? Math.round((st.imagesStored / st.imagesTotal) * 100) : 0;
    bar.firstChild.style.width = `${st.imagesTotal ? pct : 0}%`;
    statusBox.replaceChildren(
      st.snapshotAt
        ? el('p', { className: 'notice ok-note', textContent: `Oxirgi nusxa: ${fmtDateTime(st.snapshotAt)}. Har soatda o‘zi yangilanadi.` })
        : el('p', { className: 'notice warn', textContent: st.misonConnected ? 'Hali nusxa olinmagan — “Hozir zaxiralash”ni bosing.' : 'Mison ulanmagan — nusxa olib bo‘lmaydi (Kalitlar → Mison).' }),
      st.lastError ? el('p', { className: 'notice warn', textContent: `Oxirgi xato (${fmtDateTime(st.lastErrorAt)}): ${st.lastError}` }) : '',
      el('div', { className: 'guest-stats' },
        stat(st.items, 'taom'), stat(st.categories, 'bo‘lim'), stat(st.tables, 'stol', st.halls ? `${st.halls} zal` : ''),
        stat(`${st.imagesStored}/${st.imagesTotal}`, 'rasm', st.imagesFailed ? `${st.imagesFailed} tasi ochilmadi` : ''),
        stat(st.cheques, 'chek arxivi', st.lastChequeAt ? `oxirgisi ${fmtDateTime(st.lastChequeAt)}` : '')),
      el('div', {}, el('p', { className: 'small muted', textContent: 'Rasmlar nusxasi' }), bar),
      st.paymentTypes.length ? el('p', { className: 'small muted', textContent: `Mison to‘lov turlari: ${st.paymentTypes.map((t) => t.name).join(', ')}` }) : '',
      st.rawBytes ? el('p', { className: 'small muted', textContent: `Mison menyusining xom nusxasi ham saqlangan (${kb(st.rawBytes)}).` }) : '');
  }

  function paintMode() {
    const opt = (mode, title, text) => el('button', {
      type: 'button', className: `mode-opt${st.mode === mode ? ' is-on' : ''}`, ariaPressed: String(st.mode === mode),
      onclick: () => setMode(mode),
    }, el('strong', { textContent: title }), el('span', { textContent: text }));
    modeBox.replaceChildren(
      opt('mison', 'Mison bilan', 'Menyu, narx, stop-list va stollar Mison’dan keladi. Qabul qilingan buyurtma Mison kassasiga tushadi. Hammasining nusxasi bazada saqlanib boradi.'),
      opt('own', 'Misonsiz (o‘zimiz)', 'Menyu va stollar bizning bazadan, admin panelda tahrirlanadi. Mison’ga hech narsa yuborilmaydi, stolni kassa sahifasi yopadi. Mison API o‘chsa ham ishlaydi.'));
  }

  function paintOwn() {
    const o = st.own;
    ownBox.replaceChildren(
      o.items
        ? el('p', { textContent: `O‘z menyumizda ${o.items} ta taom, ${o.categories} ta bo‘lim, ${o.tables} ta stol.${o.importedAt ? ` Mison’dan nusxa: ${fmtDateTime(o.importedAt)}.` : ''}${o.updatedAt ? ` Oxirgi o‘zgarish: ${fmtDateTime(o.updatedAt)}.` : ''}` })
        : el('p', { className: 'muted', textContent: 'O‘z menyumiz hali yo‘q. Mison’dan nusxa oling — keyin “Menyu tahriri”da narx, rasm va taomlarni o‘zgartirasiz.' }),
      el('div', { className: 'row wrap' },
        btn(o.items ? 'Mison’dan qayta nusxa olish' : 'Mison’dan nusxa olish', (e) => {
          if (o.items && !confirm('O‘z menyumizdagi o‘zgarishlar o‘chib, Mison’dagi holat bilan almashtiriladi. Davom etaymi?')) return;
          busy(e.currentTarget, 'Nusxa olinmoqda…', async () => {
            try {
              const r = await api('/own/import', { method: 'POST', body: { menu: true, tables: true } });
              toast(`Nusxa olindi: ${r.items} taom, ${r.categories} bo‘lim, ${r.tables} stol.`);
              st = await api('/zaxira');
              paintOwn();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        }, o.items ? 'btn-ghost' : ''),
        el('a', { className: 'btn btn-ghost', href: '#/menyu-tahrir', textContent: 'Menyu va stollarni tahrirlash →' })));
  }

  async function setMode(mode) {
    if (mode === st.mode) return;
    const msg = mode === 'own'
      ? 'Misonsiz rejimga o‘tilsinmi?\n\n• Menyu va stollar bizning bazadan olinadi (yo‘q bo‘lsa — Mison nusxasidan avtomatik yaratiladi).\n• Qabul qilingan buyurtmalar Mison kassasiga YUBORILMAYDI.\n• Stolni kassa sahifasida “To‘landi — stolni yopish” bilan yopasiz.\n• Fiskal chekni virtual kassa ulanguncha alohida berasiz.'
      : 'Mison rejimiga qaytilsinmi? Menyu va stollar yana Mison’dan keladi, buyurtmalar Mison kassasiga tushadi.';
    if (!confirm(msg)) return;
    try {
      st = await api('/pos-mode', { method: 'PUT', body: { mode } });
      toast(mode === 'own' ? 'Misonsiz rejim yoqildi.' : 'Mison rejimi yoqildi.');
      paintMode();
      paintOwn();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Zaxira bo'lib-bo'lib: har chaqiruv ~7 soniya, rasmlar tugaguncha
  const run = btn('Hozir zaxiralash', (e) => busy(e.currentTarget, 'Zaxiralanmoqda…', async () => {
    let force = true;
    try {
      for (let round = 0; round < 60; round++) {
        const r = await api('/zaxira/run', { method: 'POST', body: { force } });
        force = false;
        st = { ...st, ...r };
        paintStatus();
        log.textContent = `${r.copied ? `+${r.copied} rasm. ` : ''}${r.remaining ? `Yana ${r.remaining} ta rasm…` : 'Tayyor.'}${r.errors.length ? ` ${r.errors[0]}` : ''}`;
        if (!r.remaining) break;
      }
      st = await api('/zaxira');
      paintStatus();
      paintOwn();
      toast('Zaxira tayyor.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  paintStatus();
  paintMode();
  paintOwn();
  root.append(
    pageHead('Misonsiz ishlash', 'Mison’dan kelayotgan menyu, narxlar, rasmlar, stollar, to‘lov turlari va cheklar bizning bazaga saqlanadi. Mison API to‘xtasa ham sayt shu nusxa bilan ishlayveradi.'),
    card('Ishlash rejimi', '', modeBox),
    card('Mison zaxirasi', 'Har soatda o‘zi yangilanadi. Mison ulangan bo‘lsa, istalgan payt qo‘lda ham olasiz.', statusBox, el('div', { className: 'row wrap align-center' }, run, log)),
    card('O‘z menyumiz va stollarimiz', 'Misonsiz rejimda shu ishlatiladi. Mison nusxasidan boshlanadi — ID’lar saqlanadi, shuning uchun stollardagi QR stikerlar o‘zgarmaydi.', ownBox));
}
