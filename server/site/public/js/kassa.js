import { $, el, api, formatPrice, phoneHref, applyInfo, modsLine } from './common.js';
import { mountPinLogin } from './pinlogin.js';
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
const TABS = ['stollar', 'yetkazish', 'tarix', 'smena'];
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

/* ───────── Stol hisobi ───────── */
async function viewTab(id) {
  stopView();
  onLive = null;
  window.scrollTo(0, 0);
  let tab;
  let open = [];
  let staff = [];
  let floor = { halls: [] };
  try {
    [{ tab }, { items: open }, { items: staff }, floor] = await Promise.all([api(`/api/kassa/tabs/${encodeURIComponent(id)}`), api('/api/kassa/tabs'), api('/api/kassa/staff'),
      can('tab.move') ? api('/api/staff/tables').catch(() => ({ halls: [] })) : { halls: [] }]);
  } catch (e) {
    return gate(e) || app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: e.message }), backTo('stollar')));
  }
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const act = async (btn, path, body, after) => {
    err.hidden = true;
    btn.disabled = true;
    try {
      const r = await api(`/api/kassa/tabs/${tab.id}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
      after ? after(r) : viewTab(tab.id);
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };
  const isOpen = tab.status === 'open';
  const pendingRounds = tab.rounds.filter((o) => o.status === 'yangi');

  /* — to'lov paneli — */
  const payRows = [
    ['Taomlar', formatPrice(tab.subtotal)],
    ...(tab.takeaway && tab.kind !== 'saboy' ? [['shundan saboy (foizsiz)', formatPrice(tab.takeaway)]] : []),
    ...(tab.discountAmt ? [[`Chegirma ${tab.discount?.type === 'pct' ? pctText(tab.discount.value) : ''}${tab.discount?.reason ? ` · ${tab.discount.reason}` : ''}`, `−${formatPrice(tab.discountAmt)}`]] : []),
    ...(tab.kind === 'saboy' ? [] : [[`Xizmat haqi ${pctText(tab.servicePct)}`, formatPrice(tab.service)]]),
  ];
  const closeBtn = el('button', { type: 'button', className: 'btn btn-pay btn-wide' }, el('span', { textContent: '✓' }), ' To‘lov — stolni yopish');
  closeBtn.addEventListener('click', async () => {
    const pay = await payDialog({ title: tab.tableLabel, total: tab.total, pending: tab.pending });
    if (!pay) return;
    act(closeBtn, 'close', pay, (r) => {
      if (r.print?.printed && r.print.self) printHere();
      const change = r.tab.payment?.change ? ` · qaytim ${formatPrice(r.tab.payment.change)}` : '';
      toastDone(`${tab.tableLabel} yopildi · ${formatPrice(tab.total)} · ${r.tab.payment?.label || ''}${change}${r.print?.printed ? ' · chek chiqyapti' : ''}`);
      location.hash = 'stollar';
    });
  });
  const after = () => {
    poll();
    viewTab(tab.id);
  };
  const addBtns = isOpen && can('order.create') ? el('div', { className: 'k-add' },
    el('button', { type: 'button', className: 'btn btn-small', textContent: '+ Buyurtma', onclick: () => openPos({ title: `${tab.tableLabel} · qo‘shimcha`, target: 'tab', tabId: tab.id, allowTakeaway: tab.kind !== 'saboy', onDone: after }) }),
    tab.kind !== 'saboy' ? el('button', { type: 'button', className: 'btn btn-small btn-ghost', textContent: '🥡 Saboy', onclick: () => openPos({ title: `${tab.tableLabel} · saboy`, target: 'tab', tabId: tab.id, takeaway: true, allowTakeaway: true, onDone: after }) }) : '') : '';
  const pay = el('section', { className: 'k-pay' },
    el('div', { className: 'k-pay-head' },
      el('h1', { textContent: tab.tableLabel }),
      el('p', { className: 'muted', textContent: `${tab.customerName || (tab.kind === 'saboy' ? 'Olib ketish' : 'Mijoz (QR’siz)')}${tab.customerPhone ? ` · ${tab.customerPhone}` : ''} · ${fmtTime(tab.openedAt)} dan` }),
      el('p', { className: 'k-waiter', textContent: tab.waiterName ? `Ofitsiant: ${tab.waiterName}` : 'Ofitsiant biriktirilmagan' })),
    addBtns,
    el('dl', { className: 'k-pay-rows' }, payRows.map(([a, b]) => el('div', {}, el('dt', { textContent: a }), el('dd', { textContent: b })))),
    el('div', { className: 'k-total' }, el('span', { textContent: 'JAMI' }), el('strong', { textContent: formatPrice(tab.total) })),
    pendingRounds.length ? el('div', { className: 'k-pending' },
      el('p', { textContent: `Tasdiqlanmagan: ${pendingRounds.length} ta · ${formatPrice(tab.pending)} (jamiga kirmagan)` }),
      ...pendingRounds.map((o) => {
        const b = el('button', { type: 'button', className: 'btn btn-small btn-accept', textContent: `#${o.number} qabul` });
        b.addEventListener('click', async () => { if (await acceptQuick(o.id, b)) viewTab(tab.id); });
        return b;
      })) : '',
    err,
    isOpen ? (can('tab.pay') ? closeBtn : el('p', { className: 'notice', textContent: 'To‘lov olishga ruxsatingiz yo‘q.' })) : el('p', { className: 'notice', textContent: `Yopilgan · ${fmtTime(tab.closedAt)}${tab.closedByName ? ` · ${tab.closedByName}` : ''}${tab.payment ? ` · ${tab.payment.label}${tab.payment.change ? `, qaytim ${formatPrice(tab.payment.change)}` : ''}` : ''}${tab.mergedInto ? ' · boshqa hisobga qo‘shilgan' : ''}` }),
    tab.rounds.some((o) => o.status === 'qabul') && can('bill.print') ? printButton({ tabId: tab.id }, { local: () => window.print() }) : '',
    tab.billPrintedAt ? el('p', { className: 'muted small', textContent: `🧾 Hisob cheki chiqqan · ${fmtTime(tab.billPrintedAt)}` }) : '');

  /* — sozlash — */
  let settings = '';
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
    const parts = [
      can('tab.discount') ? el('div', { className: 'ctl' }, el('label', { htmlFor: 'disc-val', textContent: 'Chegirma' }),
        el('div', { className: 'chips quick-chips' }, [5, 10, 15, 20].map((v) => el('button', { type: 'button', textContent: `${v}%`, onclick: () => { dType.value = 'pct'; dVal.value = v; dWhy.focus(); } }))),
        el('div', { className: 'ctl-row' }, dVal, dType), el('div', { className: 'ctl-row' }, dWhy, dBtn), dOff) : '',
      can('tab.service') ? el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-pct', textContent: 'Xizmat foizi' }),
        el('div', { className: 'chips quick-chips' }, [0, 10, 12, 15].map((v) => el('button', { type: 'button', textContent: `${v}%`, ariaPressed: String(v === tab.servicePct), onclick: () => { pct.value = v; act(pctBtn, 'service', { pct: v }); } }))),
        el('div', { className: 'ctl-row' }, pct, pctBtn)) : '',
      can('tab.waiter') ? el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-waiter', textContent: 'Ofitsiantni almashtirish' }), el('div', { className: 'ctl-row' }, waiter, wBtn)) : '',
      can('tab.move') && tab.kind !== 'saboy' ? el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-move', textContent: 'Stolni ko‘chirish (mijoz boshqa stolga o‘tdi)' }), el('div', { className: 'ctl-row' }, mv, mvBtn)) : '',
      can('tab.merge') ? el('div', { className: 'ctl' }, el('label', { htmlFor: 'svc-merge', textContent: 'Boshqa stolni shu hisobga qo‘shish (bitta chek)' }), el('div', { className: 'ctl-row' }, src, mBtn)) : '',
    ].filter(Boolean);
    settings = parts.length ? el('section', { className: 'k-settings' }, el('h2', { className: 'list-head', textContent: 'Sozlash' }), ...parts) : '';
  }

  app.replaceChildren(
    backTo('stollar'),
    el('div', { className: 'k-tab' },
      el('div', { className: 'k-side' }, pay, settings),
      el('div', { className: 'k-bill print-area' },
        el('div', { className: 'print-only' }, el('h2', { textContent: tab.tableLabel }), el('p', { textContent: new Date().toLocaleString('ru-RU') })),
        el('h2', { className: 'list-head no-print', textContent: `Buyurtmalar · ${tab.rounds.length}` }),
        billCard(tab, { onRound: (o) => viewOrder(o.id, () => viewTab(tab.id)) }))));
}

// To'lov: turi (admin yoqqan: naqd, karta, Click, Payme, Uzum, Humo...), naqdda berilgan pul va qaytim, to'lov cheki
//   payDialog({ title, total, pending, note }) → { payment: { method, received }, print } | null
let methodsCache = null;
async function payMethods() {
  if (!methodsCache) methodsCache = api('/api/kassa/payments').then((r) => r.items).catch(() => [{ key: 'naqd', label: 'Naqd', kind: 'cash' }, { key: 'karta', label: 'Karta', kind: 'card' }]);
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
    const paintMethods = () => {
      methods.replaceChildren(...list.map((m) => el('button', { type: 'button', className: `pay-method${method === m.key ? ' is-on' : ''}`, ariaPressed: String(method === m.key), textContent: `${METHOD_ICON[m.kind] || ''}${m.label}`, onclick: () => { method = m.key; paintMethods(); cashBox.hidden = !isCash(); } })));
    };
    paintMethods();
    cashBox.hidden = !isCash();
    paintChange();
    const done = (v) => {
      resolve(v);
      dlg.close();
    };
    const ok = el('button', { type: 'button', className: 'btn btn-pay btn-wide', textContent: '✓ To‘landi' });
    ok.addEventListener('click', () => {
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
      methods, cashBox,
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
      el('span', {}, `${qtyText(i)} ${i.name}`, i.mods?.length ? el('small', { className: 'line-mods', textContent: modsLine(i.mods) }) : ''),
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
function voidItem(order, item, back) {
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
      viewOrder(order.id, back);
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
        r.cashIn ? ['Kiritildi', `+${formatPrice(r.cashIn)}`] : null, r.cashOut ? ['Olindi', `−${formatPrice(r.cashOut)}`] : null,
        ['Kassada bo‘lishi kerak', formatPrice(r.expectedCash), 'is-total'],
        r.countedCash !== null ? ['Sanaldi', formatPrice(r.countedCash)] : null,
        r.countedCash !== null ? ['Farq', `${r.diff > 0 ? '+' : ''}${formatPrice(r.diff)}`, r.diff ? 'is-bad' : 'is-ok'] : null])),
      el('section', { className: 'card-lite' }, el('h3', { textContent: 'Boshqa' }), table([
        ['Xizmat haqi', formatPrice(r.service)], r.discount ? [`Chegirmalar · ${r.discountCount}`, `−${formatPrice(r.discount)}`] : null,
        r.delivery ? ['Yetkazishlar', String(r.delivery)] : null,
        r.unpaid.count ? [`To‘lovsiz yopilgan · ${r.unpaid.count}`, formatPrice(r.unpaid.sum)] : null,
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
} catch {
  app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: 'Sahifani yuklab bo‘lmadi' }), el('p', { textContent: 'Internetni tekshiring va yangilang.' })));
}
