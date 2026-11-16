import { $, el, api, formatPrice, phoneHref, applyInfo, modsLine } from './common.js';
import { scannerSupported, openScanner } from './scanner.js';
import { mountPinLogin } from './pinlogin.js';
import { offlineScreen } from './offline.js';
import { setPerms, can, canAny, homeFor } from './perms.js';
import { floorLayout, openTotals, OPEN } from './floor.js';
import { alertNew, soundToggle, newItemsWatcher } from './alerts.js';
import { billCard, qtyText, fmtTime, pctText, STATUS_CLASS } from './bill.js';
import { noteInfo, printButton, printHere, kitchenControl } from './printagent.js';
import { openPos } from './posorder.js';
import { listenPulse, onPulse, withP, nextDelay } from './livepulse.js';

// Kassa paneli.
//   #stollar   — zal bo'yicha stollar (band stol — summasi bilan), tepada: tasdiqlanmagan buyurtmalar va chaqiruvlar
//   #hisob=ID  — stol hisobi: tepada JAMI va "To'landi — stolni yopish", pastda sozlash (foiz, ofitsiant, birlashtirish)
//   #yetkazish — yetkazib berish buyurtmalari
//   #tarix     — yopilgan hisoblar (kunlar bo'yicha)
//   #smena     — smena: ochish, kassaga pul kiritish/olish, X-hisobot, yopish (Z)
// Har bir tugma xodim ruxsatiga qarab ko'rsatiladi (admin → Xodimlar → Ruxsatlar).

const app = $('#app');
let profile = null;
let viewTimer = null;
const live = { items: [], calls: [], loaded: false };
const TABS = ['stollar', 'yetkazish', 'tarix', 'smena', 'sozlamalar', 'hisobot', 'ishhaqi', 'qarzlar'];
let siteInfo = {};
let hallKey = (() => {
  try {
    return localStorage.getItem('oq_kassa_hall') || '';
  } catch {
    return '';
  }
})();
const setHall = (k) => {
  hallKey = k;
  try {
    localStorage.setItem('oq_kassa_hall', k);
  } catch {}
};
const DSTATUS = { kutilmoqda: 'Tayyorlanmoqda', yolda: 'Kuryer yo‘lda', yetkazildi: 'Yetkazildi' };
const state = { histDays: 1 };

const stopView = () => clearTimeout(viewTimer);
const ago = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return min < 1 ? 'hozirgina' : min < 60 ? `${min} daq. oldin` : fmtTime(iso);
};
const whereOf = (o) => (o.mode === 'delivery' ? '🛵 Yetkazib berish' : o.tableLabel || `Stol ${o.table}`);
const addrText = (a) => (a ? [a.text, a.apartment && `xonadon ${a.apartment}`, a.entrance && `${a.entrance}-podyezd`, a.floor && `${a.floor}-qavat`].filter(Boolean).join(', ') : '');
const money = (n) => formatPrice(n).replace(' so‘m', '');

/* ───────── Kuzatuv: yangi buyurtmalar va chaqiruvlar ───────── */
const watch = newItemsWatcher();
const callWatch = newItemsWatcher();
let pollTimer = null;
let onLive = null;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const r = await api(withP('/api/staff/orders?mode=all'));
    if (r.perms) setPerms(r.perms);
    live.items = r.items;
    live.calls = r.calls || [];
    live.loaded = true;
    noteInfo(r.print);
    listenPulse(r.pulse?.url);
    const pending = r.items.filter((o) => o.status === 'yangi');
    watch(pending.map((o) => o.id), (ids) => {
      const first = pending.find((o) => o.id === ids[0]);
      alertNew(ids.length > 1 ? `${ids.length} ta yangi buyurtma` : first?.mode === 'delivery' ? 'Yangi yetkazish buyurtmasi' : 'Yangi buyurtma', first ? whereOf(first).replace('🛵 ', '') : '');
    });
    callWatch(live.calls.map((c) => `${c.tabId}@${c.at}`), (keys) => {
      const c = live.calls.find((x) => `${x.tabId}@${x.at}` === keys[0]);
      if (c) alertNew(c.tableLabel, c.label);
    });
    const n = pending.length + live.calls.length;
    document.title = `${n ? `(${n}) ` : ''}Kassa`;
    const b = $('#kassa-badge');
    b.hidden = !n;
    b.textContent = n;
    onLive?.();
  } catch (e) {
    if (gate(e)) return;
  }
  pollTimer = setTimeout(poll, nextDelay());
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && profile && live.loaded) poll();
});
// "Yurak urishi": buyurtma yoki stol o'zgardi — ro'yxat va ochiq bo'lim darhol yangilanadi
let viewReload = null;
onPulse(() => {
  if (!profile || !live.loaded) return;
  poll();
  viewReload?.();
});
// internet qaytdi — uzilish paytidagi o'zgarishlar darhol ko'rinadi
window.addEventListener('oq:online', () => {
  if (!profile || !live.loaded) return;
  poll();
  viewReload?.();
});

async function acceptQuick(id, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await api(`/api/kassa/orders/${id}/accept`, { method: 'POST', body: '{}' });
    await poll();
    return true;
  } catch (e) {
    if (!gate(e)) alert(e.message);
    btn.disabled = false;
    btn.textContent = 'Qabul';
    return false;
  }
}

/* ───────── Stollar ───────── */
function alertsStrip(onChange) {
  const box = el('div', { className: 'k-alerts' });
  box.paint = () => {
    const pending = live.items.filter((o) => o.status === 'yangi');
    box.replaceChildren(
      ...live.calls.map((c) => el('div', { className: `k-alert is-call is-${c.kind}` },
        el('span', { className: 'k-alert-icon', textContent: c.kind === 'bill' ? '🧾' : '🔔', ariaHidden: 'true' }),
        el('button', { type: 'button', className: 'k-alert-main', onclick: () => (location.hash = `hisob=${c.tabId}`) },
          el('strong', { textContent: c.tableLabel }), el('span', { textContent: `${c.label} · ${ago(c.at)}` })),
        el('button', { type: 'button', className: 'btn btn-small btn-ghost', textContent: 'Ko‘rdim', onclick: async (e) => {
          e.currentTarget.disabled = true;
          await api(`/api/staff/calls/${c.tabId}/ack`, { method: 'POST', body: '{}' }).catch(() => {});
          await poll();
        } }))),
      ...pending.map((o) => {
        const delivery = o.mode === 'delivery';
        const btn = el('button', { type: 'button', className: 'btn btn-small btn-accept', textContent: delivery ? 'To‘lov va qabul' : 'Qabul', hidden: !can('order.accept') });
        btn.addEventListener('click', async () => {
          if (delivery) return viewOrder(o.id);
          if (await acceptQuick(o.id, btn)) onChange?.();
        });
        return el('div', { className: 'k-alert is-new' },
          el('span', { className: 'k-alert-icon', textContent: o.mode === 'delivery' ? '🛵' : '🆕', ariaHidden: 'true' }),
          el('button', { type: 'button', className: 'k-alert-main', onclick: () => viewOrder(o.id) },
            el('strong', { textContent: `#${o.number} · ${whereOf(o).replace('🛵 ', '')}` }),
            el('span', { textContent: `${o.items.slice(0, 2).map((i) => `${qtyText(i)} ${i.name}`).join(', ')}${o.items.length > 2 ? '…' : ''} · ${formatPrice(o.total)} · ${ago(o.createdAt)}` })),
          btn);
      }));
  };
  box.paint();
  return box;
}

async function viewFloor() {
  const box = el('div', { className: 'floor' });
  const stats = el('div', { className: 'staff-stats' });
  const shiftBar = el('div', { className: 'shift-bar', hidden: true });
  const reload = () => load();
  const strip = alertsStrip(reload);
  onLive = () => strip.paint();
  let data = null;
  const newOrder = (t) => (can('order.create') ? openPos({ title: `${t.name} · yangi buyurtma`, target: 'table', tableId: t.id, allowTakeaway: true, onDone: (r) => { poll(); location.hash = `hisob=${r.tabId}`; } }) : alert('Buyurtma kiritishga ruxsatingiz yo‘q.'));
  const tableBtn = (t) => el('button', {
    type: 'button', className: `floor-table${t.tab ? ' is-busy' : ''}${t.tab?.billPrinted ? ' is-billed' : ''}${t.tab?.pending ? ' has-pending' : ''}${t.tab?.kind === 'saboy' ? ' is-saboy' : ''}`,
    onclick: () => (t.tab ? (location.hash = `hisob=${t.tab.id}`) : newOrder(t)),
  },
  el('span', { className: 'floor-name', textContent: `${t.tab?.kind === 'saboy' ? '🥡 ' : ''}${t.name}` }),
  el('span', { className: 'floor-meta', textContent: t.tab ? (t.tab.total ? formatPrice(t.tab.total) : 'tasdiqlanmagan') : '+ buyurtma' }),
  t.tab ? el('span', { className: `floor-waiter${t.tab.waiterName ? '' : ' is-none'}`, textContent: t.tab.waiterName ? `👤 ${t.tab.waiterName}` : 'ofitsiant yo‘q' }) : '',
  t.tab?.billPrinted ? el('span', { className: 'floor-billed', textContent: '🧾 chek chiqdi' }) : '',
  t.tab?.splits ? el('span', { className: 'floor-billed floor-splits', textContent: `✂ +${t.tab.splits} chek` }) : '',
  t.hall && hallKey === OPEN ? el('span', { className: 'floor-hall-tag', textContent: t.hall }) : '',
  t.tab?.pending ? el('span', { className: 'floor-dot', ariaLabel: 'yangi buyurtma bor' }) : '',
  t.tab?.call && !t.tab.call.ack ? el('span', { className: 'floor-bell', textContent: t.tab.call.kind === 'bill' ? '🧾' : '🔔' }) : '');
  function paint() {
    if (!data || !box.isConnected) return;
    const tot = openTotals(data); // sayt hisoblari + Mison kassasida ochilganlari
    // "ochiq stol" bosilsa — faqat band stollar ko'rinadi (qayta bosilsa — oldingi zal)
    const openBtn = el('button', { type: 'button', className: `staff-stat is-link${hallKey === OPEN ? ' is-on' : ''}`, ariaPressed: String(hallKey === OPEN), onclick: () => { setHall(hallKey === OPEN ? (data.halls[0] ? String(data.halls[0].id) : OPEN) : OPEN); paint(); } },
      el('strong', { textContent: tot.count }), el('span', { textContent: tot.mison ? `ochiq stol (${tot.mison} tasi Mison’da) ›` : 'ochiq stol ›' }));
    const stat = (n, label, cls = '') => el('div', { className: `staff-stat ${cls}` }, el('strong', { textContent: n }), el('span', { textContent: label }));
    stats.replaceChildren(openBtn, stat(money(tot.sum), data.mison ? 'ochiq hisoblar (Mison bilan), so‘m' : 'ochiq hisoblar, so‘m'), stat(live.items.filter((o) => o.status === 'yangi').length, 'tasdiqlanmagan', live.items.some((o) => o.status === 'yangi') ? 'is-wait' : ''));
    box.replaceChildren(!data.halls.length && !data.loose.length ? el('p', { className: 'empty-line', textContent: 'Stollar hali kiritilmagan va ochiq hisob yo‘q.' })
      : floorLayout({ data, key: hallKey, tableBtn, onKey: (k) => { setHall(k); paint(); } }));
  }
  async function load() {
    stopView();
    try {
      data = await api(withP('/api/staff/tables'));
    } catch (e) {
      if (gate(e)) return;
      return box.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    if (!box.isConnected) return;
    paint();
    api(withP('/api/kassa/shift?brief=1')).then((r) => paintShiftBar(shiftBar, r)).catch(() => {});
    viewTimer = setTimeout(load, nextDelay());
    viewReload = () => box.isConnected && load();
  }
  const saboyBtn = can('order.create') ? el('button', { type: 'button', className: 'btn', textContent: '🥡 Saboy buyurtma', onclick: () => openPos({ title: 'Saboy (olib ketish)', target: 'saboy', onDone: (r) => { poll(); location.hash = `hisob=${r.tabId}`; } }) }) : '';
  app.replaceChildren(el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Stollar' }), saboyBtn), shiftBar, strip, stats, box);
  box.append(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  await load();
}

// Smena holati (stollar tepasida): ochilmagan bo'lsa — ogohlantirish va "Smena ochish"
function paintShiftBar(bar, r) {
  if (!bar.isConnected) return;
  const c = r.current;
  bar.hidden = false;
  bar.className = `shift-bar${c ? '' : ' is-warn'}`;
  bar.replaceChildren(
    el('span', { textContent: c ? `🟢 Smena #${c.number} · ${fmtTime(c.openedAt)} dan · ${c.openedByName}${c.auto ? ' (o‘zi ochildi)' : ''}` : `⚠️ Smena ochilmagan${r.required ? ' — to‘lov olinmaydi' : ' — birinchi to‘lov smenani o‘zi ochadi'}` }),
    canAny('shift.open', 'shift.close', 'shift.cash', 'reports.view') ? el('a', { className: 'btn btn-small btn-ghost', href: '#smena', textContent: c ? 'Smena' : 'Smena ochish' }) : '');
}

/* ───────── Stol hisobi: hisobni yopish oynasi ─────────
   Yuqorida — asboblar paneli (+ buyurtma, saboy, chegirma, xizmat haqi, ofitsiant, ko'chirish, birlashtirish, ⚙ sozlamalar);
   chapda — barcha ochiq stollar (raqami, zali, ofitsianti, summasi); o'ngda — tanlangan stol buyurtmalari;
   pastda — "Chek chiqarish" (kassa printeri) va "To'lov" (usulni tanlash → tasdiqlash → hisob yopiladi). */
let listHall = '';
let listScroll = 0;
// "Стол 5" → "5", "Стол 5 + Стол 6" → "5+6", saboy → 🥡
// bo'lingan chek: "Стол 5 · 2-chek" → "5/2"
const tableNo = (t) => {
  const n = t.kind === 'saboy' ? '🥡' : String(t.tableLabel || '').replace(/ · \d+-chek$/, '').split(' + ').map((x) => (x.match(/(\d+[a-zA-Zа-яА-Я]?)\s*$/) || [])[1] || x.slice(0, 3)).join('+');
  return t.splitNo ? `${n}/${t.splitNo}` : n;
};
const billedOf = (t) => {
  const last = (t.rounds || []).reduce((m, r) => (r.createdAt > m ? r.createdAt : m), '');
  return Boolean(t.billPrintedAt && t.billPrintedAt >= last);
};
// "Asosiy zal · Стол 5" → "Стол 5" (zal alohida ko'rsatiladi)
const shortLabel = (t) => (t.hall && String(t.tableLabel).startsWith(`${t.hall} · `) ? t.tableLabel.slice(t.hall.length + 3) : t.tableLabel);
const byTable = (a, b) => String(a.hall || '').localeCompare(String(b.hall || ''), 'ru') || String(a.tableLabel).localeCompare(String(b.tableLabel), 'ru', { numeric: true });

// Hisobni bo'lish: qaysi taomdan nechtasi yangi chekka o'tadi (masalan, ikki do'st alohida to'laydi)
function splitBox(tab, act) {
  const rows = tab.rounds.filter((o) => o.status === 'qabul').flatMap((o) => o.items.map((i) => ({ o, i, pick: 0 })));
  const sumEl = el('strong', { className: 'split-sum' });
  const go = el('button', { type: 'button', className: 'btn btn-wide split-go' });
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const paint = () => {
    const sum = rows.reduce((s, r) => s + (r.i.unit === 'kg' ? (r.pick ? r.i.sum : 0) : Math.round((r.i.sum * r.pick) / r.i.qty)), 0);
    const n = rows.filter((r) => r.pick).length;
    sumEl.textContent = formatPrice(sum);
    go.disabled = !n;
    go.textContent = n ? `✂ Yangi chekka o‘tkazish · ${formatPrice(sum)}` : 'Taomlarni tanlang';
  };
  const line = (r) => {
    const qty = el('span', { className: 'split-n' });
    const show = () => {
      qty.textContent = r.i.unit === 'kg' ? (r.pick ? 'hammasi' : '—') : `${r.pick} / ${r.i.qty}`;
      li.classList.toggle('is-on', r.pick > 0);
      paint();
    };
    const step = (d) => {
      r.pick = r.i.unit === 'kg' ? (r.pick ? 0 : 1) : Math.max(0, Math.min(r.i.qty, r.pick + d));
      show();
    };
    const li = el('li', { className: 'split-row' },
      el('span', { className: 'split-name' }, el('strong', { textContent: r.i.name }), el('small', { textContent: `#${r.o.number} · ${qtyText(r.i)} · ${formatPrice(r.i.sum)}` })),
      el('span', { className: 'split-step' },
        el('button', { type: 'button', ariaLabel: 'Kamaytirish', textContent: '−', onclick: () => step(-1) }), qty,
        el('button', { type: 'button', ariaLabel: 'Ko‘paytirish', textContent: '+', onclick: () => step(1) }),
        r.i.unit === 'kg' ? '' : el('button', { type: 'button', className: 'split-all', textContent: 'Hammasi', onclick: () => { r.pick = r.i.qty; show(); } })));
    show();
    return li;
  };
  go.addEventListener('click', () => act(go, 'split', { lines: rows.filter((r) => r.pick).map((r) => ({ orderId: r.o.id, idx: r.i.idx, qty: r.i.unit === 'kg' ? r.i.qty : r.pick })) }, (r) => {
    poll();
    toastDone(`${r.tab.tableLabel} ochildi · ${formatPrice(r.tab.total)}${r.misonOrders ? ' · Mison kassasida ham chekni bo‘ling' : ''}`);
    location.hash = `hisob=${r.tab.id}`;
  }));
  paint();
  return el('div', { className: 'ctl split-box' },
    el('p', { className: 'muted small', textContent: 'Yangi chekka o‘tadigan taomlarni tanlang. Har bir chek alohida to‘lanadi; taomlar qayta pishirilmaydi.' }),
    rows.length ? el('ul', { className: 'split-list' }, rows.map(line)) : el('p', { className: 'k-empty', textContent: 'Qabul qilingan taom yo‘q.' }),
    el('div', { className: 'split-foot' }, el('span', { textContent: 'Yangi chek:' }), sumEl), go, err);
}

function toolDialog(title, body) {
  const dlg = el('dialog', { className: 'k-dlg' },
    el('div', { className: 'k-dlg-head' }, el('h2', { textContent: title }),
      el('button', { type: 'button', className: 'k-dlg-x', ariaLabel: 'Yopish', textContent: '×', onclick: () => dlg.close() })),
    el('div', { className: 'k-dlg-body' }, body));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// eskirgan javob ekranni bosib ketmasligi uchun: har bir ko'rinish o'z raqamini oladi
let renderSeq = 0;
async function viewTab(id) {
  stopView();
  onLive = null;
  const seq = ++renderSeq;
  const oldRows = app.querySelector('.k-rows');
  if (oldRows) listScroll = oldRows.scrollLeft || oldRows.scrollTop;
  let tab;
  let open = [];
  let staff = [];
  let floor = { halls: [] };
  try {
    [{ tab }, { items: open }, { items: staff }, floor] = await Promise.all([api(`/api/kassa/tabs/${encodeURIComponent(id)}`), api('/api/kassa/tabs'), api('/api/kassa/staff'),
      can('tab.move') ? api('/api/staff/tables').catch(() => ({ halls: [] })) : { halls: [] }]);
  } catch (e) {
    if (seq !== renderSeq) return;
    return gate(e) || app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: e.message }), backTo('stollar')));
  }
  if (seq !== renderSeq) return;
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const act = async (btn, path, body, after) => {
    err.hidden = true;
    btn.disabled = true;
    try {
      const r = await api(`/api/kassa/tabs/${tab.id}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
      document.querySelectorAll('dialog.k-dlg[open]').forEach((d) => d.close());
      after ? after(r) : viewTab(tab.id);
    } catch (e) {
      if (gate(e)) return;
      const dErr = btn.closest('dialog')?.querySelector('.form-error');
      (dErr || err).textContent = e.message;
      (dErr || err).hidden = false;
      btn.disabled = false;
    }
  };
  const isOpen = tab.status === 'open';
  const billed = billedOf(tab);
  const pendingRounds = tab.rounds.filter((o) => o.status === 'yangi');

  /* — to'lov — */
  const payRows = [
    ['Taomlar', formatPrice(tab.subtotal)],
    ...(tab.takeaway && tab.kind !== 'saboy' ? [['shundan saboy (foizsiz)', formatPrice(tab.takeaway)]] : []),
    ...(tab.discountAmt ? [[`Chegirma ${tab.discount?.type === 'pct' ? pctText(tab.discount.value) : ''}${tab.discount?.reason ? ` · ${tab.discount.reason}` : ''}`, `−${formatPrice(tab.discountAmt)}`]] : []),
    ...(tab.kind === 'saboy' ? [] : [[`Xizmat haqi ${pctText(tab.servicePct)}`, formatPrice(tab.service)]]),
  ];
  const closeBtn = el('button', { type: 'button', className: 'btn btn-pay' }, el('span', { textContent: '✓ To‘lov' }), el('em', { textContent: formatPrice(tab.total) }));
  closeBtn.addEventListener('click', async () => {
    const pay = await payDialog({ title: tab.tableLabel, total: tab.total, pending: tab.pending });
    if (!pay) return;
    // Click Pass bir necha soniya oladi — tugma holatni ko'rsatadi
    const label = closeBtn.firstChild.textContent;
    if (pay.payment?.qr) closeBtn.firstChild.textContent = '⏳ Click tekshirilmoqda…';
    await act(closeBtn, 'close', pay, (r) => {
      if (r.print?.printed && r.print.self) printHere();
      const change = r.tab.payment?.change ? ` · qaytim ${formatPrice(r.tab.payment.change)}` : '';
      toastDone(`${tab.tableLabel} yopildi · ${formatPrice(tab.total)} · ${r.tab.payment?.label || ''}${change}${r.print?.printed ? ' · chek chiqyapti' : ''}`);
      location.hash = 'stollar';
    });
    closeBtn.firstChild.textContent = label;
  });
  const after = () => {
    poll();
    viewTab(tab.id);
  };

  /* — sozlash oynalari (asboblar panelidan ochiladi) — */
  const ctl = {};
  if (isOpen) {
    const pct = el('input', { id: 'svc-pct', type: 'number', min: 0, max: 50, step: 0.5, value: tab.servicePct, inputMode: 'decimal' });
    const pctBtn = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Qo‘llash' });
    pctBtn.addEventListener('click', () => act(pctBtn, 'service', { pct: Number(pct.value) }));
    const waiter = el('select', { id: 'svc-waiter' }, el('option', { value: '', textContent: '— tanlang —' }),
      staff.map((s) => el('option', { value: s.id, textContent: `${s.name}${s.role === 'cashier' ? ' (kassir)' : ''}`, selected: s.id === tab.waiterId })));
    const wBtn = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Saqlash' });
    wBtn.addEventListener('click', () => waiter.value && act(wBtn, 'waiter', { staffId: waiter.value }));
    const others = open.filter((t) => t.id !== tab.id);
    const src = el('select', { id: 'svc-merge' }, el('option', { value: '', textContent: others.length ? '— stolni tanlang —' : 'boshqa ochiq stol yo‘q' }),
      others.map((t) => el('option', { value: t.id, textContent: `${t.tableLabel} · ${formatPrice(t.total)}` })));
    const mBtn = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Qo‘shish', disabled: !others.length });
    mBtn.addEventListener('click', () => {
      const o = others.find((t) => t.id === src.value);
      if (o && confirm(`${o.tableLabel} hisobi ${tab.tableLabel} hisobiga qo‘shilsinmi? Bitta chek bo‘ladi.`)) act(mBtn, 'merge', { sourceId: o.id });
    });
    // chegirma: foiz yoki summa + sabab
    const dType = el('select', { id: 'disc-type', ariaLabel: 'Chegirma turi' }, el('option', { value: 'pct', textContent: '%' }), el('option', { value: 'sum', textContent: 'so‘m' }));
    const dVal = el('input', { id: 'disc-val', type: 'text', inputMode: 'decimal', placeholder: '10', value: tab.discount ? String(tab.discount.value) : '' });
    const dWhy = el('input', { id: 'disc-why', type: 'text', maxLength: 120, placeholder: 'Sabab: doimiy mijoz, tug‘ilgan kun…', value: tab.discount?.reason || '' });
    if (tab.discount) dType.value = tab.discount.type;
    const dBtn = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Qo‘llash' });
    dBtn.addEventListener('click', () => act(dBtn, 'discount', { type: dType.value, value: dVal.value, reason: dWhy.value }));
    const dOff = tab.discount ? el('button', { type: 'button', className: 'btn-link danger', textContent: 'Chegirmani olib tashlash', onclick: (e) => act(e.currentTarget, 'discount', { type: 'pct', value: 0 }) }) : '';
    // stolni ko'chirish: bo'sh stollar
    const free = (floor.halls || []).flatMap((h) => h.tables.filter((t) => !t.tab).map((t) => ({ ...t, hall: h.name })));
    const mv = el('select', { id: 'svc-move' }, el('option', { value: '', textContent: free.length ? '— bo‘sh stolni tanlang —' : 'bo‘sh stol yo‘q' }),
      free.map((t) => el('option', { value: t.id, textContent: `${t.hall} · ${t.name}` })));
    const mvBtn = el('button', { type: 'button', className: 'btn btn-small', textContent: 'Ko‘chirish', disabled: !free.length });
    mvBtn.addEventListener('click', () => {
      const t = free.find((x) => String(x.id) === mv.value);
      if (t && confirm(`${tab.tableLabel} hisobi ${t.hall} · ${t.name} stoliga ko‘chirilsinmi?`)) {
        act(mvBtn, 'move', { tableId: t.id }, (r) => {
          toastDone(`${r.from} → ${r.tab.tableLabel}${r.misonOrders ? ' · Mison kassasida ham stolni almashtiring' : ''}`);
          viewTab(tab.id);
        });
      }
    });
    const dErr = () => el('p', { className: 'form-error', role: 'alert', hidden: true });
    if (can('tab.discount')) {
      ctl.discount = el('div', { className: 'ctl' }, el('label', { htmlFor: 'disc-val', textContent: 'Foiz yoki summa' }),
        el('div', { className: 'chips quick-chips' }, [5, 10, 15, 20].map((v) => el('button', { type: 'button', textContent: `${v}%`, onclick: () => { dType.value = 'pct'; dVal.value = v; dWhy.focus(); } }))),
        el('div', { className: 'ctl-row' }, dVal, dType), el('div', { className: 'ctl-row' }, dWhy, dBtn), dOff, dErr());
    }
    if (can('tab.service')) {
      ctl.service = el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-pct', textContent: 'Xizmat foizi' }),
        el('div', { className: 'chips quick-chips' }, [0, 10, 12, 15].map((v) => el('button', { type: 'button', textContent: `${v}%`, ariaPressed: String(v === tab.servicePct), onclick: (e) => { pct.value = v; act(e.currentTarget, 'service', { pct: v }); } }))),
        el('div', { className: 'ctl-row' }, pct, pctBtn), dErr());
    }
    if (can('tab.waiter')) ctl.waiter = el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-waiter', textContent: 'Stolga xizmat qiladigan ofitsiant' }), el('div', { className: 'ctl-row' }, waiter, wBtn), dErr());
    if (can('tab.move') && tab.kind !== 'saboy') ctl.move = el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-move', textContent: 'Mijoz boshqa stolga o‘tdi — hisob o‘sha stolga ko‘chadi' }), el('div', { className: 'ctl-row' }, mv, mvBtn), dErr());
    if (can('tab.split')) ctl.split = splitBox(tab, act);
    if (can('tab.merge')) ctl.merge = el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-merge', textContent: 'Boshqa stolni shu hisobga qo‘shish (bitta chek)' }), el('div', { className: 'ctl-row' }, src, mBtn), dErr());
  }

  /* — asboblar paneli — */
  const tool = (icon, label, onclick, { primary = false, back = false, disabled = false, cls = '' } = {}) => el('button', {
    type: 'button', className: `k-tool${primary ? ' is-primary' : ''}${back ? ' is-back' : ''}${cls ? ` ${cls}` : ''}`, disabled, onclick,
  }, el('b', { textContent: icon, ariaHidden: 'true' }), el('span', { textContent: label }));
  const canAdd = isOpen && can('order.create');
  const dlgTool = (key, icon, label, title) => (ctl[key] ? tool(icon, label, () => toolDialog(title, ctl[key]), { cls: `is-${key}` })
    : !isOpen && can(`tab.${key}`) ? tool(icon, label, null, { disabled: true }) : '');
  const toolbar = el('div', { className: 'k-toolbar', role: 'toolbar', ariaLabel: 'Hisob amallari' },
    tool('←', 'Stollar', () => (location.hash = 'stollar'), { back: true }),
    can('order.create') ? tool('+', 'Buyurtma', () => openPos({ title: `${tab.tableLabel} · qo‘shimcha`, target: 'tab', tabId: tab.id, allowTakeaway: tab.kind !== 'saboy', onDone: after }), { primary: true, disabled: !canAdd }) : '',
    can('order.create') && tab.kind !== 'saboy' ? tool('🥡', 'Saboy', () => openPos({ title: `${tab.tableLabel} · saboy`, target: 'tab', tabId: tab.id, takeaway: true, allowTakeaway: true, onDone: after }), { disabled: !canAdd }) : '',
    dlgTool('discount', '%', 'Chegirma', `Chegirma · ${tab.tableLabel}`),
    tab.kind !== 'saboy' ? dlgTool('service', '½', 'Xizmat haqi', `Xizmat haqi · ${tab.tableLabel}`) : '',
    dlgTool('waiter', '👤', 'Ofitsiant', `Ofitsiant · ${tab.tableLabel}`),
    tab.kind !== 'saboy' ? dlgTool('move', '⇄', 'Ko‘chirish', `Stolni ko‘chirish · ${tab.tableLabel}`) : '',
    dlgTool('split', '✂', 'Bo‘lish', `Hisobni bo‘lish · ${tab.tableLabel}`),
    dlgTool('merge', '⧉', 'Birlashtirish', `Stollarni birlashtirish · ${tab.tableLabel}`),
    can('order.void') ? tool('−', 'Olib tashlash', () => voidPicker(tab), { cls: 'is-void', disabled: !isOpen || !tab.rounds.some((o) => o.status === 'qabul' && o.items.length) }) : '',
    can('tab.cancel') ? tool('🗑', 'Chekni o‘chirish', () => cancelTabDialog(tab), { cls: 'is-cancel', disabled: !isOpen }) : '',
    el('span', { className: 'k-tool-gap' }),
    tool('⚙', 'Sozlamalar', () => (location.hash = 'sozlamalar')));

  /* — chap: ochiq stollar — */
  const halls = [...new Set(open.map((t) => t.hall).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  if (listHall && !halls.includes(listHall)) listHall = '';
  const rows = el('ul', { className: 'k-rows', ariaLabel: 'Ochiq stollar' });
  const hallBar = el('div', { className: 'k-halls' });
  const rowOf = (t) => {
    const b = billedOf(t);
    const flags = [
      t.pending ? el('i', { className: 'is-new', textContent: 'yangi' }) : '',
      t.call && !t.call.ack ? el('i', { className: 'is-call', textContent: t.call.kind === 'bill' ? '🧾 hisob' : '🔔' }) : '',
      b ? el('i', { textContent: 'chek ✓' }) : '',
      el('i', { textContent: fmtTime(t.openedAt) }),
    ].filter(Boolean);
    return el('li', {}, el('button', {
      type: 'button', className: `k-row${t.id === tab.id ? ' is-on' : ''}${b ? ' is-billed' : ''}${t.kind === 'saboy' ? ' is-saboy' : ''}`, ...(t.id === tab.id ? { ariaCurrent: 'true' } : {}),
      onclick: () => {
        listScroll = rows.scrollLeft || rows.scrollTop;
        location.hash = `hisob=${t.id}`;
      },
    },
    el('span', { className: 'k-row-no', textContent: tableNo(t) }),
    el('span', { className: 'k-row-main' },
      el('strong', { textContent: shortLabel(t) }),
      el('span', { textContent: [t.hall, t.waiterName ? `👤 ${t.waiterName}` : 'ofitsiant yo‘q'].filter(Boolean).join(' · ') })),
    el('span', { className: 'k-row-side' },
      el('strong', { className: 'k-row-sum', textContent: money(t.total) }),
      el('span', { className: 'k-row-flags' }, ...flags))));
  };
  const paintRows = () => {
    const list = open.filter((t) => !listHall || t.hall === listHall).sort(byTable);
    rows.replaceChildren(...(list.length ? list.map(rowOf) : [el('li', { className: 'k-empty', textContent: 'Bu zalda ochiq stol yo‘q' })]));
    hallBar.replaceChildren(...(halls.length > 1 ? ['', ...halls].map((h) => el('button', { type: 'button', ariaPressed: String(listHall === h), textContent: h || 'Hammasi', onclick: () => { listHall = h; listScroll = 0; paintRows(); } })) : []));
  };
  paintRows();
  const total = open.reduce((s, t) => s + t.total, 0);
  const list = el('aside', { className: 'k-list' },
    el('div', { className: 'k-list-head' }, el('h2', {}, 'Ochiq stollar · ', el('b', { textContent: open.length })), el('span', { className: 'muted small', textContent: formatPrice(total) })),
    hallBar, rows);

  /* — o'ng: tanlangan stol — */
  const printCtl = tab.rounds.some((o) => o.status === 'qabul') && can('bill.print')
    ? printButton({ tabId: tab.id }, { label: '🧾 Chek chiqarish', className: 'btn', local: () => window.print() })
    : el('div', { className: 'k-act-off', textContent: can('bill.print') ? 'Chek — qabul qilingan buyurtma yo‘q' : 'Chek chiqarishga ruxsat yo‘q' });
  const payCtl = isOpen ? (can('tab.pay') ? closeBtn : el('p', { className: 'notice', textContent: 'To‘lov olishga ruxsatingiz yo‘q.' }))
    : el('p', { className: 'notice', textContent: `Yopilgan · ${fmtTime(tab.closedAt)}${tab.closedByName ? ` · ${tab.closedByName}` : ''}${tab.payment ? ` · ${tab.payment.label}${tab.payment.change ? `, qaytim ${formatPrice(tab.payment.change)}` : ''}` : ''}${tab.mergedInto ? ' · boshqa hisobga qo‘shilgan' : ''}` });
  const pay = el('section', { className: 'k-pay' },
    el('header', { className: 'k-pay-head' },
      el('div', { className: `k-pay-badge${!isOpen ? ' is-closed' : tab.kind === 'saboy' ? ' is-saboy' : billed ? ' is-billed' : ''}`, textContent: tableNo(tab) }),
      el('div', { className: 'k-pay-title' },
        el('h1', { textContent: shortLabel(tab) }),
        el('p', { className: 'k-pay-meta' },
          tab.hall ? el('span', { textContent: tab.hall }) : '',
          el('span', { className: `is-waiter${tab.waiterName ? '' : ' is-none'}`, textContent: tab.waiterName ? `👤 ${tab.waiterName}` : 'ofitsiant biriktirilmagan' }),
          el('span', { textContent: `🕒 ${fmtTime(tab.openedAt)} dan` }),
          el('span', { textContent: `${tab.customerName || (tab.kind === 'saboy' ? 'Olib ketish' : 'Mijoz (QR’siz)')}${tab.customerPhone ? ` · ${tab.customerPhone}` : ''}` }),
          tab.billPrintedAt ? el('span', { textContent: `🧾 chek ${fmtTime(tab.billPrintedAt)}` }) : ''))),
    pendingRounds.length ? el('div', { className: 'k-pending' },
      el('p', { textContent: `Tasdiqlanmagan: ${pendingRounds.length} ta · ${formatPrice(tab.pending)} (jamiga kirmagan)` }),
      ...pendingRounds.map((o) => {
        const b = el('button', { type: 'button', className: 'btn btn-small btn-accept', textContent: `#${o.number} qabul` });
        b.addEventListener('click', async () => { if (await acceptQuick(o.id, b)) viewTab(tab.id); });
        return b;
      })) : '',
    el('div', { className: 'k-bill print-area' },
      el('div', { className: 'print-only' }, el('h2', { textContent: tab.tableLabel }), el('p', { textContent: new Date().toLocaleString('ru-RU') })),
      tab.rounds.length ? billCard(tab, { onRound: (o) => viewOrder(o.id, () => viewTab(tab.id)) }) : el('p', { className: 'k-empty', textContent: 'Hali buyurtma yo‘q — “+ Buyurtma” bilan qo‘shing.' })),
    el('footer', { className: 'k-foot' },
      el('dl', { className: 'k-pay-rows' }, payRows.map(([a, b]) => el('div', {}, el('dt', { textContent: a }), el('dd', { textContent: b })))),
      el('div', { className: 'k-total' }, el('span', { textContent: 'JAMI' }), el('strong', { textContent: formatPrice(tab.total) })),
      err,
      el('div', { className: 'k-actions' }, printCtl, payCtl)));

  app.replaceChildren(el('div', { className: 'k-screen' }, toolbar, el('div', { className: 'k-split' }, list, pay)));
  if (rows.scrollWidth > rows.clientWidth) rows.scrollLeft = listScroll;
  else rows.scrollTop = listScroll;
  const on = rows.querySelector('.is-on');
  if (on) {
    const r = on.getBoundingClientRect();
    const box = rows.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom || r.left < box.left || r.right > box.right) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // boshqa kassa yoki ofitsiant o'zgartirsa — ochiq oyna yo'q bo'lsa darhol yangilanadi
  viewReload = () => {
    if (pay.isConnected && !document.querySelector('dialog[open]')) viewTab(tab.id);
  };
}

/* ───────── Davr tanlash (hisobot va ish haqi) ───────── */
const RANGES = [['bugun', 'Bugun', 0, 0], ['kecha', 'Kecha', 1, 1], ['7', '7 kun', 6, 0], ['30', '30 kun', 29, 0]];
const tday = (n) => new Date(Date.now() + 5 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
const rangeQuery = (k) => {
  const r = RANGES.find((x) => x[0] === k) || RANGES[0];
  return `from=${tday(r[2])}&to=${tday(r[3])}`;
};
const rangeChips = (cur, on) => el('div', { className: 'chips k-range', role: 'group', ariaLabel: 'Davr' },
  RANGES.map(([k, label]) => el('button', { type: 'button', ariaPressed: String(cur === k), textContent: label, onclick: () => on(k) })));
const repSection = (title, ...body) => el('section', { className: 'k-rep-card' }, el('h2', { textContent: title }), ...body);
// gorizontal ustunlar: nomi, ustun, qiymati (bitta rang — miqdor)
function hbars(list, { value, label, sub }) {
  if (!list.length) return el('p', { className: 'muted', textContent: 'Bu davrda ma’lumot yo‘q.' });
  const max = Math.max(1, ...list.map(value));
  return el('ul', { className: 'k-bars' }, list.map((x) => {
    const bar = el('i');
    bar.style.width = `${Math.max(2, Math.round((value(x) / max) * 100))}%`;
    return el('li', {},
      el('span', { className: 'k-bar-label' }, el('b', { textContent: label(x) }), sub ? el('small', { textContent: sub(x) }) : ''),
      el('span', { className: 'k-bar', ariaHidden: 'true' }, bar),
      el('strong', { textContent: money(value(x)) }));
  }));
}

/* ───────── Savdo hisoboti ───────── */
let repRange = 'bugun';
async function viewReport() {
  const box = el('div', { className: 'k-rep' }, el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  const chips = el('div');
  app.replaceChildren(el('div', { className: 'k-set' },
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Savdo hisoboti' }), backTo('sozlamalar')), chips, box));
  const load = async () => {
    chips.replaceChildren(rangeChips(repRange, (k) => {
      repRange = k;
      load();
    }));
    let r;
    try {
      r = await api(`/api/kassa/report?${rangeQuery(repRange)}`);
    } catch (e) {
      if (gate(e)) return;
      return box.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    if (!box.isConnected) return;
    const t = r.totals;
    const stat = (v, label, cls = '') => el('div', { className: `staff-stat ${cls}` }, el('strong', { textContent: v }), el('span', { textContent: label }));
    const hours = r.byHour.filter((h) => h.revenue);
    box.replaceChildren(
      el('div', { className: 'staff-stats k-rep-stats' },
        stat(money(r.payments.reduce((a, p) => a + p.amount, 0)), 'kassaga tushdi, so‘m', 'is-main'),
        stat(money(t.revenue), 'taomlar savdosi, so‘m'), stat(t.cheques, 'buyurtma'), stat(money(t.avg), 'o‘rtacha buyurtma, so‘m'),
        stat(money(t.service), 'xizmat haqi, so‘m'), stat(t.cancelled ? `${t.cancelled} · ${money(t.cancelledSum)}` : '0', 'bekor qilingan')),
      el('div', { className: 'k-rep-grid' },
        repSection('To‘lov turlari', hbars(r.payments, { value: (p) => p.amount, label: (p) => p.name, sub: (p) => `${p.count} ta chek` })),
        repSection('Ofitsiantlar', hbars(r.waiters, { value: (w) => w.revenue, label: (w) => w.name, sub: (w) => `${w.cheques} ta · o‘rtacha ${money(w.avg)}` })),
        repSection('Eng ko‘p sotilgan taomlar', hbars(r.products, { value: (x) => x.sum, label: (x) => x.name, sub: (x) => `${String(x.qty).replace('.', ',')} ta${x.category ? ` · ${x.category}` : ''}` })),
        repSection('Soatlar bo‘yicha', hbars(hours, { value: (h) => h.revenue, label: (h) => h.label, sub: (h) => `${h.cheques} ta` })),
        r.types.length > 1 ? repSection('Buyurtma turi', hbars(r.types, { value: (x) => x.revenue, label: (x) => x.name, sub: (x) => `${x.cheques} ta` })) : ''));
  };
  await load();
}

/* ───────── Xodimlar ish haqi ───────── */
let wageRange = 'bugun';
const rateText = (r) => [r.daily ? `${money(r.daily)}/kun` : '', r.pct ? `${pctText(r.pct)} ${r.base === 'sales' ? 'savdodan' : 'xizmat haqidan'}` : '', r.perDelivery ? `${money(r.perDelivery)}/yetkazish` : ''].filter(Boolean).join(' + ') || 'stavka yo‘q';
async function viewWages() {
  const box = el('div', { className: 'k-rep' }, el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  const chips = el('div');
  let last = null;
  const edit = can('wages.manage') ? el('button', { type: 'button', className: 'btn btn-ghost', textContent: '✎ Stavkalar', onclick: () => ratesDialog(last?.rows || [], load) }) : '';
  app.replaceChildren(el('div', { className: 'k-set' },
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Xodimlar ish haqi' }), el('div', { className: 'row' }, edit, backTo('sozlamalar'))), chips, box));
  async function load() {
    chips.replaceChildren(rangeChips(wageRange, (k) => {
      wageRange = k;
      load();
    }));
    let r;
    try {
      r = await api(`/api/kassa/wages?${rangeQuery(wageRange)}`);
    } catch (e) {
      if (gate(e)) return;
      return box.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    if (!box.isConnected) return;
    last = r;
    const work = (x) => [x.tabs ? `${x.tabs} stol` : '', x.orders ? `${x.orders} buyurtma` : '', x.closed ? `${x.closed} chek yopdi` : '', x.deliveries ? `${x.deliveries} yetkazish` : ''].filter(Boolean).join(' · ') || '—';
    box.replaceChildren(
      r.unset ? el('p', { className: 'notice', textContent: `${r.unset} ta xodimga stavka belgilanmagan${can('wages.manage') ? ' — “✎ Stavkalar”dan kiriting.' : ' — admin yoki menejer kiritadi.'}` }) : '',
      el('div', { className: 'om-table-wrap' }, el('table', { className: 'om-table k-wage-table' },
        el('thead', {}, el('tr', {}, ...['Xodim', 'Kun', 'Ish', 'Savdo', 'Xizmat haqi', 'Stavka', 'Hisoblangan'].map((h, i) => el('th', { className: i >= 3 && i !== 5 ? 'num' : '', textContent: h })))),
        el('tbody', {}, r.rows.map((x) => el('tr', { className: x.earned ? '' : 'is-zero' },
          el('td', {}, el('b', { textContent: x.name }), el('small', { textContent: x.roleLabel || '' })),
          el('td', { className: 'num', textContent: x.days }),
          el('td', { textContent: work(x) }),
          el('td', { className: 'num', textContent: money(x.sales) }),
          el('td', { className: 'num', textContent: money(x.service) }),
          el('td', {}, el('span', { textContent: rateText(x.rate) }), x.ownRate ? el('small', { textContent: 'alohida' }) : ''),
          el('td', { className: 'num k-earned', textContent: money(x.earned) })))),
        el('tfoot', {}, el('tr', {}, el('td', { colSpan: 6, textContent: `Jami · ${r.range.from === r.range.to ? r.range.from : `${r.range.from} — ${r.range.to}`}` }), el('td', { className: 'num k-earned', textContent: formatPrice(r.total) })))) ),
      el('p', { className: 'muted small', textContent: 'Ishlagan kun — xodim buyurtma yozgan/qabul qilgan, stolga xizmat qilgan, chek yopgan yoki yetkazgan kun. Xizmat haqi — o‘sha xodim stollaridagi “obslujivanie”.' }));
  }
  await load();
}

// Stavkalar: lavozim bo'yicha standart va alohida xodimlar
async function ratesDialog(rows, onSaved) {
  let rates;
  try {
    rates = await api('/api/kassa/wages/rates');
  } catch (e) {
    return alert(e.message);
  }
  const ROLES = [['waiter', 'Ofitsiant'], ['cashier', 'Kassir'], ['courier', 'Kuryer'], ['storekeeper', 'Omborchi']];
  const rateRow = (r, { courier = false } = {}) => {
    const daily = el('input', { type: 'text', inputMode: 'numeric', value: r.daily || '', placeholder: '0', ariaLabel: 'Kunlik, so‘m' });
    const pct = el('input', { type: 'text', inputMode: 'decimal', value: r.pct || '', placeholder: '0', ariaLabel: 'Foiz' });
    const base = el('select', { ariaLabel: 'Foiz nimadan' }, el('option', { value: 'service', textContent: 'xizmat haqidan' }), el('option', { value: 'sales', textContent: 'savdodan' }));
    base.value = r.base || 'service';
    const per = el('input', { type: 'text', inputMode: 'numeric', value: r.perDelivery || '', placeholder: '0', ariaLabel: 'Har yetkazish, so‘m' });
    const node = el('div', { className: 'k-rate' },
      el('label', {}, el('span', { textContent: 'Kunlik, so‘m' }), daily),
      el('label', {}, el('span', { textContent: 'Foiz, %' }), pct),
      el('label', {}, el('span', { textContent: 'Foiz nimadan' }), base),
      courier ? el('label', {}, el('span', { textContent: 'Har yetkazish, so‘m' }), per) : '');
    node.value = () => ({ daily: daily.value, pct: pct.value, base: base.value, perDelivery: courier ? per.value : 0 });
    return node;
  };
  const roleRows = ROLES.map(([k, label]) => ({ k, label, node: rateRow(rates.roles[k] || {}, { courier: k === 'courier' }) }));
  const staffRows = rows.filter((x) => x.role).map((x) => {
    const own = rates.staff[x.id];
    const on = el('input', { type: 'checkbox', className: 'switch', checked: Boolean(own) });
    const node = rateRow(own || rates.roles[x.role] || {}, { courier: x.role === 'courier' });
    node.hidden = !own;
    on.addEventListener('change', () => (node.hidden = !on.checked));
    return { x, on, node };
  });
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const save = el('button', { type: 'button', className: 'btn btn-wide', textContent: 'Saqlash' });
  const body = el('div', { className: 'k-rates' },
    el('h3', { textContent: 'Lavozim bo‘yicha (hamma uchun)' }),
    ...roleRows.map((r) => el('div', { className: 'k-rate-block' }, el('b', { textContent: r.label }), r.node)),
    staffRows.length ? el('h3', { textContent: 'Alohida stavka (xodimga)' }) : '',
    ...staffRows.map((r) => el('div', { className: 'k-rate-block' },
      el('label', { className: 'toggle' }, r.on, el('span', {}, el('b', { textContent: r.x.name }), ` · ${r.x.roleLabel}`)), r.node)),
    err, save);
  const dlg = toolDialog('Ish haqi stavkalari', body);
  save.addEventListener('click', async () => {
    save.disabled = true;
    err.hidden = true;
    try {
      await api('/api/kassa/wages/rates', { method: 'PUT', body: JSON.stringify({
        roles: Object.fromEntries(roleRows.map((r) => [r.k, r.node.value()])),
        staff: Object.fromEntries(staffRows.map((r) => [r.x.id, r.on.checked ? r.node.value() : null])),
      }) });
      dlg.close();
      onSaved();
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      save.disabled = false;
    }
  });
}

/* ───────── Kassa sozlamalari (⚙) ───────── */
function viewSettings() {
  const tile = (icon, title, text, href, on) => el(href ? 'a' : 'button', { className: 'k-set-tile', ...(href ? { href } : { type: 'button', onclick: on }) },
    el('b', { textContent: icon, ariaHidden: 'true' }), el('strong', { textContent: title }), el('span', { textContent: text }));
  const tiles = [
    canAny('shift.open', 'shift.close', 'shift.cash', 'reports.view') ? tile('🧮', 'Smena va hisobot', 'Smenani ochish/yopish, X va Z hisobot, kassaga pul kiritish va olish', '#smena') : '',
    can('tab.history') ? tile('📜', 'Yopilgan cheklar', 'Bugungi va oldingi kunlardagi to‘langan hisoblar', '#tarix') : '',
    can('reports.view') ? tile('📊', 'Savdo hisoboti', 'Bugun, kecha, hafta, oy: to‘lov turlari, ofitsiantlar, eng ko‘p sotilgan taomlar, soatlar', '#hisobot') : '',
    can('debt.collect') ? tile('📒', 'Qarzlar', 'Kim qancha qarz: ro‘yxat, qidiruv va qarz to‘lovini olish', '#qarzlar') : '',
    can('wages.view') ? tile('💰', 'Xodimlar ish haqi', 'Ishlagan kunlar, xizmat foizi ulushi, kuryer yetkazishlari — kim qancha oladi', '#ishhaqi') : '',
    can('delivery.manage') ? tile('🛵', 'Yetkazib berish', 'Yetkazish buyurtmalari: to‘lov, kuryer, holat', '#yetkazish') : '',
    tile('🔁', 'Boshqa xodim kirishi', 'Smenani topshirish: hozirgi xodim chiqadi, keyingisi PIN bilan kiradi', '', logout),
  ].filter(Boolean);
  app.replaceChildren(el('div', { className: 'k-set' },
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Kassa sozlamalari' }), backTo('stollar')),
    el('div', { className: 'k-set-grid' }, ...tiles)));
}

// 📒 Qarzlar: ochiq/yopilgan qarzlar, qidiruv (ism yoki telefon), qarz to'lovini olish
const DEBT_FILTERS = [['open', 'Ochiq'], ['closed', 'Yopilgan'], ['all', 'Hammasi']];
let debtFilter = 'open';
function viewDebts() {
  const seq = renderSeq;
  const q = el('input', { type: 'search', id: 'debt-search', className: 'search-input', placeholder: 'Ism yoki telefon', autocomplete: 'off' });
  const sum = el('div', { className: 'debt-sum' });
  const list = el('div', { className: 'debt-list' }, el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  const chips = el('div', { className: 'chips range-chips' });
  const paintChips = () => chips.replaceChildren(...DEBT_FILTERS.map(([k, label]) => el('button', { type: 'button', className: debtFilter === k ? 'is-on' : '', ariaPressed: String(debtFilter === k), textContent: label, onclick: () => { debtFilter = k; paintChips(); load(); } })));
  paintChips();
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  async function load() {
    let r;
    try {
      r = await api(`/api/kassa/debts?status=${debtFilter}&q=${encodeURIComponent(q.value.trim())}`);
    } catch (e) {
      if (gate(e)) return;
      return list.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    if (seq !== renderSeq) return;
    sum.replaceChildren(
      el('div', { className: 'staff-stat is-wait' }, el('strong', { textContent: money(r.total.left) }), el('span', { textContent: 'jami ochiq qarz, so‘m' })),
      el('div', { className: 'staff-stat' }, el('strong', { textContent: r.total.count }), el('span', { textContent: 'qarzdor' })));
    list.replaceChildren(...(r.items.length ? r.items.map((d) => el('article', { className: `debt-row${d.status === 'closed' ? ' is-closed' : ''}` },
      el('div', { className: 'debt-main' },
        el('strong', { className: 'debt-name', textContent: d.name }),
        el('a', { className: 'debt-phone', href: phoneHref(d.phone), textContent: d.phone }),
        el('span', { className: 'muted small', textContent: `${d.source.label || ''} · ${fmtTime(d.createdAt)} · ${d.byName}` }),
        d.payments.length ? el('details', { className: 'debt-hist' }, el('summary', { textContent: `To‘lovlar · ${d.payments.length}` }),
          el('ul', {}, d.payments.map((p) => el('li', { textContent: `${fmtTime(p.at)} · ${p.label} · ${formatPrice(p.amount)} · ${p.byName}` })))) : ''),
      el('div', { className: 'debt-side' },
        el('strong', { className: 'debt-amount', textContent: d.status === 'closed' ? '✓ To‘langan' : formatPrice(d.left) }),
        el('span', { className: 'muted small', textContent: d.paid ? `${formatPrice(d.amount)} dan ${formatPrice(d.paid)} to‘landi` : `qarz ${formatPrice(d.amount)}` }),
        d.status === 'open' ? el('button', { type: 'button', className: 'btn btn-pay debt-pay', textContent: 'To‘lash', onclick: async () => {
          const res = await debtPayDialog(d);
          if (res) {
            toastDone(`${d.name}: ${formatPrice(res.amount)} qabul qilindi${res.debt.left ? ` · qoldi ${formatPrice(res.debt.left)}` : ' · qarz yopildi'}${res.change ? ` · qaytim ${formatPrice(res.change)}` : ''}`);
            load();
          }
        } }) : '')))
      : [el('p', { className: 'k-empty', textContent: debtFilter === 'open' ? 'Ochiq qarz yo‘q.' : 'Topilmadi.' })]));
  }
  app.replaceChildren(el('div', { className: 'k-set debt-view' },
    el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Qarzlar' }), backTo('sozlamalar')),
    el('div', { className: 'staff-stats' }, sum), el('div', { className: 'debt-tools' }, q, chips), list));
  load();
}

// Qarz to'lovi: summa (bo'lib ham) va to'lov turi; naqdda qaytim
async function debtPayDialog(d) {
  const list = (await payMethods()).filter((m) => m.kind !== 'click' || !clickPassOn);
  return new Promise((resolve) => {
    let method = list[0]?.key || 'naqd';
    const dlg = el('dialog', { className: 'pay-dialog' });
    const amount = el('input', { type: 'text', id: 'debtpay-amount', inputMode: 'numeric', value: String(d.left), autocomplete: 'off' });
    const given = el('input', { type: 'text', id: 'debtpay-given', inputMode: 'numeric', value: '', placeholder: 'aniq', autocomplete: 'off' });
    const err = el('p', { className: 'form-error', hidden: true });
    const num = (x) => Math.round(Number(String(x.value).replace(/\s/g, '')) || 0);
    const cash = el('label', { className: 'pay-row' }, el('span', { textContent: 'Berildi' }), given);
    const methods = el('div', { className: 'pay-methods' });
    const paint = () => {
      methods.replaceChildren(...list.map((m) => el('button', { type: 'button', className: `pay-method${method === m.key ? ' is-on' : ''}`, ariaPressed: String(method === m.key), textContent: `${METHOD_ICON[m.kind] || ''}${m.label}`, onclick: () => { method = m.key; paint(); } })));
      cash.hidden = method !== 'naqd';
    };
    paint();
    const done = (v) => {
      resolve(v);
      dlg.close();
    };
    const ok = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: '✓ Qabul qilish' });
    ok.addEventListener('click', async () => {
      const a = num(amount);
      if (!a || a > d.left) {
        err.textContent = `Summa 1 dan ${formatPrice(d.left)} gacha bo‘lsin.`;
        err.hidden = false;
        return;
      }
      ok.disabled = true;
      try {
        const r = await api(`/api/kassa/debts/${d.id}/pay`, { method: 'POST', body: JSON.stringify({ amount: a, method, received: method === 'naqd' && given.value.trim() ? num(given) : a }) });
        done({ ...r, amount: a });
      } catch (e) {
        ok.disabled = false;
        if (gate(e)) return done(null);
        err.textContent = e.message;
        err.hidden = false;
      }
    });
    dlg.append(
      el('h2', { textContent: `Qarz to‘lovi · ${d.name}` }),
      el('div', { className: 'k-total' }, el('span', { textContent: 'QARZ' }), el('strong', { textContent: formatPrice(d.left) })),
      el('p', { className: 'muted small', textContent: `${d.phone} · ${d.source.label || ''} · ${fmtTime(d.createdAt)}` }),
      el('label', { className: 'pay-row' }, el('span', { textContent: 'To‘laydi' }), amount),
      el('div', { className: 'chips quick-chips' }, el('button', { type: 'button', textContent: 'Hammasi', onclick: () => { amount.value = String(d.left); } }),
        d.left > 2000 ? el('button', { type: 'button', textContent: 'Yarmi', onclick: () => { amount.value = String(Math.round(d.left / 2000) * 1000); } }) : ''),
      methods, cash, err,
      el('div', { className: 'row' }, ok, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Bekor', onclick: () => done(null) })));
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(null);
    });
    document.body.append(dlg);
    dlg.showModal();
    setTimeout(() => amount.select(), 50);
  });
}

// To'lov: turi (admin yoqqan: naqd, karta, Click, Payme, Uzum, Humo...), naqdda berilgan pul va qaytim, to'lov cheki
//   payDialog({ title, total, pending, note }) → { payment: { method, received }, print } | null
let methodsCache = null;
let clickPassOn = false;
async function payMethods() {
  if (!methodsCache) {
    methodsCache = api('/api/kassa/payments').then((r) => {
      clickPassOn = Boolean(r.clickPass);
      return r.items;
    }).catch(() => [{ key: 'naqd', label: 'Naqd', kind: 'cash' }, { key: 'karta', label: 'Karta', kind: 'card' }]);
  }
  return methodsCache;
}
const METHOD_ICON = { cash: '💵 ', card: '💳 ' };
async function payDialog({ title, total, pending = 0, note = '' }) {
  const list = await payMethods();
  return new Promise((resolve) => {
    let method = list[0]?.key || 'naqd';
    const dlg = el('dialog', { className: 'pay-dialog' });
    const received = el('input', { type: 'text', inputMode: 'numeric', className: 'pay-received', value: String(total), ariaLabel: 'Berilgan pul' });
    const change = el('strong', { className: 'pay-change' });
    const err = el('p', { className: 'form-error', hidden: true });
    const printCb = el('input', { type: 'checkbox', className: 'switch', checked: true });
    const val = () => Math.round(Number(received.value.replace(/\s/g, '')) || 0);
    const cashBox = el('div', { className: 'pay-cash' });
    const isCash = () => method === 'naqd';
    // Click Pass: mijoz Click ilovasidagi QR'ni ko'rsatadi — skaner (klaviatura kabi) kodni yozib Enter bosadi
    const kindOf = () => list.find((m) => m.key === method)?.kind;
    const qr = el('input', { type: 'text', className: 'pay-qr', autocomplete: 'off', spellcheck: false, placeholder: 'Skaner shu yerga yozadi…', ariaLabel: 'Click QR kodi' });
    // 📒 Qarz: hammasi yoki bir qismi qarzga (ism + telefon); qolgan qismi tanlangan turda hozir to'lanadi
    let debtOn = false;
    const dName = el('input', { type: 'text', id: 'debt-name', maxLength: 60, autocomplete: 'off', placeholder: 'Ism familiya' });
    const dPhone = el('input', { type: 'tel', id: 'debt-phone', inputMode: 'tel', maxLength: 20, autocomplete: 'off', placeholder: '+998 90 123 45 67' });
    const dPaid = el('input', { type: 'text', id: 'debt-paid', inputMode: 'numeric', value: '0', autocomplete: 'off' });
    const dLeft = el('strong', { className: 'debt-left' });
    const dInfo = el('p', { className: 'notice warn debt-info', hidden: true });
    const paidVal = () => Math.max(0, Math.round(Number(dPaid.value.replace(/\s/g, '')) || 0));
    const paintDebt = () => {
      const left = total - paidVal();
      dLeft.textContent = left > 0 ? formatPrice(left) : '—';
      dLeft.classList.toggle('is-bad', left <= 0);
      methods.classList.toggle('is-dim', debtOn && !paidVal());
      ok.textContent = debtOn ? (paidVal() ? `📒 ${formatPrice(paidVal())} to‘landi, qolgani qarzga` : '📒 Hammasini qarzga yozish') : '✓ To‘landi';
    };
    dPaid.addEventListener('input', paintDebt);
    let lastPhone = '';
    const lookPhone = async () => {
      const digits = dPhone.value.replace(/\D/g, '');
      if (digits.length < 9 || digits === lastPhone) return;
      lastPhone = digits;
      try {
        const r = await api(`/api/kassa/debts/phone?phone=${encodeURIComponent(dPhone.value)}`);
        dInfo.hidden = !r.count;
        dInfo.textContent = r.count ? `Bu raqamda ochiq qarz bor: ${formatPrice(r.left)} (${r.count} ta)${r.name ? ` — ${r.name}` : ''}` : '';
        if (r.name && !dName.value.trim()) dName.value = r.name;
      } catch {}
    };
    dPhone.addEventListener('input', lookPhone);
    const debtBox = el('div', { className: 'pay-debt', hidden: true },
      el('label', { className: 'debt-field' }, el('span', { textContent: 'Telefon' }), dPhone),
      el('label', { className: 'debt-field' }, el('span', { textContent: 'Ism' }), dName),
      dInfo,
      el('label', { className: 'debt-field' }, el('span', { textContent: 'Hozir to‘laydi' }), dPaid),
      el('div', { className: 'debt-field is-left' }, el('span', { textContent: 'Qarzga qoladi' }), dLeft),
      el('div', { className: 'chips quick-chips' },
        el('button', { type: 'button', textContent: 'Hammasi qarzga', onclick: () => { dPaid.value = '0'; paintDebt(); } }),
        el('button', { type: 'button', textContent: 'Yarmi', onclick: () => { dPaid.value = String(Math.round(total / 2000) * 1000); paintDebt(); } })));
    const debtBtn = can('tab.debt') && total > 0 ? el('button', { type: 'button', className: 'pay-debt-toggle', ariaPressed: 'false', textContent: '📒 Qarzga yozish' }) : null;
    debtBtn?.addEventListener('click', () => {
      debtOn = !debtOn;
      debtBtn.ariaPressed = String(debtOn);
      debtBtn.classList.toggle('is-on', debtOn);
      debtBtn.textContent = debtOn ? '✕ Qarzsiz to‘lash' : '📒 Qarzga yozish';
      debtBox.hidden = !debtOn;
      err.hidden = true;
      paintKind();
      paintDebt();
      if (debtOn) setTimeout(() => dPhone.focus(), 30);
    });
    const qrBox = el('div', { className: 'pay-qr-box' },
      el('div', { className: 'pay-qr-head' }, el('b', { textContent: '📷 Mijozning Click QR kodini skanerlang' }),
        el('span', { className: 'muted small', textContent: 'Click ilovasi → “Click Pass” → QR. Pul shu zahoti yechiladi.' })),
      el('div', { className: 'pay-qr-row' }, qr,
        scannerSupported() ? el('button', { type: 'button', className: 'btn btn-ghost', textContent: '📷 Kamera', onclick: () => openScanner((text) => {
          qr.value = String(text || '').trim();
          if (qr.value.length >= 6) done({ payment: { method, qr: qr.value }, print: printCb.checked });
        }) }) : ''));
    qr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (qr.value.trim().length < 6) return;
      done({ payment: { method, qr: qr.value.trim() }, print: printCb.checked });
    });
    const paintKind = () => {
      cashBox.hidden = !isCash() || debtOn;
      qrBox.hidden = debtOn || !(clickPassOn && kindOf() === 'click');
      if (!qrBox.hidden) setTimeout(() => qr.focus(), 30);
    };
    const paintChange = () => {
      const c = val() - total;
      change.textContent = c >= 0 ? formatPrice(c) : `yetmaydi ${formatPrice(-c)}`;
      change.classList.toggle('is-bad', c < 0);
    };
    received.addEventListener('input', paintChange);
    const ups = [...new Set([total, ...[10000, 50000, 100000].map((r) => Math.ceil(total / r) * r), Math.ceil(total / 100000) * 100000 + 100000])].filter((v) => v >= total).slice(0, 4);
    cashBox.append(
      el('label', { className: 'pay-row' }, el('span', { textContent: 'Berildi' }), received),
      el('div', { className: 'chips quick-chips' }, ups.map((v) => el('button', { type: 'button', textContent: v === total ? 'Aniq' : money(v), onclick: () => { received.value = String(v); paintChange(); } }))),
      el('div', { className: 'pay-row' }, el('span', { textContent: 'Qaytim' }), change));
    const methods = el('div', { className: 'pay-methods' });
    let ok = null;
    const paintMethods = () => {
      methods.replaceChildren(...list.map((m) => el('button', { type: 'button', className: `pay-method${method === m.key ? ' is-on' : ''}`, ariaPressed: String(method === m.key), textContent: `${METHOD_ICON[m.kind] || ''}${m.label}`, onclick: () => { method = m.key; paintMethods(); paintKind(); } })));
    };
    const done = (v) => {
      resolve(v);
      dlg.close();
    };
    ok = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: '✓ To‘landi' });
    paintMethods();
    paintKind();
    paintChange();
    ok.addEventListener('click', () => {
      if (debtOn) {
        const bad = dPhone.value.replace(/\D/g, '').length < 9 ? 'Telefon raqamini to‘liq yozing.' : dName.value.trim().length < 2 ? 'Qarzdorning ismini yozing.' : paidVal() >= total ? 'Hammasi to‘lansa — “Qarzsiz to‘lash”ni tanlang.' : '';
        if (bad) {
          err.textContent = bad;
          err.hidden = false;
          return;
        }
        return done({ payment: { method, debt: { name: dName.value.trim(), phone: dPhone.value, paid: paidVal() } }, print: printCb.checked });
      }
      if (isCash() && val() < total) {
        err.textContent = 'Berilgan pul jamidan kam.';
        err.hidden = false;
        return;
      }
      done({ payment: { method, received: isCash() ? val() : total }, print: printCb.checked });
    });
    dlg.append(
      el('h2', { textContent: `To‘lov · ${title}` }),
      el('div', { className: 'k-total' }, el('span', { textContent: 'JAMI' }), el('strong', { textContent: formatPrice(total) })),
      pending ? el('p', { className: 'notice', textContent: `Tasdiqlanmagan ${formatPrice(pending)} bekor qilinadi.` }) : '',
      note ? el('p', { className: 'muted small', textContent: note }) : '',
      methods, cashBox, qrBox, debtBtn || '', debtBox,
      el('label', { className: 'toggle' }, printCb, el('span', { textContent: 'To‘lov chekini chiqarish (kassa printeri)' })),
      err,
      el('div', { className: 'row' }, ok, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Bekor', onclick: () => done(null) })));
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(null);
    });
    document.body.append(dlg);
    dlg.showModal();
    setTimeout(() => received.select(), 50);
  });
}

// Buyurtmani bekor qilish: sabab + (Mison yoqilgan bo'lsa) Mison'dagi bekor qilish sababi
let causesCache = null;
function cancelDialog(order) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { className: 'pay-dialog cancel-dialog' });
    const reason = el('textarea', { rows: 2, maxLength: 200, placeholder: 'Sabab: mijoz voz kechdi, xato yozildi…', className: 'pos-comment' });
    const cause = el('select', { className: 'cancel-cause', ariaLabel: 'Mison sababi', hidden: true });
    const err = el('p', { className: 'form-error', hidden: true });
    const onlyMison = order.status !== 'qabul';
    const done = (v) => {
      resolve(v);
      dlg.close();
    };
    const ok = el('button', { type: 'button', className: 'btn btn-danger btn-wide', textContent: onlyMison ? 'Mison’dan o‘chirish' : 'Bekor qilish' });
    ok.addEventListener('click', () => {
      const c = causesCache?.find((x) => String(x.id) === cause.value);
      if (c?.commentRequired && !reason.value.trim()) {
        err.textContent = 'Bu sabab uchun izoh yozish shart.';
        err.hidden = false;
        return;
      }
      done({ reason: reason.value.trim(), causeId: cause.value || '' });
    });
    dlg.append(
      el('h2', { textContent: `${onlyMison ? 'Mison’dan o‘chirish' : 'Bekor qilish'} · #${order.number}` }),
      el('p', { className: 'muted', textContent: onlyMison
        ? 'Saytda bu buyurtma allaqachon bekor. Mison kassasidagi nusxasi o‘chiriladi.'
        : `${formatPrice(order.total)} hisobdan olib tashlanadi.${order.kitchenStations?.length ? ' Oshxonaga “BEKOR QILINDI” cheki chiqadi.' : ''}${order.misonOpen ? ' Mison kassasidan ham o‘chiriladi.' : ''}` }),
      order.misonOpen ? el('p', { className: 'muted small', textContent: 'Eslatma: Mison kassasi buyurtmani qabul qilib bo‘lgan bo‘lsa, uni faqat Mison kassasining o‘zida o‘chirish mumkin.' }) : '',
      reason, cause, err,
      el('div', { className: 'row' }, ok, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Yopish', onclick: () => done(null) })));
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(null);
    });
    document.body.append(dlg);
    dlg.showModal();
    if (order.misonOpen) {
      (causesCache ? Promise.resolve({ items: causesCache }) : api('/api/kassa/mison/cancel-causes')).then((r) => {
        causesCache = r.items || [];
        if (!causesCache.length) return;
        cause.replaceChildren(el('option', { value: '', textContent: 'Mison sababi (ixtiyoriy)' }), ...causesCache.map((c) => el('option', { value: String(c.id), textContent: c.name })));
        const def = causesCache.find((c) => c.isDefault);
        if (def) cause.value = String(def.id);
        cause.hidden = false;
      }).catch(() => {});
    }
    setTimeout(() => reason.focus(), 50);
  });
}

function toastDone(text) {
  const t = el('div', { className: 'k-toast', role: 'status', textContent: `✓ ${text}` });
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

/* ───────── Bitta buyurtma ───────── */
async function viewOrder(id, back) {
  stopView();
  onLive = null;
  window.scrollTo(0, 0);
  let order;
  try {
    ({ order } = await api(`/api/kassa/orders/${encodeURIComponent(id)}`));
  } catch (e) {
    return gate(e) || app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: e.message }), backTo()));
  }
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const goBack = back || (() => route());
  const canVoid = can('order.void') && order.status === 'qabul' && !order.payment;
  // Yetkazish: to'lov (kerak bo'lsa qabul bilan) → kassa printeridan "TO'LANDI" cheki, taomlar o'z printerlaridan
  const payDelivery = async (btn) => {
    const pay = await payDialog({ title: `Yetkazish #${order.number}`, total: order.total, note: order.status === 'yangi' ? 'To‘lovdan keyin buyurtma qabul qilinadi va taomlar oshxona printerlaridan chiqadi.' : '' });
    if (!pay) return;
    err.hidden = true;
    btn.disabled = true;
    try {
      const r = await api(`/api/kassa/orders/${order.id}/pay`, { method: 'POST', body: JSON.stringify(pay) });
      if (r.print?.printed && r.print.self) printHere();
      poll();
      toastDone(`#${order.number} to‘landi · ${r.order.payment.label}${r.order.payment.change ? ` · qaytim ${formatPrice(r.order.payment.change)}` : ''}${r.print?.printed ? ' · chek chiqyapti' : ''}`);
      viewOrder(order.id, back);
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
  const act = async (btn, path, body) => {
    err.hidden = true;
    btn.disabled = true;
    try {
      await api(`/api/kassa/orders/${order.id}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
      poll();
      goBack();
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
  const blocks = [
    el('button', { type: 'button', className: 'back', onclick: goBack }, '← Orqaga'),
    el('div', { className: 'order-head reveal' },
      el('p', { className: `status-chip ${STATUS_CLASS[order.status] || ''}`, textContent: order.statusLabel }),
      el('h1', { className: 'staff-order-title', textContent: `#${order.number} · ${whereOf(order)}` }),
      el('p', { className: 'muted', textContent: `${ago(order.createdAt)} · ${order.customerName || 'Mijoz'}` },
        order.customerPhone ? el('span', {}, ' · ', el('a', { href: phoneHref(order.customerPhone), textContent: order.customerPhone })) : '')),
    order.mode === 'delivery' ? el('div', { className: 'addr-card' },
      el('p', { textContent: `📍 ${addrText(order.address)}` }),
      order.address?.landmark ? el('p', { className: 'muted small', textContent: `Mo‘ljal: ${order.address.landmark}` }) : '',
      el('p', { className: 'muted small', textContent: `${order.deliveryKm ? `${String(order.deliveryKm).replace('.', ',')} km · ` : ''}yetkazish ${formatPrice(order.deliveryFee)}${order.deliveryPhone ? ` · ${order.deliveryPhone}` : ''}${order.courierName ? ` · kuryer: ${order.courierName}` : ''}` })) : '',
    el('ul', { className: 'order-lines big' }, order.items.map((i) => el('li', {},
      el('span', {}, `${qtyText(i)} ${i.name}`, i.mods?.length ? el('small', { className: 'line-mods', textContent: modsLine(i.mods) }) : '', i.note ? el('small', { className: 'line-note', textContent: `💬 ${i.note}` }) : ''),
      el('span', { className: 'line-right' }, el('span', { textContent: formatPrice(i.sum) }),
        canVoid ? el('button', { type: 'button', className: 'line-void', ariaLabel: `${i.name} — olib tashlash`, title: 'Olib tashlash', textContent: '−', onclick: () => voidItem(order, i, back) }) : '')))),
    order.voided?.length ? el('ul', { className: 'order-lines voided' }, order.voided.map((v) => el('li', {},
      el('span', {}, `✕ ${v.unit === 'kg' ? `${String(v.qty).replace('.', ',')} kg` : `${v.qty} ×`} ${v.name}`, el('small', { className: 'line-mods', textContent: `${v.reason}${v.byName ? ` · ${v.byName}` : ''}` })),
      el('span', { textContent: `−${formatPrice(v.sum)}` })))) : '',
    el('div', { className: 'cart-total' }, el('span', { textContent: 'Jami' }), el('strong', { textContent: formatPrice(order.total) })),
    order.payment ? el('p', { className: 'notice is-ok', textContent: `✓ To‘langan · ${order.payment.label}${order.payment.change ? ` · qaytim ${formatPrice(order.payment.change)}` : ''} · ${fmtTime(order.paidAt)} · ${order.payment.byName}` }) : '',
    order.comment ? el('p', { className: 'notice', textContent: `Izoh: ${order.comment}` }) : '',
    order.misonError && !order.misonOrderId ? el('p', { className: 'notice is-bad', textContent: `Mison: ${order.misonError}` }) : '',
    order.misonOrderId ? el('p', { className: 'muted small', textContent: `Mison: ${order.misonStatus || 'kassaga yuborilgan'}` }) : '',
    order.status === 'bekor' && order.cancelledByName ? el('p', { className: 'notice', textContent: `Bekor qildi: ${order.cancelledByName}${order.cancelReason ? ` — ${order.cancelReason}` : ''}` }) : '',
    order.misonCancelError && order.misonOpen ? el('p', { className: 'notice is-bad', textContent: `Mison’dan o‘chmadi: ${order.misonCancelError}. Mison kassasining o‘zida o‘chiring (buyurtmani yaratgan foydalanuvchi yoki o‘chirish huquqi bor administrator).` }) : '',
    err,
  ];
  const delivery = order.mode === 'delivery';
  const canPay = can('tab.pay') && can('delivery.manage');
  if (delivery && !order.payment && canPay && (order.status === 'qabul' || (order.status === 'yangi' && can('order.accept')))) {
    const payBtn = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: order.status === 'yangi' ? '💳 To‘lov va qabul qilish' : '💳 To‘lovni qabul qilish' });
    payBtn.addEventListener('click', () => payDelivery(payBtn));
    blocks.push(payBtn);
  }
  if (order.status === 'yangi' && can('order.accept')) {
    const accept = el('button', { type: 'button', className: `btn ${delivery ? 'btn-ghost' : 'btn-accept'} btn-wide`, textContent: delivery ? 'Qabul qilish (to‘lov keyin — kuryerga)' : 'Qabul qilish' });
    accept.addEventListener('click', () => act(accept, 'accept'));
    const reject = el('button', { type: 'button', className: 'btn-link danger', textContent: 'Rad etish' });
    reject.addEventListener('click', () => {
      const reason = prompt('Rad etish sababi (mijozga yuboriladi):', '');
      if (reason !== null) act(reject, 'reject', { reason });
    });
    blocks.push(accept, reject);
  } else if (order.mode === 'delivery' && order.status === 'qabul' && order.deliveryStatus !== 'yetkazildi' && can('delivery.manage')) {
    const done = el('button', { type: 'button', className: 'btn btn-wide', textContent: 'Yetkazildi deb belgilash' });
    done.addEventListener('click', () => confirm('Buyurtma mijozga yetkazildimi?') && act(done, 'delivered'));
    blocks.push(done);
  }
  if ((order.status === 'qabul' || order.status === 'yangi') && can('bill.print')) blocks.push(printButton({ orderId: order.id }, { label: '🖨 Buyurtma chekini chiqarish' }));
  blocks.push(kitchenControl(order));
  if (can('order.cancel') && !order.payment && (order.status === 'qabul' || (order.misonOpen && (order.status === 'bekor' || order.status === 'rad')))) {
    const cancel = el('button', { type: 'button', className: 'btn-link danger', textContent: order.status === 'qabul' ? '✖ Buyurtmani bekor qilish' : '✖ Mison’dan o‘chirish' });
    cancel.addEventListener('click', async () => {
      const r = await cancelDialog(order);
      if (!r) return;
      err.hidden = true;
      cancel.disabled = true;
      try {
        const res = await api(`/api/kassa/orders/${order.id}/cancel`, { method: 'POST', body: JSON.stringify(r) });
        poll();
        if (res.mison && !res.mison.ok) {
          alert(`Saytda bekor qilindi.\n\nMison’dan o‘chmadi: ${res.mison.message}\n\nMison kassasining o‘zida o‘chiring.`);
          viewOrder(order.id, back);
          return;
        }
        toastDone(res.mison?.ok ? 'Bekor qilindi — Mison’dan ham o‘chirildi' : 'Bekor qilindi');
        goBack();
      } catch (e) {
        if (gate(e)) return;
        err.textContent = e.message;
        err.hidden = false;
        cancel.disabled = false;
      }
    });
    blocks.push(cancel);
  }
  app.replaceChildren(...blocks.filter(Boolean));
}

// Taomni hisobdan olib tashlash: miqdor (dona bo'lsa) va sabab; oshxonaga "BEKOR" cheki chiqadi
const VOID_REASONS = ['Mijoz voz kechdi', 'Xato kiritildi', 'Taom tugagan', 'Uzoq kutildi', 'Sifat yoqmadi'];

// Stol hisobidan taomni olib tashlash: qaysi taom (masalan 2 ta nondan 1 tasi) → soni → sabab
function voidPicker(tab) {
  const rounds = tab.rounds.filter((o) => o.status === 'qabul' && o.items.length);
  let dlg = null;
  const list = el('ul', { className: 'void-pick' }, rounds.flatMap((o) => o.items.map((i) => el('li', {},
    el('button', { type: 'button', className: 'void-pick-row', onclick: () => {
      dlg?.close();
      voidItem(o, i, null, { after: () => viewTab(tab.id) });
    } },
    el('span', { className: 'void-pick-qty', textContent: qtyText(i) }),
    el('span', { className: 'void-pick-name' }, el('b', { textContent: i.name }), el('small', { className: 'muted', textContent: ` · #${o.number}${i.note ? ` · ${i.note}` : ''}` })),
    el('span', { className: 'void-pick-sum', textContent: formatPrice(i.sum) }),
    el('span', { className: 'void-pick-x', ariaHidden: 'true', textContent: '−' }))))));
  dlg = toolDialog(`Olib tashlash · ${tab.tableLabel}`, el('div', { className: 'ctl' },
    el('p', { className: 'muted small', textContent: 'Taomni tanlang — keyin nechta olib tashlashni va sababini yozasiz.' }), list));
}

// Butun chekni o'chirish: stoldagi hamma buyurtma bekor bo'ladi (oshxonaga "BEKOR" cheki), stol bo'shaydi
const TAB_CANCEL_REASONS = ['Noto‘g‘ri stolga yozildi', 'Mijoz ketib qoldi', 'Ikki marta yozildi', 'Sinov buyurtma'];
function cancelTabDialog(tab) {
  const reason = el('textarea', { id: 'tab-cancel-reason', rows: 2, maxLength: 200, className: 'pos-comment', placeholder: 'Sabab (majburiy)' });
  const err = el('p', { className: 'form-error', hidden: true });
  const ok = el('button', { type: 'button', className: 'btn btn-danger btn-wide', textContent: `🗑 ${tab.tableLabel} — chekni o‘chirish` });
  let dlg = null;
  ok.addEventListener('click', async () => {
    if (reason.value.trim().length < 3) {
      err.textContent = 'Sababini yozing yoki tanlang.';
      err.hidden = false;
      return;
    }
    ok.disabled = true;
    try {
      const r = await api(`/api/kassa/tabs/${tab.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.value.trim() }) });
      dlg.close();
      poll();
      if (r.mison?.length) alert(`Chek saytda o‘chirildi.\n\nMison’dan o‘chmadi:\n${r.mison.join('\n')}\n\nMison kassasining o‘zida o‘chiring.`);
      else toastDone(`${tab.tableLabel} — chek o‘chirildi`);
      location.hash = 'stollar';
    } catch (e) {
      ok.disabled = false;
      if (gate(e)) return dlg.close();
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  dlg = toolDialog(`Chekni o‘chirish · ${tab.tableLabel}`, el('div', { className: 'ctl' },
    el('p', { className: 'notice warn', textContent: `Stoldagi hamma buyurtma (${formatPrice(tab.total)}) bekor qilinadi, stol bo‘shaydi. Oshxonaga “BEKOR” cheki chiqadi. Kim va nega o‘chirgani smena hisobotida ko‘rinadi.` }),
    el('div', { className: 'chips quick-chips' }, TAB_CANCEL_REASONS.map((t) => el('button', { type: 'button', textContent: t, onclick: () => { reason.value = t; } }))),
    reason, err, ok));
}
function voidItem(order, item, back, { after = null } = {}) {
  const dlg = el('dialog', { className: 'pay-dialog cancel-dialog' });
  const kg = item.unit === 'kg';
  let qty = 1;
  const qtyEl = el('strong', { className: 'void-qty', textContent: '1' });
  const step = (d) => {
    qty = Math.min(item.qty, Math.max(1, qty + d));
    qtyEl.textContent = qty;
  };
  const reason = el('textarea', { rows: 2, maxLength: 200, className: 'pos-comment', placeholder: 'Sabab' });
  const err = el('p', { className: 'form-error', hidden: true });
  const ok = el('button', { type: 'button', className: 'btn btn-danger btn-wide', textContent: 'Olib tashlash' });
  ok.addEventListener('click', async () => {
    if (!reason.value.trim()) {
      err.textContent = 'Sababini yozing yoki tanlang.';
      err.hidden = false;
      return;
    }
    ok.disabled = true;
    try {
      const r = await api(`/api/kassa/orders/${order.id}/void`, { method: 'POST', body: JSON.stringify({ idx: item.idx, qty, reason: reason.value.trim() }) });
      dlg.close();
      poll();
      if (r.misonOpen) alert('Taom saytdagi hisobdan olib tashlandi.\n\nMison kassasida ham shu taomni olib tashlang (Mison buyurtmasi API orqali o‘zgarmaydi).');
      else toastDone(`${item.name} olib tashlandi`);
      if (after) after();
      else viewOrder(order.id, back);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      ok.disabled = false;
    }
  });
  dlg.append(
    el('h2', { textContent: `Olib tashlash · #${order.number}` }),
    el('p', { textContent: `${item.name} — ${kg ? `${String(item.qty).replace('.', ',')} kg (to‘liq)` : `${item.qty} ta bor`}` }),
    !kg && item.qty > 1 ? el('div', { className: 'void-step' }, el('button', { type: 'button', className: 'btn btn-ghost', textContent: '−', onclick: () => step(-1) }), qtyEl, el('button', { type: 'button', className: 'btn btn-ghost', textContent: '+', onclick: () => step(1) }), el('span', { className: 'muted', textContent: 'ta' })) : '',
    el('div', { className: 'chips quick-chips' }, VOID_REASONS.map((t) => el('button', { type: 'button', textContent: t, onclick: () => { reason.value = t; } }))),
    reason, err,
    el('p', { className: 'muted small', textContent: `${order.kitchenStations?.length ? 'Oshxonaga “BEKOR” cheki chiqadi. ' : ''}Kim va nega olib tashlagani smena hisobotida ko‘rinadi.` }),
    el('div', { className: 'row' }, ok, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Yopish', onclick: () => dlg.close() })));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function orderRow(o, i) {
  const li = el('li', { className: 'reveal', style: `--i:${Math.min(i, 12)}` });
  li.append(el('button', { type: 'button', className: `staff-card ${STATUS_CLASS[o.status] || ''}`, onclick: () => viewOrder(o.id) },
    el('span', { className: 'staff-card-main' },
      el('strong', { className: 'staff-card-title' }, el('span', { className: 'staff-card-no', textContent: `#${o.number}` }), ' ', whereOf(o)),
      el('span', { className: 'muted', textContent: `${o.items.slice(0, 3).map((x) => `${qtyText(x)} ${x.name}`).join(', ')}${o.items.length > 3 ? '…' : ''}` }),
      o.mode === 'delivery' ? el('span', { className: 'muted small', textContent: `📍 ${addrText(o.address)}` }) : ''),
    el('span', { className: 'staff-card-side' },
      o.status === 'qabul' && o.deliveryStatus ? el('span', { className: 'kitchen-chip', textContent: `${DSTATUS[o.deliveryStatus] || ''}${o.courierName ? ` · ${o.courierName}` : ''}` }) : '',
      el('span', { className: 'staff-card-sum', textContent: formatPrice(o.total) }),
      el('span', { className: 'muted small', textContent: ago(o.createdAt) }))));
  if (o.status === 'yangi' && can('order.accept')) {
    const delivery = o.mode === 'delivery';
    const b = el('button', { type: 'button', className: 'btn btn-accept quick-accept', textContent: delivery ? 'To‘lov va qabul' : 'Qabul qilish' });
    b.addEventListener('click', async () => {
      if (delivery) return viewOrder(o.id);
      if (await acceptQuick(o.id, b)) route();
    });
    li.append(b);
  }
  return li;
}

/* ───────── Yetkazib berish ───────── */
async function viewDeliveries() {
  const box = el('div', {});
  onLive = null;
  async function load() {
    stopView();
    let items;
    try {
      ({ items } = await api(withP('/api/kassa/deliveries?days=1')));
    } catch (e) {
      if (gate(e)) return;
      return box.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    if (!box.isConnected) return;
    const groups = [
      ['Tasdiqlash kerak', items.filter((o) => o.status === 'yangi')],
      ['Tayyorlanmoqda', items.filter((o) => o.status === 'qabul' && (o.deliveryStatus || 'kutilmoqda') === 'kutilmoqda')],
      ['Kuryer yo‘lda', items.filter((o) => o.status === 'qabul' && o.deliveryStatus === 'yolda')],
      ['Yetkazildi', items.filter((o) => o.deliveryStatus === 'yetkazildi')],
      ['Rad / bekor', items.filter((o) => o.status === 'rad' || o.status === 'bekor')],
    ].filter(([, os]) => os.length);
    box.replaceChildren(...(groups.length ? groups.map(([title, os]) => el('section', {},
      el('h2', { className: 'list-head', textContent: `${title} · ${os.length}` }),
      el('ul', { className: 'staff-list' }, os.map(orderRow)))) : [el('p', { className: 'empty-line', textContent: 'Bugun yetkazish buyurtmasi yo‘q.' })]));
    viewTimer = setTimeout(load, nextDelay());
    viewReload = () => box.isConnected && load();
  }
  app.replaceChildren(el('div', { className: 'view-head' }, el('h1', { textContent: 'Yetkazib berish' })), box);
  box.append(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  await load();
}

/* ───────── Tarix ───────── */
async function viewHistory() {
  onLive = null;
  const box = el('div', { className: 'kassa-tabs' });
  const sum = el('div', { className: 'staff-stats' });
  const chips = el('div', { className: 'chips' });
  async function load() {
    chips.replaceChildren(...[[1, 'Bugun'], [2, 'Kecha bilan'], [7, '7 kun'], [30, '30 kun']].map(([d, t]) => {
      const b = el('button', { type: 'button', textContent: t });
      b.setAttribute('aria-pressed', String(state.histDays === d));
      b.addEventListener('click', () => { state.histDays = d; load(); });
      return b;
    }));
    box.replaceChildren(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
    let items;
    try {
      ({ items } = await api(`/api/kassa/tabs?scope=closed&days=${state.histDays}`));
    } catch (e) {
      if (gate(e)) return;
      return box.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    const paid = items.filter((t) => !t.mergedInto);
    const stat = (n, label) => el('div', { className: 'staff-stat' }, el('strong', { textContent: n }), el('span', { textContent: label }));
    sum.replaceChildren(stat(paid.length, 'yopilgan stol'), stat(money(paid.reduce((s, t) => s + t.total, 0)), 'jami, so‘m'), stat(money(paid.reduce((s, t) => s + t.service, 0)), 'xizmat haqi, so‘m'));
    box.replaceChildren(...(items.length ? items.map((t, i) => el('button', { type: 'button', className: 'tab-card is-closed reveal', style: `--i:${Math.min(i, 12)}`, onclick: () => (location.hash = `hisob=${t.id}`) },
      el('span', { className: 'tab-card-table', textContent: t.tableLabel }),
      el('span', { className: 'tab-card-meta muted small', textContent: `${new Date(t.closedAt).toLocaleDateString('ru-RU')} · ${fmtTime(t.openedAt)}–${fmtTime(t.closedAt)}${t.closedByName ? ` · ${t.closedByName}` : ''}${t.waiterName ? ` · ${t.waiterName}` : ''}` }),
      el('span', { className: 'tab-card-total', textContent: formatPrice(t.total) }))) : [el('p', { className: 'empty-line', textContent: 'Bu davrda yopilgan hisob yo‘q.' })]));
  }
  app.replaceChildren(el('div', { className: 'view-head' }, el('h1', { textContent: 'Tarix' }), el('p', { className: 'muted', textContent: 'Yopilgan stol hisoblari faqat shu yerda saqlanadi.' })), chips, sum, box);
  await load();
}

/* ───────── Smena ───────── */
const dt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function reportBlocks(r) {
  const stat = (n, label, cls = '') => el('div', { className: `staff-stat ${cls}` }, el('strong', { textContent: n }), el('span', { textContent: label }));
  const table = (rows) => el('dl', { className: 'k-pay-rows' }, rows.filter(Boolean).map(([a, b, cls]) => el('div', { className: cls || '' }, el('dt', { textContent: a }), el('dd', { textContent: b }))));
  return [
    el('div', { className: 'staff-stats' }, stat(money(r.revenue), 'savdo, so‘m'), stat(r.checks, 'chek'), stat(money(r.avg), 'o‘rtacha chek'), stat(money(r.expectedCash), 'kassada bo‘lishi kerak')),
    el('div', { className: 'shift-cols' },
      el('section', { className: 'card-lite' }, el('h3', { textContent: 'To‘lov turlari' }),
        r.methods.length ? table(r.methods.map((m) => [`${m.label} · ${m.count}`, formatPrice(m.sum)])) : el('p', { className: 'muted', textContent: 'Hali to‘lov yo‘q.' })),
      el('section', { className: 'card-lite' }, el('h3', { textContent: 'Naqd pul' }), table([
        ['Boshlang‘ich', formatPrice(r.openingCash)], ['Naqd savdo', formatPrice(r.cashSales)],
        r.debtPaid?.cash ? ['Qarz to‘lovlari (naqd)', `+${formatPrice(r.debtPaid.cash)}`] : null,
        r.cashIn ? ['Kiritildi', `+${formatPrice(r.cashIn)}`] : null, r.cashOut ? ['Olindi', `−${formatPrice(r.cashOut)}`] : null,
        ['Kassada bo‘lishi kerak', formatPrice(r.expectedCash), 'is-total'],
        r.countedCash !== null ? ['Sanaldi', formatPrice(r.countedCash)] : null,
        r.countedCash !== null ? ['Farq', `${r.diff > 0 ? '+' : ''}${formatPrice(r.diff)}`, r.diff ? 'is-bad' : 'is-ok'] : null])),
      el('section', { className: 'card-lite' }, el('h3', { textContent: 'Boshqa' }), table([
        ['Xizmat haqi', formatPrice(r.service)], r.discount ? [`Chegirmalar · ${r.discountCount}`, `−${formatPrice(r.discount)}`] : null,
        r.delivery ? ['Yetkazishlar', String(r.delivery)] : null,
        r.unpaid.count ? [`To‘lovsiz yopilgan · ${r.unpaid.count}`, formatPrice(r.unpaid.sum)] : null,
        r.debtGiven?.count ? [`Qarzga berildi · ${r.debtGiven.count}`, formatPrice(r.debtGiven.sum)] : null,
        r.debtPaid?.count ? [`Qarz to‘lovlari · ${r.debtPaid.count}`, formatPrice(r.debtPaid.sum)] : null,
        r.cancelled.count ? [`Bekor qilingan · ${r.cancelled.count}`, formatPrice(r.cancelled.sum)] : null,
        r.voided.count ? [`Olib tashlangan taom · ${r.voided.count}`, formatPrice(r.voided.sum)] : null,
        r.openTabs ? ['Ochiq hisoblar', `${r.openTabs} ta`] : null]))),
    r.ops.length ? el('section', { className: 'card-lite' }, el('h3', { textContent: 'Kassaga kiritilgan / olingan' }),
      table(r.ops.map((o) => [`${fmtTime(o.at)} · ${o.type === 'in' ? 'kiritildi' : 'olindi'}${o.reason ? ` · ${o.reason}` : ''} · ${o.byName}`, `${o.type === 'in' ? '+' : '−'}${formatPrice(o.amount)}`]))) : '',
    r.waiters.length ? el('section', { className: 'card-lite' }, el('h3', { textContent: 'Ofitsiantlar' }), table(r.waiters.map((w) => [`${w.name} · ${w.count} stol`, formatPrice(w.sum)]))) : '',
    r.items.length ? el('section', { className: 'card-lite' }, el('h3', { textContent: 'Ko‘p sotilgan taomlar' }), table(r.items.slice(0, 12).map((i) => [`${String(i.qty).replace('.', ',')} × ${i.name}`, formatPrice(i.sum)]))) : '',
    r.voided.list.length || r.cancelled.list.length ? el('section', { className: 'card-lite' }, el('h3', { textContent: 'Olib tashlangan va bekor qilinganlar' }),
      table([...r.voided.list.map((v) => [`#${v.number} · ${v.qty} × ${v.name} · ${v.reason} · ${v.byName}`, `−${formatPrice(v.sum)}`]), ...r.cancelled.list.map((c) => [`#${c.number} bekor · ${c.reason || '—'} · ${c.byName}`, `−${formatPrice(c.sum)}`])])) : '',
  ];
}

function moneyDialog({ title, text, amountLabel, withReason = false, reasonRequired = false, extra }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { className: 'pay-dialog' });
    const amount = el('input', { type: 'text', inputMode: 'numeric', className: 'pay-received', placeholder: '0', ariaLabel: amountLabel });
    const reason = withReason ? el('input', { type: 'text', maxLength: 120, placeholder: reasonRequired ? 'Sabab (majburiy)' : 'Izoh (ixtiyoriy)', className: 'pos-comment' }) : null;
    const err = el('p', { className: 'form-error', hidden: true });
    const done = (v) => {
      resolve(v);
      dlg.close();
    };
    const ok = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: 'Saqlash' });
    ok.addEventListener('click', () => {
      const n = Math.round(Number(amount.value.replace(/\s/g, '')));
      if (!Number.isFinite(n) || n < 0 || amount.value.trim() === '') {
        err.textContent = 'Summani yozing.';
        err.hidden = false;
        return;
      }
      if (reasonRequired && !reason.value.trim()) {
        err.textContent = 'Sababini yozing.';
        err.hidden = false;
        return;
      }
      done({ amount: n, reason: reason?.value.trim() || '' });
    });
    dlg.append(el('h2', { textContent: title }), text ? el('p', { className: 'muted', textContent: text }) : '',
      el('label', { className: 'pay-row' }, el('span', { textContent: amountLabel }), amount), extra?.(amount) || '', reason || '', err,
      el('div', { className: 'row' }, ok, el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Bekor', onclick: () => done(null) })));
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(null);
    });
    document.body.append(dlg);
    dlg.showModal();
    setTimeout(() => amount.focus(), 50);
  });
}

async function viewShift(id = '') {
  onLive = null;
  stopView();
  const head = el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: id ? 'Smena hisoboti' : 'Smena' }));
  app.replaceChildren(head, el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  let r;
  try {
    r = id ? { current: (await api(`/api/kassa/shift/${encodeURIComponent(id)}`)).shift, history: [] } : await api('/api/kassa/shift');
  } catch (e) {
    if (gate(e)) return;
    return app.replaceChildren(head, el('p', { className: 'form-error', textContent: e.message }));
  }
  const c = r.current;
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const fail = (e, btn) => {
    if (gate(e)) return;
    err.textContent = e.message;
    err.hidden = false;
    if (btn) btn.disabled = false;
  };
  const post = async (path, body, btn) => {
    err.hidden = true;
    if (btn) btn.disabled = true;
    try {
      return await api(`/api/kassa/shift/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
    } catch (e) {
      fail(e, btn);
      return null;
    }
  };
  const printBtn = (sid) => (can('reports.view') ? el('button', { type: 'button', className: 'btn btn-ghost', textContent: '🖨 Hisobotni chiqarish', onclick: async (e) => {
    const b = e.currentTarget;
    const res = await post(`${sid}/print`, {}, b);
    if (!res) return;
    b.disabled = false;
    if (res.print?.printed && res.print.self) printHere();
    toastDone(res.print?.printed ? 'Hisobot printerga yuborildi' : `Chiqmadi: ${res.print?.reason || 'printer tanlanmagan'}`);
  } }) : '');
  const blocks = [head];
  if (!c) {
    const open = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: 'Smenani ochish' });
    open.addEventListener('click', async () => {
      const v = await moneyDialog({ title: 'Smenani ochish', text: 'Kassadagi boshlang‘ich naqd pulni sanab yozing (mayda pul).', amountLabel: 'Boshlang‘ich naqd' });
      if (!v) return;
      if (await post('open', { openingCash: v.amount }, open)) {
        toastDone('Smena ochildi');
        viewShift();
      }
    });
    blocks.push(el('div', { className: 'empty-state' },
      el('h2', { textContent: 'Smena ochilmagan' }),
      el('p', { className: 'muted', textContent: r.required ? 'Smena ochilmaguncha to‘lov olinmaydi.' : 'Smena ochilmasa — birinchi to‘lov uni o‘zi ochadi (boshlang‘ich naqd 0).' }),
      can('shift.open') ? open : el('p', { className: 'notice', textContent: 'Smena ochishga ruxsatingiz yo‘q.' })), err);
  } else {
    blocks.push(el('p', { className: 'shift-line' }, el('strong', { textContent: `Smena #${c.number}` }),
      ` · ${dt(c.openedAt)} — ${c.status === 'closed' ? dt(c.closedAt) : 'hozir'} · ochdi: ${c.openedByName}${c.auto ? ' (birinchi to‘lov bilan o‘zi ochildi)' : ''}${c.closedByName ? ` · yopdi: ${c.closedByName}` : ''}`));
    const actions = el('div', { className: 'row wrap shift-actions' });
    if (c.status === 'open' && can('shift.cash')) {
      for (const [type, label] of [['in', '➕ Kassaga pul kiritish'], ['out', '➖ Kassadan pul olish']]) {
        actions.append(el('button', { type: 'button', className: 'btn btn-ghost', textContent: label, onclick: async (e) => {
          const v = await moneyDialog({ title: label.slice(2), amountLabel: 'Summa', withReason: true, reasonRequired: type === 'out', text: type === 'out' ? 'Masalan: inkassatsiya, xarajat (non, gaz), avans.' : 'Masalan: mayda pul qo‘shildi.' });
          if (v && (await post('cash', { type, amount: v.amount, reason: v.reason }, e.currentTarget))) viewShift();
        } }));
      }
    }
    if (c.revenue !== undefined) actions.append(printBtn(c.id));
    if (c.status === 'open' && can('shift.close')) {
      const close = el('button', { type: 'button', className: 'btn btn-danger', textContent: 'Smenani yopish (Z)' });
      close.addEventListener('click', async () => {
        if (c.openTabs && !confirm(`${c.openTabs} ta ochiq hisob bor. Ularning to‘lovi keyingi smenaga tushadi. Baribir yopilsinmi?`)) return;
        const v = await moneyDialog({
          title: `Smena #${c.number}ni yopish`, amountLabel: 'Sanalgan naqd', withReason: true,
          text: `Kassadagi naqd pulni sanang. Kassada bo‘lishi kerak: ${formatPrice(c.expectedCash)}.`,
          extra: (amount) => {
            const d = el('p', { className: 'pay-row' }, el('span', { textContent: 'Farq' }), el('strong', { className: 'pay-change', textContent: '—' }));
            amount.addEventListener('input', () => {
              const n = Math.round(Number(amount.value.replace(/\s/g, '')) || 0) - c.expectedCash;
              d.lastChild.textContent = `${n > 0 ? '+' : ''}${formatPrice(n)}`;
              d.lastChild.classList.toggle('is-bad', n !== 0);
            });
            return d;
          },
        });
        if (!v) return;
        const res = await post('close', { countedCash: v.amount, note: v.reason }, close);
        if (!res) return;
        if (res.print?.printed && res.print.self) printHere();
        toastDone(`Smena #${c.number} yopildi${res.shift.diff ? ` · farq ${formatPrice(res.shift.diff)}` : ''}${res.print?.printed ? ' · Z-hisobot chiqyapti' : ''}`);
        viewShift();
      });
      actions.append(close);
    }
    blocks.push(actions, err);
    if (c.revenue !== undefined) blocks.push(...reportBlocks(c));
    else if (c.ops) blocks.push(el('p', { className: 'muted', textContent: 'Hisobotni ko‘rishga ruxsatingiz yo‘q.' }));
  }
  const past = (r.history || []).filter((h) => h.status === 'closed');
  if (past.length) {
    blocks.push(el('h2', { className: 'list-head', textContent: 'Oldingi smenalar' }),
      el('div', { className: 'kassa-tabs' }, past.map((h) => el('button', { type: 'button', className: 'tab-card is-closed', onclick: () => viewShift(h.id) },
        el('span', { className: 'tab-card-table', textContent: `Smena #${h.number}` }),
        el('span', { className: 'tab-card-meta muted small', textContent: `${dt(h.openedAt)} — ${dt(h.closedAt)} · ${h.closedByName}${h.diff ? ` · farq ${formatPrice(h.diff)}` : ''}` }),
        el('span', { className: 'tab-card-total', textContent: formatPrice(h.revenue || 0) })))));
  }
  if (id) blocks.splice(1, 0, el('button', { type: 'button', className: 'back', onclick: () => viewShift() }, '← Smena'));
  app.replaceChildren(...blocks.filter(Boolean));
}

/* ───────── Yo'naltirish ───────── */
const backTo = (tab) => el('button', { type: 'button', className: 'back', onclick: () => (location.hash = tab || 'stollar') }, '← Orqaga');
const currentTab = () => {
  const h = location.hash.slice(1);
  if (h.startsWith('hisob=')) return 'stollar';
  return TABS.includes(h) ? h : 'stollar';
};
function route() {
  stopView();
  onLive = null;
  renderSeq++;
  viewReload = null;
  const tab = currentTab();
  const nav = $('#kassa-tabs');
  nav.hidden = false;
  const allowed = { yetkazish: can('delivery.manage'), tarix: can('tab.history'), smena: canAny('shift.open', 'shift.close', 'shift.cash', 'reports.view') };
  for (const a of nav.querySelectorAll('a')) {
    a.hidden = allowed[a.dataset.tab] === false;
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  const h = location.hash.slice(1);
  if (h.startsWith('hisob=')) return viewTab(h.slice(6));
  if (tab === 'yetkazish' && can('delivery.manage')) return viewDeliveries();
  if (tab === 'tarix' && can('tab.history')) return viewHistory();
  if (tab === 'smena' && canAny('shift.open', 'shift.close', 'shift.cash', 'reports.view')) return viewShift();
  if (tab === 'sozlamalar') return viewSettings();
  if (tab === 'hisobot' && can('reports.view')) return viewReport();
  if (tab === 'ishhaqi' && can('wages.view')) return viewWages();
  if (tab === 'qarzlar' && can('debt.collect')) return viewDebts();
  return viewFloor();
}

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
    stopView();
    clearTimeout(pollTimer);
    app.replaceChildren(el('div', { className: 'empty-state' },
      el('h2', { textContent: 'Ruxsat yo‘q' }), el('p', { textContent: e.message }),
      el('p', { className: 'muted', textContent: profile?.phone ? `Admin “Xodimlar → Ruxsatlar” bo‘limida ochib beradi: ${profile.phone}` : '' }),
      el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Boshqa hisob bilan kirish', onclick: logout })));
    return true;
  }
  return false;
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  profile = null;
  clearTimeout(pollTimer);
  $('#kassa-tabs').hidden = true;
  $('#staff-name').textContent = '';
  showLogin();
}

function start() {
  setPerms(profile.perms);
  // boshqa lavozimdagi xodim (ofitsiant, omborchi) kassa oynasidan kirsa — o'z sahifasiga
  const other = homeFor('page.kassa');
  if (other) return location.replace(other);
  $('#staff-name').textContent = profile.name || '';
  if (!can('page.kassa')) return gate({ status: 403, message: 'Sizga kassa sahifasi ochilmagan.' });
  if (!$('.sound-toggle')) $('#staff-name').after(soundToggle());
  if (!$('.logout-mini')) $('.app-header').append(el('button', { type: 'button', className: 'logout-mini', textContent: 'Chiqish', onclick: logout }));
  poll();
  route();
}

function showLogin() {
  stopView();
  $('#kassa-tabs').hidden = true;
  mountPinLogin(app, {
    title: 'Kassa',
    logo: siteInfo.logo || '/logo.jpg',
    name: siteInfo.name || 'Oqtosh Restoran',
    onSuccess(p) {
      profile = p;
      start();
    },
  });
}

window.addEventListener('hashchange', () => profile && can('page.kassa') && route());

try {
  const [info, me] = await Promise.all([api('/api/info'), api('/api/me')]);
  siteInfo = info;
  applyInfo({ ...info, name: undefined });
  profile = me.profile;
  if (profile) start();
  else showLogin();
} catch (e) {
  offlineScreen(app, e);
}
