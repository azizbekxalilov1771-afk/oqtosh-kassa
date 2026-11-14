import { $, el, api, formatPrice, phoneHref, applyInfo, modsLine } from './common.js';
import { mountPinLogin } from './pinlogin.js';
import { setPerms, can, homeFor } from './perms.js';
let siteInfo = {};
import { alertNew, soundToggle, newItemsWatcher } from './alerts.js';
import { qtyText, fmtTime } from './bill.js';
import { pointsMap, navLinks } from './map.js';
import { listenPulse, onPulse, withP, nextDelay } from './livepulse.js';

// Kuryer sahifasi: kassa tasdiqlagan yetkazish buyurtmalari xaritada va ro'yxatda.
// Har bir manzilni Google Maps / Yandex Navigator / Yandex Xarita / telefondagi boshqa ilovada ochish mumkin.
// Bo'limlar: #yangi (olinmagan), #mening (yo'lda), #yetkazilgan

const app = $('#app');
let profile = null;
let origin = null;
const live = { items: [], me: '', loaded: false };
const TABS = ['yangi', 'mening', 'yetkazilgan'];

const addrText = (a) => [a.text, a.apartment && `xonadon ${a.apartment}`, a.entrance && `${a.entrance}-podyezd`, a.floor && `${a.floor}-qavat`].filter(Boolean).join(', ');
const groups = () => ({
  yangi: live.items.filter((o) => o.deliveryStatus !== 'yolda' && o.deliveryStatus !== 'yetkazildi'),
  mening: live.items.filter((o) => o.deliveryStatus === 'yolda' && o.courierId === live.me),
  yetkazilgan: live.items.filter((o) => o.deliveryStatus === 'yetkazildi' && o.courierId === live.me),
});

/* ───────── Kuzatuv ───────── */
const watch = newItemsWatcher();
let pollTimer = null;
async function poll({ repaint = true } = {}) {
  clearTimeout(pollTimer);
  try {
    const r = await api(withP('/api/kuryer/orders'));
    listenPulse(r.pulse?.url);
    const sig = JSON.stringify(r.items.map((o) => [o.id, o.deliveryStatus, o.courierId, o.total]));
    if (sig === live.sig) repaint = false; // o'zgarish yo'q — sahifani qayta chizmaymiz
    live.sig = sig;
    live.items = r.items;
    live.me = r.me;
    live.loaded = true;
    const g = groups();
    watch(g.yangi.map((o) => o.id), (ids) => alertNew(ids.length > 1 ? `${ids.length} ta yangi yetkazish` : 'Yangi yetkazish', g.yangi.find((o) => o.id === ids[0])?.address?.text || ''));
    document.title = `${g.yangi.length ? `(${g.yangi.length}) ` : ''}Kuryer`;
    paintBadges(g);
    if (repaint) render();
  } catch (e) {
    if (gate(e)) return;
  }
  pollTimer = setTimeout(poll, nextDelay());
}
onPulse(() => {
  if (profile && live.loaded) poll();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && profile && live.loaded) poll();
});

function paintBadges(g) {
  for (const [id, n] of [['badge-yangi', g.yangi.length], ['badge-mening', g.mening.length]]) {
    const b = $(`#${id}`);
    b.hidden = !n;
    b.textContent = n;
  }
}

/* ───────── Ko'rinish ───────── */
const currentTab = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'yangi');
let openId = '';
let mapKey = '';
let mapNode = null;

function card(o, i) {
  const a = o.address || {};
  const mine = o.courierId === live.me;
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const act = async (btn, path, ask) => {
    if (ask && !confirm(ask)) return;
    err.hidden = true;
    btn.disabled = true;
    try {
      await api(`/api/kuryer/orders/${o.id}/${path}`, { method: 'POST', body: '{}' });
      openId = o.id;
      if (path === 'take') location.hash = 'mening';
      await poll();
    } catch (e) {
      if (gate(e)) return;
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
      poll();
    }
  };
  const actions = [];
  if (o.deliveryStatus === 'yetkazildi') actions.push(el('p', { className: 'status-chip is-ok', textContent: `Yetkazildi · ${fmtTime(o.deliveredAt)}` }));
  else if (o.deliveryStatus === 'yolda' && mine) {
    const b = el('button', { type: 'button', className: 'btn btn-accept btn-wide', textContent: '✓ Yetkazildi' });
    b.addEventListener('click', () => act(b, 'delivered', `#${o.number}: mijozga topshirdingizmi va ${formatPrice(o.total)} oldingizmi?`));
    actions.push(b);
  } else {
    const b = el('button', { type: 'button', className: 'btn btn-wide', textContent: 'Olaman — yo‘lga chiqdim' });
    b.addEventListener('click', () => act(b, 'take'));
    actions.push(b);
  }
  const hasPoint = Number.isFinite(a.lat) && Number.isFinite(a.lng);
  const details = el('details', { className: 'route-items' }, el('summary', { textContent: `Tarkibi · ${o.items.length} xil` }),
    el('ul', { className: 'order-lines' }, o.items.map((x) => el('li', {}, el('span', {}, `${qtyText(x)} ${x.name}`, x.mods?.length ? el('small', { className: 'line-mods', textContent: modsLine(x.mods) }) : ''), el('span', { textContent: formatPrice(x.sum) })))),
    o.comment ? el('p', { className: 'muted small', textContent: `Izoh: ${o.comment}` }) : '');
  details.open = openId === o.id;
  details.addEventListener('toggle', () => {
    if (details.open) openId = o.id;
    else if (openId === o.id) openId = '';
  });
  return el('li', { className: 'route-card reveal', id: `o-${o.id}`, style: `--i:${Math.min(i, 10)}` },
    el('div', { className: 'route-head' },
      el('span', { className: 'route-no', textContent: `#${o.number}` }),
      o.deliveryKm ? el('span', { className: 'route-km', textContent: `${String(o.deliveryKm).replace('.', ',')} km` }) : '',
      el('span', { className: 'route-sum' }, el('small', { textContent: 'olinadi ' }), formatPrice(o.total))),
    el('p', { className: 'route-addr', textContent: addrText(a) }),
    a.landmark ? el('p', { className: 'muted small', textContent: `Mo‘ljal: ${a.landmark}` }) : '',
    el('p', { className: 'muted small', textContent: `${o.customerName || 'Mijoz'} · tayyor: ${fmtTime(o.acceptedAt)}${o.courierName && !mine ? ` · ${o.courierName}` : ''}` }),
    el('div', { className: 'route-btns' },
      o.deliveryPhone ? el('a', { className: 'btn btn-ghost btn-small', href: phoneHref(o.deliveryPhone), textContent: `📞 ${o.deliveryPhone}` }) : '',
      ...(hasPoint ? navLinks(a.lat, a.lng).map(([t, href]) => el('a', { className: 'nav-btn', href, target: href.startsWith('http') ? '_blank' : '', rel: 'noopener', textContent: t })) : [])),
    details, err, ...actions);
}

function render() {
  if (!profile) return;
  const tab = currentTab();
  const nav = $('#kuryer-tabs');
  nav.hidden = false;
  for (const a of nav.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const list = groups()[tab];
  const titles = { yangi: 'Yangi buyurtmalar', mening: 'Men olib ketayotganlar', yetkazilgan: 'Bugun yetkazdim' };
  // xarita faqat ro'yxat o'zgarganda qayta chiziladi
  const points = list.filter((o) => Number.isFinite(o.address?.lat)).map((o) => ({ lat: o.address.lat, lng: o.address.lng, label: `#${o.number}`, id: o.id, mine: o.courierId === live.me }));
  const key = `${tab}:${points.map((p) => p.id).join(',')}`;
  if (key !== mapKey || !mapNode) {
    mapKey = key;
    mapNode = points.length && tab !== 'yetkazilgan' ? pointsMap(points, { origin, onPick: (p) => document.getElementById(`o-${p.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }) : el('div');
  }
  const sum = list.reduce((s, o) => s + o.total, 0);
  app.replaceChildren(
    el('div', { className: 'view-head' }, el('h1', { textContent: titles[tab] }),
      el('p', { className: 'muted', textContent: live.loaded ? `${list.length} ta${list.length ? ` · ${formatPrice(sum)}` : ''}` : 'Yuklanmoqda…' })),
    mapNode,
    el('ul', { className: 'route-list' }, list.length ? list.map(card) : el('li', { className: 'empty-line', textContent: live.loaded ? (tab === 'yangi' ? 'Hozircha yangi yetkazish yo‘q. Kelsa — ovoz chiqadi.' : 'Bo‘sh.') : '' })));
}

/* ───────── Kirish ───────── */
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
  $('#kuryer-tabs').hidden = true;
  $('#staff-name').textContent = '';
  showLogin();
}

function start() {
  setPerms(profile.perms);
  const other = homeFor('page.kuryer');
  if (other) return location.replace(other);
  $('#staff-name').textContent = profile.name || '';
  if (!can('page.kuryer')) return gate({ status: 403, message: 'Sizga kuryer sahifasi ochilmagan.' });
  if (!$('.sound-toggle')) $('#staff-name').after(soundToggle());
  if (!$('.logout-mini')) $('.app-header').append(el('button', { type: 'button', className: 'logout-mini', textContent: 'Chiqish', onclick: logout }));
  render();
  poll();
}

function showLogin() {
  $('#kuryer-tabs').hidden = true;
  mountPinLogin(app, {
    title: 'Kuryer',
    logo: siteInfo.logo || '/logo.jpg',
    name: siteInfo.name || 'Oqtosh Restoran',
    onSuccess(p) {
      profile = p;
      start();
    },
  });
}

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});

try {
  const [info, me, d] = await Promise.all([api('/api/info'), api('/api/me'), api('/api/delivery').catch(() => ({}))]);
  siteInfo = info;
  applyInfo({ ...info, name: undefined });
  origin = d.origin || null;
  profile = me.profile;
  if (profile) start();
  else showLogin();
} catch {
  app.replaceChildren(el('div', { className: 'empty-state' }, el('h2', { textContent: 'Sahifani yuklab bo‘lmadi' }), el('p', { textContent: 'Internetni tekshiring va yangilang.' })));
}
