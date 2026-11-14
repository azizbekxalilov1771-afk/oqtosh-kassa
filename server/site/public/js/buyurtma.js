import { $, $$, el, api, formatPrice, phoneHref, applyInfo, modsLine, dishFacts } from './common.js';
import { mountLogin } from './tglogin.js';
import { qrSvg } from './vendor/qrcode.js';
import { billCard, qtyText, fmtKg, pctText, STATUS_CLASS } from './bill.js';
import { locationPicker } from './map.js';

// Buyurtma bo'limi: Telegram orqali kirish → menyu → savat → restoranda (stolga) yoki yetkazib berish.
// Stolga: bitta stolda bitta mijoz; qayta buyurtmalar o'sha stol hisobiga qo'shiladi; ofitsiantga ovozli xabar boradi.
// Bo'limlar: #menyu, #savat, #buyurtmalar, #buyurtma=<id>, #profil

const app = $('#app');
const state = { info: null, profile: null, menu: null, tables: null, delivery: { enabled: false }, tab: null, cat: 'all', q: '' };
let cleanup = () => {};

/* ───────── Savat (shu brauzerda saqlanadi) ───────── */
// Qator: taom + qo'shimchalar. Og'irlikdagi taom: qty — kilogramm (w: true) yoki amount — "100 000 so'mlik".
const CART_KEY = 'oq_cart_v2';
const round3 = (n) => Math.round(n * 1000) / 1000;
const lineKey = (id, mods = []) => `${id}|${[...mods].sort((a, b) => (a.id < b.id ? -1 : 1)).map((m) => `${m.id}:${m.qty}`).join(',')}`;
const cart = (() => {
  let data = { lines: {}, table: '', tableId: '', comment: '', mode: 'table', address: {}, phone: '' };
  try {
    data = { ...data, ...JSON.parse(localStorage.getItem(CART_KEY) || '{}') };
    const old = JSON.parse(localStorage.getItem('oq_cart_v1') || 'null'); // eski savat
    if (old?.items && !Object.keys(data.lines).length) {
      for (const [id, qty] of Object.entries(old.items)) data.lines[lineKey(id)] = { id, qty, mods: [] };
      data.table ||= old.table || '';
      localStorage.removeItem('oq_cart_v1');
    }
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(data));
    } catch {}
    paintCartBadge();
  };
  const prop = (k) => ({ get: () => data[k], set: (v) => { data[k] = v; save(); } });
  const self = {
    lines: () => Object.entries(data.lines).map(([key, l]) => ({ key, ...l })),
    qtyOf: (id) => Object.values(data.lines).filter((l) => l.id === id && !l.w && !l.amount).reduce((s, l) => s + l.qty, 0),
    kgOf: (id) => round3(Object.values(data.lines).filter((l) => l.id === id && l.w).reduce((s, l) => s + l.qty, 0)),
    keyQty: (key) => data.lines[key]?.qty || 0,
    add(id, mods = [], qty = 1, { weighted = false } = {}) {
      const key = lineKey(id, mods);
      data.lines[key] = { id, mods, qty: Math.min(50, round3((data.lines[key]?.qty || 0) + qty)), ...(weighted ? { w: true } : {}) };
      save();
    },
    addAmount(id, mods, amount) {
      const key = `${lineKey(id, mods)}|a`;
      data.lines[key] = { id, mods, amount: (data.lines[key]?.amount || 0) + amount };
      save();
    },
    setQty(key, qty) {
      if (qty > 0 && data.lines[key]) data.lines[key].qty = Math.min(50, round3(qty));
      else delete data.lines[key];
      save();
    },
    remove(key) {
      delete data.lines[key];
      save();
    },
    count: () => Object.values(data.lines).reduce((s, l) => s + (l.w || l.amount ? 1 : l.qty), 0),
    clear() {
      data.lines = {};
      data.comment = '';
      save();
    },
  };
  for (const k of ['table', 'tableId', 'comment', 'mode', 'address', 'phone']) Object.defineProperty(self, k, prop(k));
  return self;
})();

// Stol QR stikeridan kelgan bo'lsa: /buyurtma.html?stol_id=501 (Mison stoli) yoki eski ko'rinish ?stol=5.
// Bosh sahifadagi "Yetkazib berish" tugmasi: /buyurtma.html?yetkazish
const params = new URLSearchParams(location.search);
const urlTableId = params.get('stol_id');
const urlTable = params.get('stol');
let qrTable = false; // stol QR orqali tanlangan — tanlash oynasi yashiriladi
if (urlTableId && /^[\w-]{1,40}$/.test(urlTableId)) {
  cart.tableId = urlTableId;
  cart.table = '';
  cart.mode = 'table';
  qrTable = true;
} else if (urlTable && /^[\p{L}\d -]{1,10}$/u.test(urlTable)) {
  cart.table = urlTable;
  cart.tableId = '';
  cart.mode = 'table';
  qrTable = true;
} else if (params.has('yetkazish')) cart.mode = 'delivery';
else if (params.has('restoranda')) cart.mode = 'table';

const deliveryOn = () => state.delivery.enabled && !qrTable;
const mode = () => (deliveryOn() && cart.mode === 'delivery' ? 'delivery' : 'table');

// Mison POS'dagi zal va stollar (bo'lmasa — stol raqami qo'lda yoziladi)
async function ensureTables() {
  if (state.tables) return state.tables;
  try {
    state.tables = await api('/api/tables');
  } catch {
    state.tables = { halls: [] };
  }
  const all = state.tables.halls.flatMap((h) => h.tables);
  if (all.length && !cart.tableId && cart.table) {
    // eski "?stol=5" havolasi: nomi aniq bitta stolga mos kelsa — o'sha stol
    const key = (v) => String(v).toLowerCase().replace(/стол|stol|table|№|#/g, '').replace(/[^\p{L}\d]/gu, '');
    const hits = all.filter((t) => key(t.name) === key(cart.table));
    if (hits.length === 1) cart.tableId = hits[0].id;
  }
  if (cart.tableId && all.length && !all.some((t) => t.id === cart.tableId)) cart.tableId = '';
  return state.tables;
}

async function loadTab() {
  try {
    state.tab = (await api('/api/tab')).tab;
  } catch {
    state.tab = null;
  }
  return state.tab;
}

// Stol tanlash: avval zal, keyin shu zaldagi stollar. Band stollar — "Band" (kim o'tirgani ko'rinmaydi)
function tablePicker(tables, occ, onPick) {
  const halls = tables.halls.filter((h) => h.tables.length);
  const busy = new Set(occ.busy || []);
  let hallId = halls.length === 1 ? halls[0].id : halls.find((h) => h.tables.some((t) => t.id === cart.tableId))?.id || null;
  const box = el('div', { className: 'table-picker' });
  function paint() {
    const hall = halls.find((h) => h.id === hallId);
    if (!hall) {
      box.replaceChildren(el('div', { className: 'hall-grid' }, halls.map((h, i) => {
        const free = h.tables.filter((t) => !busy.has(t.id)).length;
        return el('button', { type: 'button', className: 'hall-card reveal', style: `--i:${i}`, onclick: () => { hallId = h.id; paint(); } },
          el('span', { className: 'hall-name', textContent: h.name }),
          el('span', { className: 'hall-meta', textContent: `${h.tables.length} ta stol · ${free} ta bo‘sh` }),
          el('span', { className: 'hall-go', textContent: '→', ariaHidden: 'true' }));
      })));
      return;
    }
    box.replaceChildren(
      halls.length > 1 ? el('div', { className: 'picker-head' },
        el('button', { type: 'button', className: 'back', textContent: '← Zallar', onclick: () => { hallId = null; paint(); } }),
        el('strong', { textContent: hall.name })) : '',
      el('div', { className: 'table-grid', role: 'radiogroup', ariaLabel: hall.name }, hall.tables.map((t, i) => {
        const on = t.id === cart.tableId;
        const taken = busy.has(t.id);
        const b = el('button', { type: 'button', className: `table-btn reveal${on ? ' is-on' : ''}${taken ? ' is-busy' : ''}`, role: 'radio', disabled: taken, style: `--i:${i}` },
          el('span', { className: 'table-name', textContent: t.name }),
          el('span', { className: 'table-seats', textContent: taken ? 'Band' : t.capacity ? `${t.capacity} kishi` : 'Bo‘sh' }));
        b.setAttribute('aria-checked', String(on));
        b.addEventListener('click', () => {
          cart.tableId = t.id;
          cart.table = '';
          paint();
          onPick(t);
        });
        return b;
      })),
      el('p', { className: 'muted small legend' }, el('span', { className: 'dot is-free' }), ' bo‘sh  ', el('span', { className: 'dot is-busy' }), ' band — boshqa mijoz o‘tiribdi'));
  }
  paint();
  return box;
}

// Qo'shimchalar narxi (serverdagi hisob bilan bir xil; yakuniy narxni server/kassa hisoblaydi)
function unitPrice(item, mods) {
  const all = new Map((item.options || []).flatMap((g) => g.items.map((i) => [i.id, i])));
  return item.price + mods.reduce((s, m) => {
    const it = all.get(m.id);
    if (!it) return s;
    return s + (it.incl ? Math.max(0, m.qty - (it.def || 0)) : m.qty) * it.price;
  }, 0);
}

function modsValid(item, mods) {
  const all = new Map((item.options || []).flatMap((g) => g.items.map((i) => [i.id, i])));
  return mods.every((m) => all.has(m.id) && !all.get(m.id).off);
}

function cartLines() {
  const byId = new Map((state.menu?.items || []).map((i) => [String(i.id), i]));
  return cart.lines().map((l) => {
    const item = byId.get(l.id);
    if (!item || !modsValid(item, l.mods)) return null;
    if (Boolean(l.w || l.amount) !== Boolean(item.byWeight)) return null; // og'irlik sozlamasi o'zgargan
    const names = new Map((item.options || []).flatMap((g) => g.items.map((i) => [i.id, i.name])));
    const price = unitPrice(item, l.mods);
    const sum = l.amount || Math.round(price * l.qty);
    return { ...l, item, price, sum, kg: l.amount ? round3(l.amount / price) : l.qty, modNames: l.mods.map((m) => ({ name: names.get(m.id), qty: m.qty })) };
  }).filter(Boolean);
}
const cartTotal = () => cartLines().reduce((s, l) => s + l.sum, 0);

function paintCartBadge() {
  const n = cart.count();
  const badge = $('#cart-badge');
  badge.hidden = !n;
  badge.textContent = n;
  const bar = $('#cart-bar');
  bar.hidden = !n || !state.profile || viewName() !== 'menyu';
  if (!bar.hidden) $('#cart-bar-text').textContent = `${n} ta · ${formatPrice(cartTotal())}`;
}

/* ───────── Umumiy ───────── */
function stepperView(qty, { onMinus, onPlus, max = 50, text }) {
  const minus = el('button', { type: 'button', className: 'step-btn', textContent: '−', ariaLabel: 'Kamaytirish' });
  const plus = el('button', { type: 'button', className: 'step-btn', textContent: '+', ariaLabel: 'Ko‘paytirish', disabled: qty >= max });
  minus.addEventListener('click', onMinus);
  plus.addEventListener('click', onPlus);
  return el('div', { className: 'stepper' }, minus, el('span', { className: 'step-qty', textContent: text ?? qty, ariaLive: 'polite' }), plus);
}

const maxFor = (item) => (item.left > 0 ? Math.min(50, item.left) : 50);

// Qo'shimchasiz oddiy taom: menyuda to'g'ridan-to'g'ri −/+
function stepper(item, onChange) {
  const key = lineKey(String(item.id));
  const qty = cart.keyQty(key);
  if (!qty) {
    const add = el('button', { type: 'button', className: 'btn btn-small add-btn', textContent: 'Qo‘shish' });
    add.addEventListener('click', () => {
      cart.add(String(item.id));
      onChange();
    });
    return add;
  }
  return stepperView(qty, {
    max: maxFor(item) - (cart.qtyOf(String(item.id)) - qty),
    onMinus: () => { cart.setQty(key, qty - 1); onChange(); },
    onPlus: () => { cart.setQty(key, qty + 1); onChange(); },
  });
}

// Mode tanlash: restoranda yoki yetkazib berish
function modeSwitch(onChange) {
  const box = el('div', { className: 'mode-switch', role: 'tablist', ariaLabel: 'Buyurtma turi' });
  const paint = () => box.replaceChildren(...[['table', '🍽', 'Restoranda'], ['delivery', '🛵', 'Yetkazib berish']].map(([v, icon, label]) => {
    const b = el('button', { type: 'button', role: 'tab' }, el('span', { className: 'mode-icon', textContent: icon, ariaHidden: 'true' }), label);
    b.setAttribute('aria-selected', String(mode() === v));
    b.addEventListener('click', () => {
      if (mode() === v) return;
      cart.mode = v;
      paint();
      onChange?.();
    });
    return b;
  }));
  paint();
  return box;
}

const deliveryRule = (d) => d.note || (d.flat ? `Yetkazish narxi — ${formatPrice(d.baseFee)}.` : null) || `${d.baseRadiusKm ? `${String(d.baseRadiusKm).replace('.', ',')} km gacha` : 'Yaqin masofaga'} — ${formatPrice(d.baseFee)}${d.perKm ? `, undan keyin har km uchun +${formatPrice(d.perKm)}` : ''}.`;

/* ───────── Taom tanlash oynasi (qo'shimchalar, og'irlik) ───────── */
function groupRule(g) {
  if (g.required) return g.max === 1 || g.min === g.max ? (g.min > 1 ? `Majburiy — ${g.min} ta tanlang` : 'Majburiy — bittasini tanlang') : `Majburiy — kamida ${g.min} ta${g.max ? `, ko‘pi bilan ${g.max} ta` : ''}`;
  return g.max ? `Ixtiyoriy — ko‘pi bilan ${g.max} ta` : 'Ixtiyoriy';
}

const digits = (v) => Number(String(v).replace(/\D/g, '')) || 0;

function openOptions(item, onAdded) {
  const options = item.options || [];
  const bw = item.byWeight;
  const chosen = new Map(); // modId → qty
  for (const g of options) for (const m of g.items) if (m.def > 0 && !m.off) chosen.set(m.id, m.def);
  let qty = 1;
  // og'irlik: kg yoki summa
  let wMode = 'kg';
  let kg = bw ? Math.max(bw.min, 1) : 0;
  let amount = 0;
  const dialog = el('dialog', { className: 'sheet', ariaLabel: item.name });
  const priceBtn = el('button', { type: 'submit', className: 'btn btn-wide' });
  const hint = el('p', { className: 'sheet-hint', ariaLive: 'polite' });
  const qtyBox = el('div', { className: 'sheet-qty' });
  const groupsBox = el('div', { className: 'sheet-groups' });
  const weightBox = el('div', { className: 'weight-box' });
  const amountInput = el('input', { type: 'text', inputMode: 'numeric', className: 'amount-input', placeholder: 'Masalan: 100 000', ariaLabel: 'Summa, so‘m', autocomplete: 'off' });
  amountInput.addEventListener('input', () => {
    amount = digits(amountInput.value);
    paint({ keepWeight: true });
  });

  const count = (g) => g.items.reduce((s, m) => s + (chosen.get(m.id) || 0), 0);
  const missing = () => options.find((g) => g.required && count(g) < Math.max(1, g.min));
  const mods = () => [...chosen].filter(([, q]) => q > 0).map(([id, q]) => ({ id, qty: q }));
  const price = () => unitPrice(item, mods());
  const minAmount = () => Math.max(1000, Math.ceil(price() * (bw?.min || 0)));

  function paintGroups() {
    groupsBox.replaceChildren(...(bw ? [weightBox] : []), ...options.map((g) => {
      const single = g.max === 1;
      const full = g.max && count(g) >= g.max;
      return el('fieldset', { className: 'sheet-group' },
        el('legend', {}, el('span', { textContent: g.name }), el('small', { className: g.required && count(g) < Math.max(1, g.min) ? 'need' : '', textContent: groupRule(g) })),
        g.items.map((m) => {
          const on = (chosen.get(m.id) || 0) > 0;
          const input = el('input', { type: single ? 'radio' : 'checkbox', name: `g${g.id}`, checked: on, disabled: m.off || (!on && full && !single) });
          input.addEventListener('click', () => {
            if (single) {
              const wasOn = on;
              for (const x of g.items) chosen.delete(x.id);
              if (!(wasOn && !g.required)) chosen.set(m.id, 1);
            } else if (on) chosen.delete(m.id);
            else chosen.set(m.id, 1);
            paint();
          });
          return el('label', { className: `sheet-opt${m.off ? ' is-off' : ''}` }, input,
            el('span', { className: 'sheet-opt-name', textContent: m.off ? `${m.name} (tugagan)` : m.name }),
            el('span', { className: 'sheet-opt-price', textContent: m.price ? `+${formatPrice(m.price)}` : '' }));
        }));
    }));
  }

  function paintWeight() {
    const seg = el('div', { className: 'seg', role: 'tablist', ariaLabel: 'Qanday o‘lchaymiz' }, [['kg', 'Og‘irlik bo‘yicha'], ['sum', 'Summa bo‘yicha']].map(([v, t]) => {
      const b = el('button', { type: 'button', role: 'tab', textContent: t });
      b.setAttribute('aria-selected', String(wMode === v));
      b.addEventListener('click', () => {
        wMode = v;
        paint();
        if (v === 'sum') setTimeout(() => amountInput.focus(), 30);
      });
      return b;
    }));
    const quick = (vals, fmt, isOn, pick) => el('div', { className: 'chips quick-chips' }, vals.map((v) => {
      const b = el('button', { type: 'button', textContent: fmt(v) });
      b.setAttribute('aria-pressed', String(isOn(v)));
      b.addEventListener('click', () => pick(v));
      return b;
    }));
    const body = wMode === 'kg'
      ? el('div', { className: 'weight-kg' },
        stepperView(kg, {
          text: fmtKg(kg), max: 50,
          onMinus: () => { if (kg - bw.step >= bw.min - 1e-9) { kg = round3(kg - bw.step); paint(); } },
          onPlus: () => { kg = round3(kg + bw.step); paint(); },
        }),
        quick([0.5, 1, 1.5, 2].filter((v) => v >= bw.min - 1e-9 && Math.abs(v / bw.step - Math.round(v / bw.step)) < 1e-6), fmtKg, (v) => Math.abs(v - kg) < 1e-9, (v) => { kg = v; paint(); }),
        el('p', { className: 'muted small', textContent: `1 kg — ${formatPrice(price())}. Qadam ${fmtKg(bw.step)}${bw.min > bw.step ? `, eng kami ${fmtKg(bw.min)}` : ''}.` }))
      : el('div', { className: 'weight-sum' },
        el('label', { className: 'amount-field' }, amountInput, el('span', { textContent: 'so‘m' })),
        quick([50000, 100000, 150000, 200000].filter((v) => v >= minAmount()), (v) => formatPrice(v).replace(' so‘m', ''), (v) => v === amount, (v) => { amount = v; amountInput.value = String(v); paint(); }),
        el('p', { className: 'muted small', textContent: amount ? `≈ ${fmtKg(round3(amount / price()))} · oshpaz shu summaga tortib beradi` : `Qancha so‘mlik kerakligini yozing (eng kami ${formatPrice(minAmount())}).` }));
    weightBox.replaceChildren(el('p', { className: 'weight-title', textContent: 'Qancha kerak?' }), seg, body);
  }

  function paint({ keepWeight = false } = {}) {
    if (!keepWeight) paintGroups();
    const need = missing();
    if (bw) {
      if (!keepWeight) paintWeight();
      else weightBox.querySelector('.weight-sum > p').textContent = amount ? `≈ ${fmtKg(round3(amount / price()))} · oshpaz shu summaga tortib beradi` : `Qancha so‘mlik kerakligini yozing (eng kami ${formatPrice(minAmount())}).`;
      qtyBox.replaceChildren();
      const sum = wMode === 'kg' ? Math.round(price() * kg) : amount;
      const low = wMode === 'sum' && amount < minAmount();
      priceBtn.disabled = Boolean(need) || low;
      priceBtn.textContent = low ? 'Summani yozing' : `Qo‘shish · ${formatPrice(sum)}`;
    } else {
      const max = maxFor(item) - cart.qtyOf(String(item.id));
      if (qty > max) qty = Math.max(1, max);
      qtyBox.replaceChildren(stepperView(qty, { max, onMinus: () => { if (qty > 1) { qty--; paint(); } }, onPlus: () => { qty++; paint(); } }));
      priceBtn.disabled = Boolean(need) || max < 1;
      priceBtn.textContent = max < 1 ? 'Qolgani savatda' : `Qo‘shish · ${formatPrice(price() * qty)}`;
    }
    hint.textContent = need ? `"${need.name}" dan tanlang` : '';
  }

  const close = el('button', { type: 'button', className: 'sheet-close', textContent: '×', ariaLabel: 'Yopish' });
  close.addEventListener('click', () => dialog.close());
  const form = el('form', { method: 'dialog', className: 'sheet-body' },
    el('div', { className: 'sheet-head' },
      item.image ? el('img', { src: item.image, alt: '', width: 72, height: 72, onerror() { this.remove(); } }) : '',
      el('div', {},
        el('h2', { textContent: item.name }),
        dishFacts(item) && el('p', { className: 'muted', textContent: dishFacts(item) }),
        el('p', { className: 'order-item-price', textContent: `${formatPrice(item.price)}${bw ? ' / kg' : ''}` })),
      close),
    item.description && el('p', { className: 'order-item-desc', textContent: item.description }),
    groupsBox,
    el('div', { className: 'sheet-foot' }, qtyBox, el('div', { className: 'sheet-submit' }, hint, priceBtn)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (missing() || priceBtn.disabled) return;
    if (bw && wMode === 'sum') cart.addAmount(String(item.id), mods(), amount);
    else if (bw) cart.add(String(item.id), mods(), kg, { weighted: true });
    else cart.add(String(item.id), mods(), qty);
    dialog.close();
    onAdded();
  });
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // fonni bosish — yopish
  document.body.append(dialog);
  paint();
  dialog.showModal();
}

const errorBox = (text) => el('p', { className: 'form-error', role: 'alert', textContent: text });

function emptyState(title, text, action) {
  return el('div', { className: 'empty-state reveal' }, el('h2', { textContent: title }), text && el('p', { textContent: text }), action || '');
}

async function ensureMenu() {
  if (state.menu) return state.menu;
  state.menu = await api('/api/menu');
  if (!state.menu.categories?.length) state.menu.categories = [...new Set(state.menu.items.map((i) => i.category))];
  return state.menu;
}

// Ochiq stol hisobi haqida qisqa xabar
// Stoldan ofitsiantni chaqirish: stol ofitsiantiga (bo'lmasa — hamma ofitsiantlarga) ovozli va Telegram xabari
function callCard(tab) {
  const status = el('p', { className: 'call-status', ariaLive: 'polite' });
  let timer = null;
  const paint = (c) => {
    status.textContent = !c ? '' : c.ack ? `✓ ${c.ackByName || 'Ofitsiant'} kelmoqda` : `${c.kind === 'bill' ? 'Hisob so‘raldi' : 'Ofitsiant chaqirildi'} — xabar yuborildi, kuting`;
    status.className = `call-status${c?.ack ? ' is-ok' : c ? ' is-wait' : ''}`;
  };
  const watchAck = (until) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!status.isConnected) return;
      try {
        const { tab: t } = await api('/api/tab');
        paint(t?.call);
        if (t?.call && !t.call.ack && Date.now() < until) watchAck(until);
      } catch {}
    }, 6000);
  };
  const btn = (kind, icon, label) => {
    const b = el('button', { type: 'button', className: `call-btn is-${kind}` }, el('span', { className: 'call-btn-icon', textContent: icon, ariaHidden: 'true' }), el('span', { textContent: label }));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api('/api/tab/call', { method: 'POST', body: JSON.stringify({ kind }) });
        paint(r.call);
        navigator.vibrate?.(40);
        watchAck(Date.now() + 5 * 60_000);
      } catch (e) {
        if (e.code === 'login') return showLogin();
        status.textContent = e.message;
        status.className = 'call-status is-bad';
      } finally {
        setTimeout(() => (b.disabled = false), 3000);
      }
    });
    return b;
  };
  paint(tab.call);
  if (tab.call && !tab.call.ack) watchAck(Date.now() + 5 * 60_000);
  return el('div', { className: 'call-box reveal' }, el('div', { className: 'call-btns' }, btn('waiter', '🔔', 'Ofitsiantni chaqirish'), btn('bill', '🧾', 'Hisobni so‘rash')), status);
}

const tabBanner = (tab) => el('a', { className: 'tab-banner reveal', href: '#buyurtmalar' },
  el('span', { className: 'tab-banner-icon', textContent: '🍽', ariaHidden: 'true' }),
  el('span', {}, el('strong', { textContent: tab.tableLabel }), el('span', { className: 'muted small', textContent: ` · hisob ${formatPrice(tab.total)}` }),
    el('small', { textContent: 'Yangi buyurtmalar shu stol hisobiga qo‘shiladi' })),
  el('span', { className: 'tab-banner-go', textContent: 'Hisob →' }));

/* ───────── Menyu ───────── */
async function viewMenu() {
  const [menu] = await Promise.all([ensureMenu(), loadTab()]);
  if (!menu.items.length) {
    return app.replaceChildren(emptyState('Menyu hozircha bo‘sh', 'Birozdan so‘ng qayta kiring yoki ofitsiantni chaqiring.'));
  }
  const list = el('div', { className: 'order-menu' });
  const search = el('input', { type: 'search', placeholder: 'Taom qidirish', ariaLabel: 'Taom qidirish', value: state.q, className: 'search' });
  const chips = el('div', { className: 'chips', ariaLabel: 'Kategoriyalar' });

  function paintChips() {
    const cats = [['all', 'Hammasi'], ...menu.categories.map((c) => [c, c])];
    chips.replaceChildren(...cats.map(([v, label]) => {
      const b = el('button', { type: 'button', textContent: label });
      b.setAttribute('aria-pressed', String(state.cat === v));
      b.addEventListener('click', () => {
        state.cat = v;
        paintChips();
        paint();
      });
      return b;
    }));
    chips.hidden = menu.categories.length < 2;
  }

  function row(item, i) {
    const id = String(item.id);
    const holder = el('div', { className: 'row-action' });
    const refresh = () => {
      if (!item.available) holder.replaceChildren(el('span', { className: 'off-label', textContent: 'Mavjud emas' }));
      else if (item.byWeight) {
        const n = cart.kgOf(id) + cart.lines().filter((l) => l.id === id && l.amount).length;
        const pick = el('button', { type: 'button', className: `btn btn-small add-btn${n ? ' is-in' : ''}`, textContent: n ? `Savatda ✓` : 'Tanlash' });
        pick.addEventListener('click', () => openOptions(item, refresh));
        holder.replaceChildren(pick);
      } else if (item.options?.length) {
        const n = cart.qtyOf(id);
        const pick = el('button', { type: 'button', className: `btn btn-small add-btn${n ? ' is-in' : ''}`, textContent: n ? `Yana · ${n}` : 'Tanlash' });
        pick.addEventListener('click', () => openOptions(item, refresh));
        holder.replaceChildren(pick);
      } else holder.replaceChildren(stepper(item, refresh));
      paintCartBadge();
    };
    refresh();
    const li = el('li', { className: `order-item reveal${item.available ? '' : ' is-off'}`, style: `--i:${Math.min(i, 12)}` });
    if (item.image) {
      const img = el('img', { src: item.image, alt: '', loading: 'lazy', decoding: 'async', width: 64, height: 64 });
      img.addEventListener('error', () => img.remove());
      li.append(img);
    }
    li.append(el('div', { className: 'order-item-main' },
      el('p', { className: 'order-item-name', textContent: item.name }),
      item.description && el('p', { className: 'order-item-desc', textContent: item.description }),
      dishFacts(item) && el('p', { className: 'order-item-facts', textContent: dishFacts(item) }),
      el('p', { className: 'order-item-price', textContent: `${formatPrice(item.price)}${item.byWeight ? ' / kg' : item.options?.some((g) => g.items.some((m) => m.price > 0)) ? 'dan' : ''}` })), holder);
    return li;
  }

  function paint() {
    const q = state.q.toLocaleLowerCase('uz');
    const visible = menu.items.filter((i) => (state.cat === 'all' || i.category === state.cat) && (!q || `${i.name} ${i.description}`.toLocaleLowerCase('uz').includes(q)));
    if (!visible.length) return list.replaceChildren(emptyState('Hech narsa topilmadi', 'Boshqa so‘z bilan qidirib ko‘ring.'));
    list.replaceChildren(...menu.categories
      .map((cat) => [cat, visible.filter((i) => i.category === cat)])
      .filter(([, items]) => items.length)
      .map(([cat, items]) => el('section', { className: 'order-group' }, el('h2', { textContent: cat }), el('ul', {}, items.map(row)))));
  }

  search.addEventListener('input', () => {
    state.q = search.value.trim();
    paint();
  });
  paintChips();
  paint();
  const hello = state.profile.name ? `Assalomu alaykum, ${state.profile.name}!` : 'Assalomu alaykum!';
  const modeNote = el('p', { className: 'mode-note muted small' });
  const paintModeNote = () => (modeNote.textContent = mode() === 'delivery' ? `Yetkazib berish: ${deliveryRule(state.delivery)}` : '');
  paintModeNote();
  app.replaceChildren(
    el('div', { className: 'view-head' }, el('h1', { textContent: 'Menyu' }), el('p', { className: 'muted', textContent: hello })),
    state.info.orderingEnabled === false ? el('p', { className: 'notice', textContent: state.info.orderingNote || 'Hozir onlayn buyurtma qabul qilinmayapti. Menyuni ko‘rishingiz mumkin.' }) : '',
    state.tab ? tabBanner(state.tab) : '',
    state.tab ? callCard(state.tab) : deliveryOn() ? el('div', { className: 'mode-wrap' }, modeSwitch(paintModeNote), modeNote) : '',
    el('div', { className: 'menu-tools' }, search, chips),
    list);
}

/* ───────── Savat ───────── */
async function viewCart() {
  await ensureMenu();
  const lines = cartLines();
  // Menyudan o'chgan taomlar (yoki qo'shimchalar) savatdan ham olib tashlanadi
  for (const l of cart.lines()) if (!lines.some((x) => x.key === l.key)) cart.remove(l.key);
  if (!lines.length) {
    return app.replaceChildren(emptyState('Savat bo‘sh', 'Menyudan taom tanlang.', el('a', { className: 'btn', href: '#menyu', textContent: 'Menyuga o‘tish' })));
  }

  const [tables, tab] = await Promise.all([ensureTables(), loadTab()]);
  const withTables = tables.halls.some((h) => h.tables.length);
  let occ = { busy: [], mine: null };
  if (withTables) occ = await api('/api/tables/busy').catch(() => occ);
  if (occ.mine) {
    cart.tableId = occ.mine.tableId; // mijoz allaqachon shu stolda
    cart.mode = 'table';
  }
  const seated = Boolean(tab); // stol hisobi ochiq — boshqa stol/yetkazish tanlanmaydi

  const list = el('ul', { className: 'cart-list' });
  const sumBox = el('dl', { className: 'cart-sums' });
  const quoteLine = el('p', { className: 'quote-line', ariaLive: 'polite' });
  let quote = null; // { fee, km } | { error }

  function paintTotals() {
    const items = cartTotal();
    const rows = [['Taomlar', formatPrice(items)]];
    let total = items;
    if (mode() === 'delivery') {
      if (quote?.fee !== undefined) {
        rows.push([quote.km ? `Yetkazish · ${String(quote.km).replace('.', ',')} km` : 'Yetkazish', formatPrice(quote.fee)]);
        total += quote.fee;
      } else rows.push(['Yetkazish', 'manzil belgilansin']);
    } else if (tab?.servicePct) rows.push([`Xizmat haqi ${pctText(tab.servicePct)}`, 'hisob yopilganda']);
    sumBox.replaceChildren(...rows.map(([a, b]) => el('div', {}, el('dt', { textContent: a }), el('dd', { textContent: b }))),
      el('div', { className: 'cart-total' }, el('dt', { textContent: 'Jami' }), el('dd', {}, el('strong', { textContent: formatPrice(total) }))));
    const min = state.delivery.minOrder || 0;
    quoteLine.textContent = mode() !== 'delivery' ? '' : quote?.error || (min && items < min ? `Yetkazib berish uchun eng kam buyurtma — ${formatPrice(min)}.` : '');
    quoteLine.classList.toggle('is-bad', Boolean(mode() === 'delivery' && (quote?.error || (min && items < min))));
  }

  function paintLines() {
    const now = cartLines();
    if (!now.length) return viewCart();
    list.replaceChildren(...now.map((l, i) => el('li', { className: `cart-line reveal${l.item.available ? '' : ' is-off'}`, style: `--i:${i}` },
      el('div', { className: 'cart-line-main' },
        el('p', { className: 'order-item-name', textContent: l.item.name }),
        l.modNames.length ? el('p', { className: 'order-item-desc', textContent: modsLine(l.modNames) }) : '',
        el('p', { className: 'muted', textContent: l.amount ? `${formatPrice(l.amount)}lik · ≈ ${fmtKg(l.kg)}` : l.w ? `${fmtKg(l.qty)} × ${formatPrice(l.price)}/kg = ${formatPrice(l.sum)}` : `${formatPrice(l.price)} × ${l.qty} = ${formatPrice(l.sum)}` }),
        !l.item.available && el('p', { className: 'off-label', textContent: 'Hozir mavjud emas — olib tashlang' })),
      l.amount
        ? el('button', { type: 'button', className: 'line-remove', textContent: '×', ariaLabel: 'Olib tashlash', onclick: () => { cart.remove(l.key); paintLines(); } })
        : l.w
          ? stepperView(l.qty, {
            text: fmtKg(l.qty),
            onMinus: () => { const bw = l.item.byWeight; cart.setQty(l.key, l.qty - bw.step < bw.min - 1e-9 ? 0 : l.qty - bw.step); paintLines(); },
            onPlus: () => { cart.setQty(l.key, l.qty + l.item.byWeight.step); paintLines(); },
          })
          : stepperView(l.qty, {
            max: maxFor(l.item) - (cart.qtyOf(l.id) - l.qty),
            onMinus: () => { cart.setQty(l.key, l.qty - 1); paintLines(); },
            onPlus: () => { cart.setQty(l.key, l.qty + 1); paintLines(); },
          }))));
    paintTotals();
    paintCartBadge();
  }

  /* — restoranda: stol — */
  const allTables = tables.halls.flatMap((h) => h.tables);
  const chosen = () => allTables.find((t) => t.id === cart.tableId);
  const chosenLine = el('p', { className: 'table-chosen', ariaLive: 'polite' });
  const paintChosen = () => {
    const t = chosen();
    chosenLine.textContent = t ? `Tanlandi: ${t.label}` : 'Avval zalni, keyin stolingizni tanlang — raqami stol ustida yozilgan.';
    chosenLine.classList.toggle('is-set', Boolean(t));
  };
  const tableInput = el('input', { id: 'cart-table', value: cart.table, maxLength: 10, inputMode: 'numeric', placeholder: 'Masalan: 5', autocomplete: 'off' });
  tableInput.addEventListener('input', () => (cart.table = tableInput.value.trim()));
  let unlocked = false;
  function tableField() {
    if (seated) {
      return el('div', { className: 'seat-card reveal' },
        el('span', { className: 'seat-icon', textContent: '🍽', ariaHidden: 'true' }),
        el('div', {}, el('strong', { textContent: `Siz ${tab.tableLabel}dasiz` }),
          el('p', { className: 'muted small', textContent: 'Bu buyurtma shu stol hisobiga qo‘shiladi. Boshqa stolga o‘tish uchun ofitsiantga ayting.' })));
    }
    if (withTables && qrTable && chosen() && !unlocked) {
      const taken = (occ.busy || []).includes(cart.tableId);
      return el('div', { className: `seat-card reveal${taken ? ' is-bad' : ''}` },
        el('span', { className: 'seat-icon', textContent: taken ? '⛔' : '📍', ariaHidden: 'true' }),
        el('div', {}, el('strong', { textContent: chosen().label }),
          el('p', { className: 'muted small', textContent: taken ? 'Bu stol hozir band. Ofitsiantni chaqiring yoki boshqa stolni tanlang.' : 'Stol QR kod orqali aniqlandi.' }),
          el('button', { type: 'button', className: 'btn-link', textContent: 'Boshqa stol tanlash', onclick: () => { unlocked = true; paintForm(); } })));
    }
    if (withTables) return el('div', { className: 'field' }, el('span', { className: 'field-label', textContent: 'Stol' }), tablePicker(tables, occ, paintChosen), chosenLine);
    return el('div', { className: 'field' }, el('label', { htmlFor: 'cart-table', textContent: 'Stol raqami' }), tableInput);
  }

  /* — yetkazib berish: manzil — */
  const addr = cart.address || {};
  const field = (id, label, props) => {
    const input = el('input', { id, ...props });
    return [input, el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: label }), input)];
  };
  const [street, streetF] = field('d-street', 'Manzil: ko‘cha, uy', { value: addr.text || '', maxLength: 200, autocomplete: 'street-address', placeholder: 'Masalan: Oqtosh ko‘chasi, 12-uy' });
  const [apt, aptF] = field('d-apt', 'Xonadon', { value: addr.apartment || '', maxLength: 20, inputMode: 'numeric' });
  const [ent, entF] = field('d-ent', 'Podyezd', { value: addr.entrance || '', maxLength: 20, inputMode: 'numeric' });
  const [floor, floorF] = field('d-floor', 'Qavat', { value: addr.floor || '', maxLength: 20, inputMode: 'numeric' });
  const [mark, markF] = field('d-mark', 'Mo‘ljal (ixtiyoriy)', { value: addr.landmark || '', maxLength: 120, placeholder: 'Masalan: maktab yonida' });
  const [phone, phoneF] = field('d-phone', 'Telefon raqamingiz', { type: 'tel', value: cart.phone || state.profile.phone || '', maxLength: 20, autocomplete: 'tel', inputMode: 'tel' });
  const saveAddr = () => {
    cart.address = { ...cart.address, text: street.value.trim(), apartment: apt.value.trim(), entrance: ent.value.trim(), floor: floor.value.trim(), landmark: mark.value.trim() };
    cart.phone = phone.value.trim();
  };
  for (const i of [street, apt, ent, floor, mark, phone]) i.addEventListener('input', saveAddr);
  let quoteTimer = null;
  const askQuote = (p) => {
    clearTimeout(quoteTimer);
    quote = null;
    paintTotals();
    quoteTimer = setTimeout(async () => {
      try {
        quote = await api('/api/delivery/quote', { method: 'POST', body: JSON.stringify({ lat: p.lat, lng: p.lng }) });
      } catch (e) {
        quote = { error: e.message };
      }
      paintTotals();
    }, 350);
  };
  let picker = null;
  function deliveryFields() {
    picker ||= locationPicker({
      origin: state.delivery.origin,
      value: addr.lat ? addr : null,
      onChange: (p) => {
        cart.address = { ...cart.address, lat: p.lat, lng: p.lng };
        askQuote(p);
      },
    });
    if (picker.value && !quote) askQuote(picker.value);
    return el('div', { className: 'delivery-box reveal' },
      el('p', { className: 'notice delivery-rule' }, el('strong', { textContent: 'Yetkazish narxi: ' }), deliveryRule(state.delivery)),
      el('div', { className: 'field' }, el('span', { className: 'field-label', textContent: 'Xaritada uyingizni belgilang' }), picker.node),
      streetF,
      el('div', { className: 'field-row' }, aptF, entF, floorF),
      markF, phoneF);
  }

  const comment = el('textarea', { id: 'cart-comment', rows: 2, maxLength: 300, value: cart.comment, placeholder: 'Masalan: achchiq bo‘lmasin' });
  comment.addEventListener('input', () => (cart.comment = comment.value));
  const err = errorBox('');
  err.hidden = true;
  const closed = state.info.orderingEnabled === false;
  const submit = el('button', { type: 'submit', className: 'btn btn-wide btn-order', disabled: closed });
  const whereBox = el('div', { className: 'where-box' });
  const switcher = deliveryOn() && !seated ? modeSwitch(() => paintForm()) : '';
  const footNote = el('p', { className: 'muted small' });

  function paintForm() {
    err.hidden = true;
    whereBox.replaceChildren(mode() === 'delivery' ? deliveryFields() : tableField());
    if (mode() === 'delivery') picker?.refresh();
    submit.textContent = seated ? 'Stol hisobiga qo‘shish' : mode() === 'delivery' ? 'Yetkazib berishga buyurtma' : 'Buyurtma berish';
    footNote.textContent = mode() === 'delivery' ? 'Buyurtmani kassir tasdiqlaydi, keyin kuryer yo‘lga chiqadi. To‘lov — kuryerga.' : 'Ofitsiantga ovozli xabar boradi — u kelib tasdiqlaydi. Yakuniy hisobni kassa chiqaradi.';
    paintTotals();
    if (withTables && mode() === 'table') paintChosen();
  }

  const form = el('form', { className: 'cart-form', noValidate: true },
    switcher, whereBox,
    el('div', { className: 'field' }, el('label', { htmlFor: 'cart-comment', textContent: 'Izoh (ixtiyoriy)' }), comment),
    sumBox, quoteLine, footNote,
    closed ? el('p', { className: 'notice', textContent: state.info.orderingNote || 'Hozir onlayn buyurtma qabul qilinmayapti.' }) : '',
    err, submit);

  const fail = (text, focus) => {
    err.textContent = text;
    err.hidden = false;
    focus?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    focus?.focus?.({ preventScroll: true });
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const delivery = mode() === 'delivery';
    const body = { comment: comment.value, items: cartLines().map((l) => ({ id: l.id, ...(l.amount ? { amount: l.amount } : { qty: l.qty }), ...(l.mods.length ? { mods: l.mods } : {}) })) };
    if (delivery) {
      saveAddr();
      const p = picker?.value;
      if (!p) return fail('Xaritada uyingizni belgilang yoki “Mening joylashuvim”ni bosing.', picker?.node);
      if (street.value.trim().length < 3) return fail('Manzilni yozing: ko‘cha, uy.', street);
      if (phone.value.replace(/\D/g, '').length < 9) return fail('Telefon raqamingizni yozing.', phone);
      if (quote?.error) return fail(quote.error);
      Object.assign(body, { mode: 'delivery', phone: phone.value.trim(), address: { lat: p.lat, lng: p.lng, text: street.value.trim(), apartment: apt.value.trim(), entrance: ent.value.trim(), floor: floor.value.trim(), landmark: mark.value.trim() } });
    } else if (seated) {
      Object.assign(body, occ.mine ? { tableId: occ.mine.tableId } : { table: cart.table || tab.tableLabel });
    } else if (withTables) {
      if (!chosen()) return fail('Stolingizni tanlang — raqami stol ustida yozilgan.', whereBox);
      body.tableId = cart.tableId;
    } else {
      if (!tableInput.value.trim()) return fail('Stol raqamini yozing — u stol ustidagi belgida bor.', tableInput);
      body.table = tableInput.value.trim();
    }
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Yuborilmoqda…';
    try {
      const { order } = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      cart.clear();
      location.hash = `buyurtma=${order.id}`;
    } catch (ex) {
      if (ex.code === 'login') return showLogin();
      if (ex.status === 409) state.menu = null; // menyu o'zgargan bo'lishi mumkin
      if (ex.code === 'table') state.tables = null; // stollar ro'yxati o'zgargan
      if (ex.code === 'table-busy') {
        occ = await api('/api/tables/busy').catch(() => occ);
        unlocked = true;
        paintForm();
      }
      fail(ex.message);
      submit.disabled = false;
      submit.textContent = label;
    }
  });

  paintLines();
  paintForm();
  app.replaceChildren(el('div', { className: 'view-head' }, el('h1', { textContent: 'Savat' })), list, form);
}

/* ───────── Bitta buyurtma ───────── */
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const DELIVERY_STEPS = [['kutilmoqda', 'Tayyorlanmoqda'], ['yolda', 'Kuryer yo‘lda'], ['yetkazildi', 'Yetkazildi']];

function deliveryProgress(order) {
  const at = order.deliveryStatus === 'yetkazildi' ? DELIVERY_STEPS.length : DELIVERY_STEPS.findIndex(([k]) => k === order.deliveryStatus);
  return el('ol', { className: 'progress' }, DELIVERY_STEPS.map(([k, label], i) => el('li', { className: i < at ? 'is-done' : i === at ? 'is-now' : '' },
    el('span', { className: 'progress-dot', ariaHidden: 'true' }), el('span', { textContent: label }),
    k === 'yolda' && order.courierName && i <= at ? el('small', { textContent: order.courierName }) : '')));
}

async function viewOrder(id) {
  let order;
  try {
    ({ order } = await api(`/api/orders/${encodeURIComponent(id)}`));
  } catch (e) {
    if (e.code === 'login') return showLogin();
    return app.replaceChildren(emptyState('Buyurtma topilmadi', e.message, el('a', { className: 'btn', href: '#buyurtmalar', textContent: 'Buyurtmalarim' })));
  }

  let poll = null;
  let wake = null;
  cleanup = () => {
    clearTimeout(poll);
    wake?.release?.().catch(() => {});
  };
  // holat o'zgarguncha sahifa o'zi yangilanadi
  const watch = (ms, changed) => {
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await api(`/api/orders/${order.id}`);
          if (changed(r.order)) return route();
        } catch {}
      }
      poll = setTimeout(tick, ms);
    };
    poll = setTimeout(tick, ms);
  };
  const delivery = order.mode === 'delivery';

  const items = el('ul', { className: 'order-lines' }, order.items.map((i) => el('li', {},
    el('span', {}, `${qtyText(i)} ${i.name}`, i.mods?.length ? el('small', { className: 'line-mods', textContent: modsLine(i.mods) }) : ''),
    el('span', { textContent: formatPrice(i.sum) }))));
  const head = el('div', { className: 'order-head reveal' },
    el('p', { className: `status-chip ${STATUS_CLASS[order.status] || ''}`, textContent: order.statusLabel }),
    el('h1', { textContent: `Buyurtma #${order.number}` }),
    el('p', { className: 'muted', textContent: `${delivery ? 'Yetkazib berish' : order.tableLabel || `Stol ${order.table}`} · ${fmtWhen(order.createdAt)}` }));

  const cancelBtn = () => {
    const cancel = el('button', { type: 'button', className: 'btn-link danger', textContent: 'Buyurtmani bekor qilish' });
    cancel.addEventListener('click', async () => {
      if (!confirm('Buyurtmani bekor qilasizmi?')) return;
      cancel.disabled = true;
      try {
        await api(`/api/orders/${order.id}/cancel`, { method: 'POST', body: '{}' });
        route();
      } catch (e) {
        alert(e.message);
        cancel.disabled = false;
      }
    });
    return cancel;
  };

  const blocks = [head];
  if (order.status === 'yangi' && delivery) {
    blocks.push(el('div', { className: 'result-card is-wait pop' },
      el('p', { className: 'result-icon pulse', textContent: '⏳', ariaHidden: 'true' }),
      el('h2', { textContent: 'Kassir tasdiqlashini kuting' }),
      el('p', { textContent: 'Buyurtmangiz kassaga ovozli xabar bilan tushdi. Tasdiqlangach tayyorlanadi va kuryer olib boradi.' })), cancelBtn());
    watch(6000, (o) => o.status !== 'yangi');
  } else if (order.status === 'yangi') {
    const qrUrl = `${location.origin}/ofitsiant.html#o=${order.id}&t=${order.token}`;
    blocks.push(
      el('div', { className: 'qr-card pop' },
        el('p', { className: 'qr-hint', textContent: 'Ofitsiantga xabar ketdi — u kelib tasdiqlaydi. Kerak bo‘lsa shu QR kodni ko‘rsating.' }),
        el('div', { className: 'qr-box' }, qrSvg(qrUrl, { label: `Buyurtma #${order.number} QR kodi` })),
        el('p', { className: 'qr-code-line' }, 'Kod: ', el('b', { textContent: order.checkCode }))),
      cancelBtn());
    try {
      wake = await navigator.wakeLock?.request('screen'); // QR ko'rsatilayotganda ekran o'chmasin
    } catch {}
    watch(5000, (o) => o.status !== 'yangi');
  } else if (order.status === 'qabul' && delivery) {
    const done = order.deliveryStatus === 'yetkazildi';
    blocks.push(el('div', { className: `result-card ${done ? 'is-ok' : 'is-wait'} pop` },
      el('h2', { textContent: done ? 'Yetkazildi. Yoqimli ishtaha!' : 'Buyurtmangiz qabul qilindi' }),
      deliveryProgress(order),
      order.kitchen?.label && !done ? el('p', { className: 'kitchen-status', textContent: `Oshxona: ${order.kitchen.label}` }) : ''));
    if (!done) watch(15000, (o) => o.deliveryStatus !== order.deliveryStatus || o.status !== 'qabul');
  } else if (order.status === 'qabul') {
    const k = order.kitchen;
    const cancelled = k?.code === 'DELETED';
    blocks.push(el('div', { className: `result-card ${cancelled ? 'is-bad' : 'is-ok'} pop` },
      cancelled ? '' : el('p', { className: 'result-icon', textContent: '✓', ariaHidden: 'true' }),
      el('h2', { textContent: cancelled ? 'Buyurtma kassada bekor qilindi' : 'Buyurtmangiz qabul qilindi' }),
      k?.label && !cancelled ? el('p', { className: 'kitchen-status', textContent: k.label }) : '',
      el('p', { textContent: cancelled ? 'Ofitsiantdan so‘rang.' : `${fmtWhen(order.acceptedAt)} · Yoqimli ishtaha!` })));
    if (k && !k.final) watch(15000, (o) => o.kitchen?.code !== k.code);
  } else if (order.status === 'rad') {
    blocks.push(el('div', { className: 'result-card is-bad pop' },
      el('h2', { textContent: 'Buyurtma qabul qilinmadi' }),
      order.rejectReason && el('p', { textContent: `Sabab: ${order.rejectReason}` }),
      el('p', { className: 'muted', textContent: delivery ? 'Restoranga qo‘ng‘iroq qiling yoki qaytadan buyurtma bering.' : 'Ofitsiantdan so‘rang yoki qaytadan buyurtma bering.' })));
  }

  if (delivery && order.address) {
    const a = order.address;
    blocks.push(el('section', { className: 'addr-card reveal' },
      el('h2', { textContent: 'Manzil' }),
      el('p', { textContent: [a.text, a.apartment && `xonadon ${a.apartment}`, a.entrance && `${a.entrance}-podyezd`, a.floor && `${a.floor}-qavat`].filter(Boolean).join(', ') }),
      a.landmark ? el('p', { className: 'muted small', textContent: `Mo‘ljal: ${a.landmark}` }) : ''));
  }
  const rows = [];
  if (delivery) {
    rows.push(el('div', { className: 'cart-total sub' }, el('span', { textContent: 'Taomlar' }), el('span', { textContent: formatPrice(order.total - (order.deliveryFee || 0)) })));
    rows.push(el('div', { className: 'cart-total sub' }, el('span', { textContent: order.deliveryKm ? `Yetkazish · ${String(order.deliveryKm).replace('.', ',')} km` : 'Yetkazish' }), el('span', { textContent: formatPrice(order.deliveryFee) })));
  }
  blocks.push(el('section', { className: 'order-summary reveal' },
    el('h2', { textContent: 'Tarkibi' }), items, ...rows,
    el('div', { className: 'cart-total' }, el('span', { textContent: 'Jami' }), el('strong', { textContent: formatPrice(order.total) })),
    order.comment && el('p', { className: 'muted', textContent: `Izoh: ${order.comment}` })));
  if (order.tabId && order.status !== 'bekor') {
    const tab = await loadTab();
    if (tab && tab.id === order.tabId) blocks.splice(2, 0, callCard(tab));
    blocks.push(el('a', { className: 'btn btn-ghost btn-wide', href: '#buyurtmalar', textContent: 'Stol hisobini ko‘rish' }));
  }
  blocks.push(el('a', { className: 'btn btn-wide', href: '#menyu', textContent: order.tabId ? 'Yana buyurtma qo‘shish' : 'Yana buyurtma berish' }));
  app.replaceChildren(...blocks);
}

/* ───────── Buyurtmalar tarixi va stol hisobi ───────── */
async function viewOrders() {
  let items;
  try {
    [{ items }] = await Promise.all([api('/api/orders'), loadTab()]);
  } catch (e) {
    if (e.code === 'login') return showLogin();
    throw e;
  }
  const tab = state.tab;
  if (!items.length && !tab) {
    return app.replaceChildren(emptyState('Hali buyurtma yo‘q', 'Birinchi buyurtmangizni bering.', el('a', { className: 'btn', href: '#menyu', textContent: 'Menyuga o‘tish' })));
  }
  const count = (o) => o.items.reduce((s, i) => s + (i.unit === 'kg' ? 1 : i.qty), 0);
  app.replaceChildren(
    tab ? el('section', { className: 'my-tab' },
      el('div', { className: 'view-head' }, el('h1', { textContent: 'Stol hisobi' }), el('p', { className: 'muted', textContent: `${tab.tableLabel}${tab.waiterName ? ` · ofitsiant: ${tab.waiterName}` : ''}` })),
      callCard(tab),
      billCard(tab, { onRound: (o) => (location.hash = `buyurtma=${o.id}`) }),
      el('p', { className: 'muted small', textContent: `Hisobni kassa yopadi.${tab.servicePct ? ` Xizmat haqi ${pctText(tab.servicePct)} qo‘shiladi.` : ''} Yana buyurtma bersangiz — shu hisobga qo‘shiladi.` }),
      el('a', { className: 'btn btn-wide', href: '#menyu', textContent: 'Yana buyurtma qo‘shish' })) : '',
    items.length ? el('div', { className: 'view-head' }, tab ? el('h2', { className: 'list-head', textContent: 'Barcha buyurtmalarim' }) : el('h1', { textContent: 'Buyurtmalarim' })) : '',
    el('ul', { className: 'history' }, items.map((o, i) => el('li', { className: 'reveal', style: `--i:${Math.min(i, 10)}` },
      el('a', { href: `#buyurtma=${o.id}`, className: 'history-item' },
        el('span', { className: 'history-main' },
          el('strong', { textContent: `#${o.number} · ${o.mode === 'delivery' ? '🛵 Yetkazib berish' : o.tableLabel || `Stol ${o.table}`}` }),
          el('span', { className: 'muted', textContent: `${fmtWhen(o.createdAt)} · ${count(o)} ta taom` })),
        el('span', { className: 'history-side' },
          el('span', { className: `status-chip ${STATUS_CLASS[o.status] || ''}`, textContent: o.statusLabel }),
          el('span', { className: 'history-total', textContent: formatPrice(o.total) })))))));
}

/* ───────── Profil ───────── */
function viewProfile() {
  const p = state.profile;
  const name = el('input', { id: 'pf-name', value: p.name, maxLength: 80, autocomplete: 'name' });
  const msg = el('p', { className: 'muted', ariaLive: 'polite' });
  const save = el('button', { type: 'submit', className: 'btn', textContent: 'Saqlash' });
  const form = el('form', { className: 'profile-form', noValidate: true },
    el('div', { className: 'field' }, el('label', { htmlFor: 'pf-name', textContent: 'Ismingiz' }), name),
    el('div', { className: 'field' }, el('span', { className: 'field-label', textContent: 'Telefon (Telegram’dan)' }), el('p', { className: 'profile-phone', textContent: p.phone || '—' })),
    msg, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const r = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ name: name.value }) });
      state.profile = r.profile;
      msg.textContent = 'Saqlandi.';
    } catch (ex) {
      msg.textContent = ex.message;
    } finally {
      save.disabled = false;
    }
  });
  const logout = el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Chiqish' });
  logout.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    state.profile = null;
    showLogin();
  });
  const staffLinks = {
    waiter: [['/ofitsiant.html', 'Ofitsiant sahifasi']],
    cashier: [['/kassa.html', 'Kassa paneli'], ['/ofitsiant.html', 'Ofitsiant sahifasi']],
    courier: [['/kuryer.html', 'Kuryer sahifasi']],
  }[p.role] || [];
  app.replaceChildren(
    el('div', { className: 'view-head' }, el('h1', { textContent: 'Profil' })),
    form,
    ...staffLinks.map(([href, t]) => el('a', { className: 'btn btn-ghost btn-wide staff-link', href, textContent: t })),
    el('div', { className: 'profile-actions' }, logout),
    state.info.phone ? el('p', { className: 'muted' }, 'Savollar uchun: ', el('a', { href: phoneHref(state.info.phone), textContent: state.info.phone })) : '',
    deleteAccountBox(),
    el('p', { className: 'muted small legal-links' }, el('a', { href: '/maxfiylik.html', textContent: 'Maxfiylik siyosati' }), ' · ', el('a', { href: '/hisobni-ochirish.html', textContent: 'Hisobni o‘chirish haqida' })));
}

// Hisobni o'chirish (Google Play talabi): hisob va shaxsiy ma'lumotlar o'chadi
function deleteAccountBox() {
  const err = el('p', { className: 'form-error', role: 'alert', hidden: true });
  const confirmBtn = el('button', { type: 'button', className: 'btn btn-leave btn-wide', textContent: 'Ha, hisobimni o‘chir' });
  const panel = el('div', { className: 'delete-panel', hidden: true },
    el('p', { textContent: 'Hisobingiz, ismingiz, telefon raqamingiz va yetkazish manzillaringiz o‘chiriladi. Buyurtma summalari hisob-kitob uchun nomsiz holda qoladi. Bu ishni qaytarib bo‘lmaydi.' }),
    err, confirmBtn);
  const open = el('button', { type: 'button', className: 'btn-link danger', textContent: 'Hisobni o‘chirish' });
  open.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  confirmBtn.addEventListener('click', async () => {
    err.hidden = true;
    confirmBtn.disabled = true;
    try {
      await api('/api/me/delete', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      try {
        localStorage.removeItem(CART_KEY);
      } catch {}
      state.profile = null;
      $('#tabs').hidden = true;
      app.replaceChildren(emptyState('Hisobingiz o‘chirildi', 'Xohlasangiz, istalgan vaqtda Telegram orqali qaytadan kirishingiz mumkin.', el('a', { className: 'btn', href: '/', textContent: 'Bosh sahifa' })));
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      confirmBtn.disabled = false;
    }
  });
  return el('section', { className: 'delete-box' }, open, panel);
}

/* ───────── Yo'naltirish ───────── */
function viewName() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('buyurtma=')) return 'buyurtma';
  return ['menyu', 'savat', 'buyurtmalar', 'profil'].includes(h) ? h : 'menyu';
}

async function route() {
  cleanup();
  cleanup = () => {};
  if (!state.profile) return showLogin();
  const view = viewName();
  for (const a of $$('#tabs a')) {
    const on = a.dataset.tab === view || (view === 'buyurtma' && a.dataset.tab === 'buyurtmalar');
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  try {
    if (view === 'savat') await viewCart();
    else if (view === 'buyurtma') await viewOrder(location.hash.split('=')[1]);
    else if (view === 'buyurtmalar') await viewOrders();
    else if (view === 'profil') viewProfile();
    else await viewMenu();
  } catch (e) {
    app.replaceChildren(emptyState('Yuklab bo‘lmadi', e.message, el('button', { type: 'button', className: 'btn', textContent: 'Qayta urinish', onclick: route })));
  }
  paintCartBadge();
}

function showLogin() {
  cleanup();
  state.profile = null;
  $('#tabs').hidden = true;
  paintCartBadge();
  if (!state.info.loginReady) {
    return app.replaceChildren(emptyState('Onlayn buyurtma tez orada ishga tushadi',
      state.info.phone ? `Hozircha ofitsiantni chaqiring yoki qo‘ng‘iroq qiling: ${state.info.phone}` : 'Hozircha ofitsiantni chaqiring.'));
  }
  mountLogin(app, {
    title: 'Buyurtma berish',
    text: 'Buyurtma berish uchun Telegram orqali tasdiqlang. Bu bir marta qilinadi — keyin profilingiz ochiq turadi.',
    onSuccess(profile) {
      state.profile = profile;
      $('#tabs').hidden = false;
      if (!location.hash || location.hash === '#') location.hash = cart.count() ? 'savat' : 'menyu';
      else route();
    },
  });
}

window.addEventListener('hashchange', route);

/* ───────── Ishga tushirish ───────── */
try {
  const [info, me, delivery] = await Promise.all([api('/api/info'), api('/api/me'), api('/api/delivery').catch(() => ({ enabled: false }))]);
  state.info = info;
  state.profile = me.profile;
  state.delivery = delivery;
  applyInfo(info);
  document.title = `Buyurtma berish — ${info.name}`;
  if (state.profile) {
    $('#tabs').hidden = false;
    route();
  } else showLogin();
} catch (e) {
  app.replaceChildren(emptyState('Sahifani yuklab bo‘lmadi', 'Internetni tekshiring va sahifani yangilang.'));
}
