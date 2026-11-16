import { $, el, api, formatPrice, phoneHref, applyInfo, modsLine } from './common.js';
import { mountPinLogin } from './pinlogin.js';
import { offlineScreen } from './offline.js';
import { setPerms, can, homeFor } from './perms.js';
import { floorLayout } from './floor.js';
import { alertNew, soundToggle, newItemsWatcher } from './alerts.js';
import { openScanner, scannerSupported } from './scanner.js';
import { billCard, qtyText, STATUS_CLASS, fmtTime } from './bill.js';
import { noteInfo, printButton, kitchenControl } from './printagent.js';
import { openPos } from './posorder.js';
import { listenPulse, onPulse, withP, nextDelay } from './livepulse.js';

// Ofitsiant sahifasi: Hozirgi (yangi + jarayondagi) · Stollar (band/bo'sh, hisob, "Mijoz ketdi") · Barchasi · Profil.
// Mijozning QR kodi shu sahifani ochadi: /ofitsiant.html#o=<id>&t=<token>. Yangi buyurtma kelsa — ovoz va tebranish.

const app = $('#app');
let profile = null;
let scanned = null; // { id, token } — QR'dan
let siteInfo = {};
let hallKey = (() => {
  try {
    return localStorage.getItem('oq_waiter_hall') || '';
  } catch {
    return '';
  }
})();
let viewTimer = null;
const view = { tab: 'hozir', filter: 'all', days: 1 };
const live = { items: [], calls: [], stats: { acceptedToday: 0, sumToday: 0 }, today: '', loaded: false };

const ago = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return min < 1 ? 'hozirgina' : min < 60 ? `${min} daqiqa oldin` : fmtTime(iso);
};
const tableOf = (o) => o.tableLabel || `Stol ${o.table}`;
const MISON_FINAL = ['CLOSED', 'DELETED'];
// Qabul qilingan buyurtma stol hisobi ochiq turguncha ko'rinadi (yopilganlarini server bermaydi — ular faqat kassada)
const isActive = (o) => o.status === 'qabul';

function readScan(hash = location.hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  if (p.get('o')) {
    scanned = { id: p.get('o'), token: p.get('t') || '' };
    history.replaceState(null, '', `${location.pathname}#o=${scanned.id}`);
  }
}

function stopView() {
  clearTimeout(viewTimer);
  viewTimer = null;
}

/* ───────── Umumiy kuzatuv: yangi buyurtmalar (har 12 soniyada) ───────── */
const watch = newItemsWatcher();
const callWatch = newItemsWatcher();
let pollTimer = null;
const listeners = new Set();
async function poll() {
  clearTimeout(pollTimer);
  try {
    const r = await api(withP('/api/staff/orders'));
    if (r.perms) setPerms(r.perms);
    live.items = r.items;
    live.calls = r.calls || [];
    live.stats = r.stats || live.stats;
    live.today = r.today;
    live.loaded = true;
    noteInfo(r.print);
    listenPulse(r.pulse?.url);
    callWatch(live.calls.map((c) => `${c.tabId}@${c.at}`), (keys) => {
      const c = live.calls.find((x) => `${x.tabId}@${x.at}` === keys[0]);
      alertNew(c ? c.tableLabel : 'Chaqiruv', c ? c.label : '');
    });
    const pending = r.items.filter((o) => o.status === 'yangi');
    watch(pending.map((o) => o.id), (ids) => {
      const first = pending.find((o) => o.id === ids[0]);
      alertNew(ids.length > 1 ? `${ids.length} ta yangi buyurtma` : 'Yangi buyurtma', first ? tableOf(first) : '');
    });
    const n = pending.length + live.calls.length;
    document.title = `${n ? `(${n}) ` : ''}Ofitsiant`;
    for (const fn of listeners) fn();
  } catch (e) {
    if (gate(e)) return;
  }
  pollTimer = setTimeout(poll, nextDelay());
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && profile && live.loaded) poll();
});
// "Yurak urishi": buyurtma yoki stol o'zgardi — darhol yangilanadi
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

/* ───────── Bitta buyurtma ───────── */
async function viewOrder(id, token = '') {
  stopView();
  window.scrollTo(0, 0);
  let order;
  try {
    ({ order } = await api(`/api/staff/orders/${encodeURIComponent(id)}`));
  } catch (e) {
    return gate(e) || app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: e.message }), backBtn()));
  }
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const showErr = (t) => {
    err.textContent = t;
    err.hidden = false;
  };
  const blocks = [
    backBtn(),
    el('div', { className: 'order-head reveal' },
      el('p', { className: `status-chip ${STATUS_CLASS[order.status] || ''}`, textContent: order.statusLabel }),
      el('h1', { className: 'staff-order-title', textContent: `#${order.number} · ${tableOf(order)}` }),
      el('p', { className: 'muted', textContent: `${ago(order.createdAt)} · ${order.customerName || 'Mijoz'}` },
        order.customerPhone ? el('span', {}, ' · ', el('a', { href: phoneHref(order.customerPhone), textContent: order.customerPhone })) : '')),
    el('ul', { className: 'order-lines big' }, order.items.map((i) => el('li', {},
      el('span', {}, `${qtyText(i)} ${i.name}`, i.mods?.length ? el('small', { className: 'line-mods', textContent: modsLine(i.mods) }) : '', i.note ? el('small', { className: 'line-note', textContent: `💬 ${i.note}` }) : ''), el('span', { textContent: formatPrice(i.sum) })))),
    el('div', { className: 'cart-total' }, el('span', { textContent: 'Jami' }), el('strong', { textContent: formatPrice(order.total) })),
    order.comment ? el('p', { className: 'notice', textContent: `Izoh: ${order.comment}` }) : '',
  ];
  if (order.status === 'yangi' && !can('order.accept')) {
    blocks.push(el('p', { className: 'notice', textContent: 'Buyurtmani qabul qilishga ruxsatingiz yo‘q — kassaga ayting.' }));
  } else if (order.status === 'yangi') {
    const accept = el('button', { type: 'button', className: 'btn btn-accept btn-wide', textContent: 'Qabul qilish' });
    accept.addEventListener('click', async () => {
      err.hidden = true;
      accept.disabled = true;
      accept.textContent = 'Qabul qilinmoqda…';
      try {
        const r = await api(`/api/staff/orders/${order.id}/accept`, { method: 'POST', body: JSON.stringify(token ? { token } : {}) });
        scanned = null;
        poll();
        done(r.order);
      } catch (e) {
        if (gate(e)) return;
        showErr(e.message);
        accept.disabled = false;
        accept.textContent = 'Qabul qilish';
      }
    });
    const reason = el('input', { id: 'reject-reason', maxLength: 200, placeholder: 'Masalan: bu taom tugagan' });
    const rejectBox = el('div', { className: 'reject-box', hidden: true },
      el('div', { className: 'field' }, el('label', { htmlFor: 'reject-reason', textContent: 'Sabab (mijozga yuboriladi)' }), reason));
    const reject = el('button', { type: 'button', className: 'btn-link danger', textContent: 'Rad etish' });
    reject.addEventListener('click', async () => {
      if (rejectBox.hidden) {
        rejectBox.hidden = false;
        reject.textContent = 'Rad etishni tasdiqlash';
        return reason.focus();
      }
      reject.disabled = true;
      try {
        await api(`/api/staff/orders/${order.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.value }) });
        scanned = null;
        poll();
        goTab(view.tab);
      } catch (e) {
        if (gate(e)) return;
        showErr(e.message);
        reject.disabled = false;
      }
    });
    blocks.push(err, accept, rejectBox, reject);
  } else if (order.status === 'qabul') {
    blocks.push(el('div', { className: 'result-card is-ok' },
      el('h2', { textContent: 'Qabul qilingan' }),
      el('p', { textContent: `${fmtTime(order.acceptedAt)}${order.acceptedByName ? ` · ${order.acceptedByName}` : ''}${order.misonStatus ? ` · ${order.misonStatus}` : ''}` })));
  }
  blocks.push(kitchenControl(order));
  if (order.tabId) blocks.push(el('button', { type: 'button', className: 'btn btn-ghost btn-wide', textContent: 'Stol hisobini ochish', onclick: () => viewTab(order.tabId) }));
  app.replaceChildren(...blocks.filter(Boolean));
}

function done(order) {
  app.replaceChildren(...[el('div', { className: 'result-card is-ok big pop' },
    el('p', { className: 'result-icon', textContent: '✓', ariaHidden: 'true' }),
    el('h1', { textContent: `#${order.number} qabul qilindi` }),
    el('p', { textContent: `${tableOf(order)} · ${formatPrice(order.total)}` }),
    order.misonOrderId ? el('p', { className: 'mison-ok', textContent: `Mison kassasiga tushdi (№ ${order.misonOrderId})${order.misonStatus ? ` · ${order.misonStatus}` : ''}` }) : null),
  order.misonError && !order.misonOrderId ? el('div', { className: 'result-card is-bad', role: 'alert' },
    el('h2', { textContent: 'Mison kassasiga tushmadi' }),
    el('p', { textContent: order.misonError }),
    el('p', { textContent: 'Buyurtmani kassaga qo‘lda kiriting yoki administratorga ayting.' })) : null,
  el('button', { type: 'button', className: 'btn btn-wide', textContent: 'Hozirgi buyurtmalarga', onclick: () => goTab('hozir') })].filter(Boolean));
}

const backBtn = () => el('button', { type: 'button', className: 'back', onclick: () => {
  scanned = null;
  goTab(view.tab);
} }, '← Orqaga');

/* ───────── Stol hisobi ───────── */
async function viewTab(id) {
  stopView();
  window.scrollTo(0, 0);
  let tab;
  try {
    ({ tab } = await api(`/api/staff/tabs/${encodeURIComponent(id)}`));
  } catch (e) {
    return gate(e) || app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: e.message }), backBtn()));
  }
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const closeBtn = el('button', { type: 'button', className: 'btn btn-wide btn-leave', textContent: 'Mijoz ketdi — stolni bo‘shatish' });
  closeBtn.addEventListener('click', async () => {
    if (!confirm(`${tab.tableLabel}: mijoz ketdimi? Stol yangi mijoz uchun bo‘shatiladi.${tab.pending ? '\nTasdiqlanmagan buyurtmalar bekor qilinadi.' : ''}`)) return;
    closeBtn.disabled = true;
    try {
      await api(`/api/staff/tabs/${tab.id}/close`, { method: 'POST', body: '{}' });
      poll();
      goTab('stollar');
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      closeBtn.disabled = false;
    }
  });
  const after = () => {
    poll();
    viewTab(tab.id);
  };
  const addBtns = tab.status === 'open' && can('order.create') ? el('div', { className: 'add-row' },
    el('button', { type: 'button', className: 'btn btn-wide', textContent: '+ Buyurtma qo‘shish', onclick: () => openPos({ title: `${tab.tableLabel} · qo‘shimcha`, target: 'tab', tabId: tab.id, allowTakeaway: tab.kind !== 'saboy', onDone: after }) }),
    tab.kind !== 'saboy' ? el('button', { type: 'button', className: 'btn btn-ghost btn-wide', textContent: '🥡 Saboy qo‘shish', onclick: () => openPos({ title: `${tab.tableLabel} · saboy`, target: 'tab', tabId: tab.id, takeaway: true, allowTakeaway: true, onDone: after }) }) : '') : '';
  app.replaceChildren(
    backBtn(),
    el('div', { className: 'view-head reveal' }, el('h1', { textContent: tab.tableLabel }),
      el('p', { className: 'muted', textContent: `${tab.customerName || (tab.kind === 'saboy' ? 'Olib ketish' : 'Mijoz (QR’siz)')}${tab.customerPhone ? ` · ${tab.customerPhone}` : ''} · ${fmtTime(tab.openedAt)} dan${tab.waiterName ? ` · ofitsiant: ${tab.waiterName}` : ''}` })),
    addBtns,
    billCard(tab, { onRound: (o) => viewOrder(o.id) }),
    el('div', { className: 'stack-actions' },
      tab.rounds.some((o) => o.status === 'qabul') ? printButton({ tabId: tab.id }) : '',
      tab.status === 'open' ? err : '',
      tab.status !== 'open' ? el('p', { className: 'notice', textContent: `Hisob yopilgan · ${fmtTime(tab.closedAt)}` })
        : tab.kind === 'saboy' ? el('p', { className: 'notice', textContent: 'Saboy — to‘lovni kassa qabul qiladi va yopadi.' }) : can('tab.close') ? closeBtn : ''));
}

/* ───────── Ro'yxatlar ───────── */
function listTab() {
  const h = location.hash.replace(/^#/, '');
  return ['hozir', 'stollar', 'profil'].includes(h) ? h : 'hozir';
}
function goTab(tab) {
  if (location.hash === `#${tab}`) viewList();
  else location.hash = tab;
}
function paintTabs(tab) {
  const tabs = $('#staff-tabs');
  tabs.hidden = false;
  for (const a of tabs.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const n = live.items.filter((o) => o.status === 'yangi').length + live.calls.length;
  const badge = $('#staff-badge');
  badge.hidden = !n;
  badge.textContent = n;
}

function orderCard(o, { showDay = false, quick = false } = {}) {
  const kitchen = o.status === 'qabul' && o.misonStatus ? o.misonStatus : '';
  const li = el('li', { className: 'reveal' });
  const card = el('button', { type: 'button', className: `staff-card ${STATUS_CLASS[o.status] || ''}`, onclick: () => viewOrder(o.id) },
    el('span', { className: 'staff-card-main' },
      el('strong', { className: 'staff-card-title' }, el('span', { className: 'staff-card-no', textContent: `#${o.number}` }), ' ', tableOf(o)),
      el('span', { className: 'muted', textContent: `${o.items.slice(0, 3).map((i) => `${qtyText(i)} ${i.name}`).join(', ')}${o.items.length > 3 ? '…' : ''}` }),
      o.status === 'qabul' && o.acceptedByName ? el('span', { className: 'muted small', textContent: `${o.mine ? 'Siz' : o.acceptedByName} qabul qildi${o.acceptedAt ? ` · ${fmtTime(o.acceptedAt)}` : ''}` }) : ''),
    el('span', { className: 'staff-card-side' },
      el('span', { className: `status-chip ${STATUS_CLASS[o.status] || ''}`, textContent: o.status === 'yangi' ? 'Yangi' : o.statusLabel }),
      kitchen ? el('span', { className: 'kitchen-chip', textContent: kitchen }) : '',
      el('span', { className: 'staff-card-sum', textContent: formatPrice(o.total) }),
      el('span', { className: 'muted small', textContent: showDay ? fmtTime(o.createdAt) : ago(o.createdAt) })));
  li.append(card);
  if (quick && o.status === 'yangi' && can('order.accept')) {
    const b = el('button', { type: 'button', className: 'btn btn-accept quick-accept', textContent: 'Qabul qilish' });
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = '…';
      try {
        await api(`/api/staff/orders/${o.id}/accept`, { method: 'POST', body: '{}' });
        await poll();
      } catch (e) {
        if (!gate(e)) alert(e.message);
        b.disabled = false;
        b.textContent = 'Qabul qilish';
      }
    });
    li.append(b);
  }
  return li;
}
const emptyLine = (text) => el('li', { className: 'empty-line', textContent: text });

function lookupForm() {
  const number = el('input', { id: 'lookup-number', inputMode: 'numeric', maxLength: 5, placeholder: 'Raqam, masalan 12', autocomplete: 'off' });
  const lookErr = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const form = el('form', { className: 'lookup', noValidate: true },
    el('label', { className: 'visually-hidden', htmlFor: 'lookup-number', textContent: 'Buyurtma raqami' }), number,
    el('button', { type: 'submit', className: 'btn btn-ghost', textContent: 'Ochish' }), lookErr);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    lookErr.hidden = true;
    try {
      const { order } = await api(`/api/staff/lookup?number=${encodeURIComponent(number.value.trim())}`);
      viewOrder(order.id);
    } catch (ex) {
      if (gate(ex)) return;
      lookErr.textContent = ex.message;
      lookErr.hidden = false;
    }
  });
  return form;
}

function scanButton() {
  const b = el('button', { type: 'button', className: 'btn btn-wide scan-btn', textContent: '📷 QR kodni skanerlash' });
  b.addEventListener('click', () => openScanner((text) => {
    try {
      const u = new URL(text, location.origin);
      if (u.pathname.endsWith('/ofitsiant.html') && u.hash.includes('o=')) {
        readScan(u.hash);
        return viewOrder(scanned.id, scanned.token);
      }
    } catch {}
    alert('Bu buyurtma QR kodi emas.');
  }));
  return b;
}

// Mijoz chaqiruvlari: "Boraman" — mijoz ofitsiant kelayotganini ko'radi
function callsBox() {
  const box = el('div', { className: 'calls' });
  box.paint = () => box.replaceChildren(...live.calls.map((c) => {
    const b = el('button', { type: 'button', className: 'btn btn-accept call-ack', textContent: 'Boraman' });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/staff/calls/${c.tabId}/ack`, { method: 'POST', body: '{}' });
        await poll();
      } catch (e) {
        if (!gate(e)) alert(e.message);
        b.disabled = false;
      }
    });
    return el('div', { className: `call-card reveal is-${c.kind}` },
      el('span', { className: 'call-icon', textContent: c.kind === 'bill' ? '🧾' : '🔔', ariaHidden: 'true' }),
      el('span', { className: 'call-main' }, el('strong', { textContent: c.tableLabel }), el('span', { textContent: `${c.label} · ${ago(c.at)}${!c.mine && c.waiterName ? ` · ${c.waiterName} stoli` : ''}` })),
      b);
  }));
  return box;
}

function viewCurrent() {
  const stat = (n, label, cls = '') => el('div', { className: `staff-stat ${cls}` }, el('strong', { textContent: n }), el('span', { textContent: label }));
  const stats = el('div', { className: 'staff-stats' });
  const pendingBox = el('ul', { className: 'staff-list' });
  const activeBox = el('ul', { className: 'staff-list' });
  const pendingHead = el('h2', { className: 'list-head' });
  const activeHead = el('h2', { className: 'list-head' });
  const calls = callsBox();
  function render() {
    calls.paint();
    const pending = live.items.filter((o) => o.status === 'yangi');
    const active = live.items.filter(isActive);
    stats.replaceChildren(stat(pending.length, 'yangi', pending.length ? 'is-wait' : ''), stat(active.length, 'jarayonda'), stat(live.stats.acceptedToday, 'bugun siz'));
    pendingHead.textContent = `Yangi buyurtmalar${pending.length ? ` · ${pending.length}` : ''}`;
    pendingBox.replaceChildren(...(pending.length ? pending.map((o) => orderCard(o, { quick: true })) : [emptyLine(live.loaded ? 'Hozircha yangi buyurtma yo‘q.' : 'Yuklanmoqda…')]));
    activeHead.textContent = `Jarayonda${active.length ? ` · ${active.length}` : ''}`;
    activeBox.replaceChildren(...(active.length ? active.map((o) => orderCard(o)) : [emptyLine('Ochiq stollarda qabul qilingan buyurtma yo‘q.')]));
    paintTabs('hozir');
  }
  listeners.clear();
  listeners.add(render);
  app.replaceChildren(
    el('div', { className: 'view-head' }, el('h1', { textContent: 'Hozirgi buyurtmalar' })),
    calls,
    stats,
    pendingHead, pendingBox,
    el('div', { className: 'scan-card' },
      scannerSupported() ? scanButton() : el('p', { className: 'scan-title', textContent: 'Mijozning QR kodini telefon kamerasi bilan skanerlang' }),
      el('p', { className: 'muted small', textContent: 'yoki buyurtma raqamini yozing:' }),
      lookupForm()),
    activeHead, activeBox);
  render();
}

async function viewTables() {
  const box = el('div', { className: 'floor' });
  const newOrder = (t) => (can('order.create') ? openPos({ title: `${t.name} · yangi buyurtma`, target: 'table', tableId: t.id, allowTakeaway: true, onDone: (r) => { poll(); viewTab(r.tabId); } }) : alert('Buyurtma kiritishga ruxsatingiz yo‘q.'));
  const tableBtn = (t) => el('button', {
    type: 'button', className: `floor-table${t.tab ? ' is-busy' : ''}${t.tab?.billPrinted ? ' is-billed' : ''}${t.tab?.pending ? ' has-pending' : ''}${t.tab?.kind === 'saboy' ? ' is-saboy' : ''}${t.tab && t.tab.waiterId === `tg:${profile?.id}` ? ' is-mine' : ''}`,
    onclick: () => (t.tab ? viewTab(t.tab.id) : newOrder(t)),
  },
  el('span', { className: 'floor-name', textContent: `${t.tab?.kind === 'saboy' ? '🥡 ' : ''}${t.name}` }),
  el('span', { className: 'floor-meta', textContent: t.tab ? (t.tab.total ? formatPrice(t.tab.total) : 'tasdiqlang') : t.capacity ? `${t.capacity} kishi · + buyurtma` : '+ buyurtma' }),
  t.tab ? el('span', { className: `floor-waiter${t.tab.waiterName ? '' : ' is-none'}`, textContent: t.tab.waiterId === `tg:${profile?.id}` ? '👤 Siz' : t.tab.waiterName ? `👤 ${t.tab.waiterName}` : 'ofitsiant yo‘q' }) : '',
  t.tab?.billPrinted ? el('span', { className: 'floor-billed', textContent: '🧾 chek chiqdi' }) : '',
  t.tab?.pending ? el('span', { className: 'floor-dot', ariaLabel: 'yangi buyurtma bor' }) : '',
  t.tab?.call && !t.tab.call.ack ? el('span', { className: 'floor-bell', textContent: t.tab.call.kind === 'bill' ? '🧾' : '🔔', ariaLabel: t.tab.call.label }) : '');
  let data = null;
  const paint = () => {
    if (!data || !box.isConnected) return;
    box.replaceChildren(
      !data.halls.length && !data.loose.length ? el('p', { className: 'empty-line', textContent: 'Stollar hali kiritilmagan va ochiq hisob yo‘q.' })
        : floorLayout({ data, key: hallKey, tableBtn, onKey: (k) => {
          hallKey = k;
          try {
            localStorage.setItem('oq_waiter_hall', k);
          } catch {}
          paint();
        } }));
  };
  async function load() {
    try {
      data = await api(withP('/api/staff/tables'));
    } catch (e) {
      if (gate(e)) return;
      return box.replaceChildren(el('p', { className: 'form-error', textContent: e.message }));
    }
    if (!box.isConnected) return; // boshqa bo'limga o'tildi
    paint();
    viewTimer = setTimeout(load, nextDelay());
    viewReload = () => box.isConnected && load();
  }
  listeners.clear();
  listeners.add(() => paintTabs('stollar'));
  app.replaceChildren(el('div', { className: 'view-head view-head-row' }, el('h1', { textContent: 'Stollar' }),
    can('order.create') ? el('button', { type: 'button', className: 'btn btn-small', textContent: '🥡 Saboy buyurtma', onclick: () => openPos({ title: 'Saboy (olib ketish)', target: 'saboy', onDone: (r) => { poll(); viewTab(r.tabId); } }) }) : ''), box);
  box.append(el('p', { className: 'muted', textContent: 'Yuklanmoqda…' }));
  await load();
}

function viewStaffProfile() {
  listeners.clear();
  listeners.add(() => paintTabs('profil'));
  app.replaceChildren(
    el('div', { className: 'view-head' }, el('h1', { textContent: 'Profil' })),
    el('div', { className: 'staff-profile reveal' },
      el('p', { className: 'staff-profile-name', textContent: profile.name || 'Ofitsiant' }),
      profile.phone ? el('p', { className: 'muted', textContent: profile.phone }) : '',
      el('div', { className: 'staff-stats' },
        el('div', { className: 'staff-stat' }, el('strong', { textContent: live.stats.acceptedToday }), el('span', { textContent: 'bugun qabul qildingiz' })),
        el('div', { className: 'staff-stat' }, el('strong', { textContent: formatPrice(live.stats.sumToday) }), el('span', { textContent: 'bugungi summa' })))),
    el('div', { className: 'notice' },
      el('strong', { textContent: 'Bildirishnomalar: ' }),
      'yuqoridagi 🔔 tugmasi ovozni yoqadi. Telefon qulflangan bo‘lsa ham xabar Telegram’ga keladi. Brauzer menyusidan (⋮) “Bosh ekranga qo‘shish”ni tanlang — sahifa ilova kabi ochiladi.'),
    el('button', { type: 'button', className: 'btn btn-ghost btn-wide', textContent: 'Chiqish', onclick: logout }));
}

function viewList() {
  stopView();
  const tab = listTab();
  view.tab = tab;
  paintTabs(tab);
  window.scrollTo(0, 0);
  if (tab === 'stollar') return viewTables();
  if (tab === 'profil') return viewStaffProfile();
  return viewCurrent();
}

/* ───────── Kirish va ruxsat ───────── */
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
  $('#staff-tabs').hidden = true;
  $('#staff-name').textContent = '';
  showLogin();
}

function start() {
  setPerms(profile.perms);
  // boshqa lavozimdagi xodim (omborchi, kassir...) shu oynadan kirsa — o'z sahifasiga
  const other = homeFor('page.ofitsiant');
  if (other) return location.replace(other);
  $('#staff-name').textContent = profile.name || '';
  if (!can('page.ofitsiant')) return gate({ status: 403, message: 'Sizga ofitsiant sahifasi ochilmagan.' });
  if (!$('.sound-toggle')) $('#staff-name').after(soundToggle());
  poll();
  if (scanned) return viewOrder(scanned.id, scanned.token);
  viewList();
}

function showLogin() {
  stopView();
  $('#staff-tabs').hidden = true;
  mountPinLogin(app, {
    title: 'Ofitsiant',
    logo: siteInfo.logo || '/logo.jpg',
    name: siteInfo.name || 'Oqtosh Restoran',
    onSuccess(p) {
      profile = p;
      start();
    },
  });
}

window.addEventListener('hashchange', () => {
  readScan();
  if (!profile || !can('page.ofitsiant')) return;
  if (scanned && location.hash.startsWith('#o=')) return viewOrder(scanned.id, scanned.token);
  scanned = null;
  viewList();
});

readScan();
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
