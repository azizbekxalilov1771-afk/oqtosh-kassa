import { $, el, api, formatPrice, phoneHref, handle, applyInfo, setYear, dishFacts } from './common.js';

setYear();
let restaurant = null;
// "Menyuni ko'rish" (bosh sahifadan): faqat menyu — savol, shikoyat va buyurtma qismlarisiz
const menuOnly = new URLSearchParams(location.search).get('faqat') === 'menyu';
if (menuOnly) document.body.classList.add('menu-only');

/* ───────── Buyurtma uchun aloqa ───────── */
function renderOrderContacts(info) {
  const actions = [];
  if (info.orderingEnabled !== false) {
    $('#order-strip-text').textContent = 'Stolingizdan onlayn buyurtma bering yoki qo‘ng‘iroq qiling.';
    actions.push(el('a', { className: 'btn', href: '/buyurtma.html', textContent: 'Buyurtma berish' }));
  }
  if (info.phone) {
    actions.push(el('a', { className: actions.length ? 'btn btn-ghost' : 'btn', href: phoneHref(info.phone), textContent: `Qo‘ng‘iroq: ${info.phone}` }));
    Object.assign($('#header-call'), { href: phoneHref(info.phone), hidden: false });
  }
  if (info.telegram) {
    const h = handle(info.telegram, 't\\.me');
    actions.push(el('a', { className: 'btn btn-ghost', href: `https://t.me/${h}`, target: '_blank', rel: 'noopener', textContent: 'Telegram’da yozish' }));
  }
  if (actions.length) {
    $('#order-strip-actions').replaceChildren(...actions);
    $('#order-strip').hidden = false;
  }
}

/* ───────── Menyu ───────── */
const menuState = { items: [], categories: [], cat: 'all', q: '' };

function menuMessage(title, text, withPhone = false) {
  const box = el('div', { className: 'menu-empty' }, el('strong', { textContent: title }), text);
  if (withPhone && restaurant?.phone) box.append(' Telefon: ', el('a', { href: phoneHref(restaurant.phone), textContent: restaurant.phone }));
  $('#menu-list').replaceChildren(box);
}

function renderCategories() {
  const wrap = $('#menu-cats');
  const cats = [['all', 'Hammasi'], ...menuState.categories.map((c) => [c, c])];
  wrap.replaceChildren(
    ...cats.map(([value, label]) => {
      const b = el('button', { type: 'button', textContent: label });
      b.setAttribute('aria-pressed', String(menuState.cat === value));
      b.addEventListener('click', () => {
        menuState.cat = value;
        renderCategories();
        renderMenu();
      });
      return b;
    }),
  );
  wrap.hidden = menuState.categories.length < 2;
}

function dishRow(item) {
  const li = el('li', { className: `dish${item.available ? '' : ' is-off'}` });
  if (item.image) {
    const img = el('img', { src: item.image, alt: '', loading: 'lazy', decoding: 'async', width: 56, height: 56 });
    img.addEventListener('error', () => img.remove());
    li.append(img);
  }
  li.append(el('div', { className: 'dish-main' },
    el('div', { className: 'dish-line' },
      el('span', { className: 'dish-name', textContent: item.name }),
      el('span', { className: 'dish-dots', ariaHidden: 'true' }),
      el('span', { className: 'dish-price', textContent: formatPrice(item.price) })),
    item.description && el('p', { className: 'dish-desc', textContent: item.description }),
    dishFacts(item) && el('p', { className: 'dish-facts', textContent: dishFacts(item) }),
    item.options?.length > 0 && el('p', { className: 'dish-facts', textContent: item.options.map((g) => `${g.name}: ${g.items.slice(0, 6).map((m) => (m.price ? `${m.name} +${formatPrice(m.price)}` : m.name)).join(', ')}${g.items.length > 6 ? '…' : ''}`).join(' · ') }),
    !item.available && el('span', { className: 'dish-off', textContent: 'Hozir mavjud emas' })));
  return li;
}

function renderMenu() {
  const q = menuState.q.toLocaleLowerCase('uz');
  const visible = menuState.items.filter(
    (i) => (menuState.cat === 'all' || i.category === menuState.cat) &&
      (!q || `${i.name} ${i.description}`.toLocaleLowerCase('uz').includes(q)),
  );
  if (!visible.length) return menuMessage('Hech narsa topilmadi', 'Boshqa so‘z bilan qidirib ko‘ring.');
  const groups = menuState.categories
    .map((cat) => [cat, visible.filter((i) => i.category === cat)])
    .filter(([, items]) => items.length)
    .map(([cat, items]) => el('section', { className: 'menu-group' }, el('h3', { textContent: cat }), el('ul', {}, ...items.map(dishRow))));
  $('#menu-list').replaceChildren(...groups);
}

async function loadMenu() {
  try {
    const menu = await api('/api/menu');
    menuState.items = menu.items || [];
    menuState.categories = menu.categories?.length ? menu.categories : [...new Set(menuState.items.map((i) => i.category))];
    if (!menuState.items.length) {
      $('#menu-cats').hidden = true;
      $('#menu-search').hidden = true;
      return menuMessage('Menyu tez orada shu yerda bo‘ladi', 'Hozircha taomlar va narxlarni telefon orqali so‘rang.', true);
    }
    if (menu.source === 'demo') $('#menu-note').textContent = 'Demo menyu (DEMO_MODE yoqilgan).';
    else if (menu.stale && menu.updatedAt) {
      $('#menu-note').textContent = `Menyu ${new Date(menu.updatedAt).toLocaleString('uz-UZ', { dateStyle: 'short', timeStyle: 'short' })} holatida.`;
    }
    renderCategories();
    renderMenu();
  } catch {
    menuMessage('Menyuni yuklab bo‘lmadi', 'Sahifani yangilang yoki qo‘ng‘iroq qiling.', true);
  }
}

$('#menu-search').addEventListener('input', (e) => {
  menuState.q = e.target.value.trim();
  renderMenu();
});

/* ───────── Tablar ───────── */
const tabs = [$('#tab-chat'), $('#tab-complaint')];
function selectTab(tab, focus = true) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') selectTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]);
  });
});

/* ───────── AI chat ───────── */
const history = [];
const log = $('#chat-log');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
let lastUserText = '';

// **qalin** belgilarini xavfsiz (innerHTML'siz) ko'rsatish
function richText(text) {
  const frag = document.createDocumentFragment();
  text.split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(el('strong', { textContent: part.slice(2, -2) }));
    else if (part) frag.append(part.replace(/^#{1,4}\s+/gm, ''));
  });
  return frag;
}

function addMessage(role, text, opts = {}) {
  const msg = el('div', { className: `msg ${role}${opts.error ? ' error' : ''}` });
  msg.append(role === 'bot' ? richText(text) : text);
  if (opts.complaint) {
    const btn = el('button', { type: 'button', className: 'btn msg-action', textContent: 'Shikoyat qoldirish' });
    btn.addEventListener('click', () => openComplaint(true));
    msg.append(btn);
  }
  log.append(msg);
  log.scrollTop = log.scrollHeight;
}

async function ask(text) {
  text = text.trim();
  if (!text) return;
  lastUserText = text;
  addMessage('user', text);
  history.push({ role: 'user', content: text });
  chatInput.value = '';
  $('#suggestions').hidden = true;

  const typing = el('div', { className: 'msg bot typing', ariaLabel: 'Yozmoqda' }, el('i'), el('i'), el('i'));
  log.append(typing);
  log.scrollTop = log.scrollHeight;
  const submit = chatForm.querySelector('button');
  submit.disabled = true;

  try {
    const { reply, suggestComplaint } = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: history.slice(-10) }),
    });
    typing.remove();
    addMessage('bot', reply, { complaint: suggestComplaint });
    history.push({ role: 'assistant', content: reply });
  } catch (e) {
    typing.remove();
    history.pop(); // muvaffaqiyatsiz savol tarixda qolmaydi
    addMessage('bot', e.message, { error: true });
  } finally {
    submit.disabled = false;
    chatInput.focus({ preventScroll: true });
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!chatForm.querySelector('button').disabled) ask(chatInput.value);
});
$('#suggestions').addEventListener('click', (e) => {
  if (e.target.matches('button')) ask(e.target.textContent);
});

/* ───────── Shikoyat ───────── */
const cForm = $('#complaint-form');
const cError = $('#complaint-error');

function openComplaint(prefill = false) {
  selectTab($('#tab-complaint'), false);
  const msg = cForm.elements.message;
  if (prefill && !msg.value && lastUserText) msg.value = lastUserText;
  $('#yordamchi .panel').scrollIntoView({ block: 'start' });
  if (!cForm.hidden) msg.focus({ preventScroll: true });
}

cForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  cError.hidden = true;
  const data = Object.fromEntries(new FormData(cForm));
  const showError = (text, field) => {
    cError.textContent = text;
    cError.hidden = false;
    if (field) cForm.elements[field].focus();
  };
  if (data.message.trim().length < 10) return showError('Nima bo‘lganini kamida bir-ikki gap bilan yozing.', 'message');
  if (data.phone && !/^\+?[\d\s()-]{7,20}$/.test(data.phone.trim())) return showError('Telefon raqami noto‘g‘ri. Masalan: +998 90 123 45 67', 'phone');

  const btn = cForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Yuborilmoqda…';
  try {
    await api('/api/complaint', { method: 'POST', body: JSON.stringify(data) });
    $('#complaint-done-text').textContent = data.phone
      ? 'Rahmat. Shikoyatingiz rahbariyatga yetkazildi — siz bilan tez orada bog‘lanishadi.'
      : 'Rahmat. Shikoyatingiz rahbariyatga yetkazildi.';
    cForm.reset();
    cForm.hidden = true;
    $('#complaint-done').hidden = false;
    $('#complaint-done').focus();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Shikoyatni yuborish';
  }
});

$('#complaint-again').addEventListener('click', () => {
  $('#complaint-done').hidden = true;
  cForm.hidden = false;
  cForm.elements.message.focus();
});

// menyu.html#shikoyat — shikoyat tabini to'g'ridan-to'g'ri ochadi
function handleHash() {
  if (location.hash === '#shikoyat') openComplaint();
  else if (location.hash === '#yordamchi') selectTab($('#tab-chat'), false);
}
window.addEventListener('hashchange', handleHash);

/* ───────── Ishga tushirish ───────── */
const infoReady = api('/api/info')
  .then((info) => {
    restaurant = info;
    applyInfo(info);
    renderOrderContacts(info);
    document.title = `Menyu — ${info.name}`;
  })
  .catch(() => {});
infoReady.finally(loadMenu);
handleHash();
