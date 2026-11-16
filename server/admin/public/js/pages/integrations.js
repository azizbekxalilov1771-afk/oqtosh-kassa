import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card } from '../ui.js';

const SOURCE = { admin: 'admin panelda saqlangan', env: '.env / Netlify’dan', default: 'standart qiymat', '': '' };
const formatPrice = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;

const GROUPS = [
  {
    id: 'pos', title: 'Mison POS — menyu va buyurtmalar',
    desc: 'Menyu, narxlar va stop-list Mison’dan olinadi. Ofitsiant qabul qilgan buyurtma Mison kassasiga tushadi. Kalit — Mison kabinetidagi "Партнёрское API" kaliti.',
    fields: [
      ['misonApiUrl', 'API manzili', { placeholder: 'https://backend.mison.uz/api/integrations/v1', type: 'url', hint: 'O‘zgartirish shart emas' }],
      ['misonApiKey', 'API kalit'],
      ['misonPointId', 'Filial (point)', { hint: 'Bo‘sh bo‘lsa — birinchi filial. "Tekshirish"dan keyin ro‘yxatdan tanlang.' }],
      ['misonOrders', 'Buyurtmalarni Mison kassasiga yuborish', { options: [['on', 'Ha — ofitsiant qabul qilgach'], ['off', 'Yo‘q — faqat saytda']] }],
    ],
    advanced: [
      ['misonMenuId', 'Menyu (vitrina) ID', { hint: 'Bo‘sh bo‘lsa — to‘liq nomenklatura. "Tekshirish" ro‘yxatidan tanlang.' }],
      ['misonPaymentTypeId', 'To‘lov turi ID', { hint: 'Bo‘sh bo‘lsa — naqd pul', inputmode: 'numeric' }],
      ['misonPriceDivisor', 'Narxni bo‘lish', { hint: 'Narx tiyinda kelsa: 100', inputmode: 'numeric' }],
      ['misonWebhookSecret', 'Webhook maxfiy kaliti (Секрет подписи)'],
      ['misonImageBaseUrl', 'Rasmlar bosh manzili', { hint: 'Rasm yo‘llari /uploads/... ko‘rinishida kelsa', type: 'url' }],
      ['menuCacheMinutes', 'Menyu necha daqiqada yangilansin', { inputmode: 'numeric', hint: 'Stop-list alohida, har 2 daqiqada (webhook bo‘lsa — darhol)' }],
    ],
  },
  {
    id: 'groq', title: 'AI yordamchi — Groq',
    desc: 'Kalitni console.groq.com/keys sahifasida yarating. Yordamchi menyu va restoran ma’lumotlari asosida javob beradi.',
    fields: [['groqApiKey', 'Groq API kalit'], ['groqModel', 'Model', { hint: 'Standart: openai/gpt-oss-120b' }]],
    advanced: [['groqFallbackModel', 'Zaxira model', { hint: 'Asosiy model ishlamay qolsa' }]],
  },
  {
    id: 'telegram', title: 'Telegram botlar — kirish, buyurtmalar, shikoyatlar',
    desc: 'Shikoyatlar boti saytdagi shikoyatlarni, asosiy bot yangi buyurtmalarni yuboradi: kerakli botga /start yozing (yoki guruhga qo‘shing) va "Chat ID topish"ni bosing. Verifikatsiya boti mijozlarni tasdiqlaydi. Bo‘sh qoldirilgan bot o‘rniga asosiy bot ishlaydi.',
    fields: [
      ['telegramComplaintsBotToken', 'Shikoyatlar boti tokeni'],
      ['telegramChatId', 'Shikoyatlar uchun chat ID', { hint: 'Bir nechta bo‘lsa vergul bilan: 123456789, -1001234567890' }],
      ['telegramBotToken', 'Asosiy bot tokeni (buyurtmalar)'],
      ['telegramOrdersChatId', 'Yangi buyurtmalar uchun chat ID (ixtiyoriy)', { hint: 'Masalan, ofitsiantlar guruhi. Bo‘sh bo‘lsa, xabar yuborilmaydi.' }],
      ['telegramLoginBotToken', 'Verifikatsiya boti tokeni (mijozlar kirishi)'],
    ],
  },
];

// Bot holati va webhook: saytdagi "Telegram orqali kirish" ishlashi uchun webhook ulangan bo'lishi kerak
// Mison webhook: manzil, maxfiy kalit, oxirgi kelgan hodisa
function misonWebhookBox() {
  const box = el('div', { className: 'bot-status', ariaLive: 'polite' }, el('span', { className: 'muted', textContent: 'Webhook holati…' }));
  api('/mison/webhook').then((w) => {
    const last = w.last?.lastAtMs ? `Oxirgi hodisa: ${w.last.lastEvent} · ${new Date(w.last.lastAtMs).toLocaleString('ru-RU')}` : 'Hali hodisa kelmagan.';
    box.replaceChildren(
      el('p', { className: 'bot-status-title' }, el('strong', { textContent: 'Mison webhook — buyurtma holati va stop-list darhol keladi' })),
      w.https
        ? el('p', {}, 'Manzil: ', el('code', { textContent: w.url }))
        : el('p', { className: 'muted', textContent: `Webhook faqat https saytda ishlaydi (${w.url || 'PUBLIC_SITE_URL bo‘sh'}). Netlify’ga joylagach sozlang — hozircha holat va stop-list har 30 soniya / 2 daqiqada so‘rab olinadi.` }),
      w.fresh === false ? el('p', { className: 'form-error', textContent: 'Diqqat: bu manzil hozir yangi saytga ochilmayapti (domen hali eski Netlify loyihasida bo‘lishi mumkin). Netlify’da PUBLIC_SITE_URL ni yangi sayt manziliga (masalan, https://oqtoshrestoran.netlify.app) o‘zgartiring yoki domenni ko‘chiring.' }) : '',
      el('p', { className: 'muted', textContent: 'Mison kabineti → Внешние сервисы → API → kalit qatori → ⋮ → Вебхук: shu manzilni yozing; "order.status_changed", "stop_list.changed", "cheque.closed", "cheque.deleted"ni belgilang. "Секрет подписи"ni pastdagi «Webhook maxfiy kaliti» maydoniga qo‘ying.' }),
      el('p', { className: w.secretSet ? 'ok-text' : 'form-error', textContent: w.secretSet ? `Maxfiy kalit kiritilgan. ${last}` : 'Maxfiy kalit kiritilmagan — webhook so‘rovlari qabul qilinmaydi.' }),
      w.last?.lastRejectAtMs && (!w.last.lastAtMs || w.last.lastRejectAtMs > w.last.lastAtMs)
        ? el('p', { className: 'form-error', textContent: `Oxirgi rad etilgan so‘rov (${new Date(w.last.lastRejectAtMs).toLocaleString('ru-RU')}): ${w.last.lastReject}` }) : '');
  }).catch((e) => box.replaceChildren(el('p', { className: 'form-error', textContent: e.message })));
  return box;
}

function botStatus() {
  const box = el('div', { className: 'bot-status', ariaLive: 'polite' }, el('span', { className: 'muted', textContent: 'Bot holati tekshirilmoqda…' }));
  const call = (action) => (e) => busy(e.currentTarget, '…', async () => {
    try {
      await api('/telegram/webhook', { method: 'POST', body: { action } });
      toast(action === 'delete' ? 'Webhook o‘chirildi.' : 'Webhook ulandi — bot saytga ulandi.');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  async function load() {
    try {
      const r = await api('/telegram/info');
      if (!r.configured) return box.replaceChildren(el('span', { className: 'muted', textContent: 'Bot tokeni kiritilmagan — saytda Telegram orqali kirish ishlamaydi.' }));
      if (r.error) return box.replaceChildren(el('span', { className: 'form-error', textContent: r.error }));
      const hooked = r.webhook.url && r.webhook.url === r.expectedUrl;
      box.replaceChildren(
        el('strong', { textContent: `Mijozlar kirishi: @${r.bot.username}` }),
        el('span', { className: hooked ? 'ok-text' : 'form-error', textContent: hooked ? 'Saytga ulangan (webhook ishlayapti).' : r.webhook.url ? `Webhook boshqa manzilga ulangan: ${r.webhook.url}` : 'Webhook ulanmagan — mijozlar botdan kod ololmaydi.' }),
        r.webhook.lastError ? el('span', { className: 'form-error', textContent: `Oxirgi xato: ${r.webhook.lastError}` }) : '',
        !r.canSet ? el('span', { className: 'muted', textContent: 'Webhook uchun admin saytda PUBLIC_SITE_URL https:// bilan yozilgan bo‘lishi kerak. Lokal sinovda .env’ga TELEGRAM_POLLING=true yozing.' }) : '',
        el('span', { className: 'row' },
          r.canSet ? btn(hooked ? 'Qayta ulash' : 'Webhook’ni ulash', call('set'), 'btn-small') : '',
          r.webhook.url ? btn('Webhook’ni o‘chirish', call('delete'), 'btn-text btn-small danger') : ''));
    } catch (err) {
      box.replaceChildren(el('span', { className: 'form-error', textContent: err.message }));
    }
  }
  load();
  return box;
}

function secretControl(key, label, state) {
  let remove = false;
  const status = el('p', { className: 'secret-status' });
  const input = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: false, placeholder: state.set ? 'Yangisini kiritish uchun yozing' : 'Kalitni kiriting', maxLength: 500 });
  input.id = `in-${key}`;
  const show = el('button', { type: 'button', className: 'btn btn-text btn-small', textContent: 'Ko‘rsatish', onclick: () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    show.textContent = input.type === 'password' ? 'Ko‘rsatish' : 'Yashirish';
  } });
  const del = el('button', { type: 'button', className: 'btn btn-text btn-small danger', textContent: 'O‘chirish', onclick: () => {
    remove = !remove;
    del.textContent = remove ? 'Bekor qilish' : 'O‘chirish';
    paint();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } });
  function paint() {
    if (remove) status.textContent = 'Saqlaganingizda kalit o‘chiriladi.';
    else if (state.broken) status.textContent = 'Saqlangan kalitni o‘qib bo‘lmadi (Firebase kaliti almashgan). Qayta kiriting.';
    else status.textContent = state.set ? `Saqlangan: ${state.hint} (${SOURCE[state.source]})` : 'Kiritilmagan';
    status.className = `secret-status ${state.set && !remove && !state.broken ? 'is-set' : 'is-empty'}`;
    del.hidden = state.source !== 'admin';
  }
  paint();
  return {
    node: el('div', { className: 'field' }, el('label', { htmlFor: input.id, textContent: label }), status, el('div', { className: 'row' }, input, show, del)),
    patch: () => (remove ? null : input.value.trim() || undefined),
    override: () => input.value.trim(),
  };
}

function plainControl(key, label, state, opts = {}) {
  const input = opts.options
    ? el('select', {}, opts.options.map(([v, l]) => el('option', { value: v, textContent: l })))
    : el('input', { type: opts.type || 'text', value: state.value || '', placeholder: opts.placeholder || '', maxLength: 500, spellcheck: false });
  if (opts.options) input.value = state.value || opts.options[0][0];
  input.id = `in-${key}`;
  if (opts.inputmode) input.inputMode = opts.inputmode;
  const initial = input.value;
  const source = state.source && state.source !== 'admin' && !opts.options ? ` (${SOURCE[state.source]})` : '';
  return {
    node: el('div', { className: 'field' }, el('label', { htmlFor: input.id, textContent: label }), input,
      (opts.hint || source) && el('p', { className: 'hint', textContent: [opts.hint, source && `Hozir: ${SOURCE[state.source]}`].filter(Boolean).join('. ') })),
    patch: () => (input.value.trim() !== initial ? input.value.trim() : undefined),
    override: () => input.value.trim(),
    input,
  };
}

// "Tekshirish" natijasidagi ro'yxatdan qiymatni maydonga qo'yish
function pickList(title, rows, control, current, emptyLabel) {
  const set = (value, name) => {
    control.input.value = value;
    control.input.dispatchEvent(new Event('input', { bubbles: true }));
    toast(`${name} tanlandi. Endi "Saqlash"ni bosing.`);
  };
  return el('div', { className: 'pick-list' },
    el('p', { className: 'pick-title', textContent: title }),
    el('ul', { className: 'chat-list' },
      emptyLabel ? el('li', {}, el('span', { textContent: `${emptyLabel}${!current ? ' — ishlatilmoqda' : ''}` }), current ? btn('Tanlash', () => set('', emptyLabel), 'btn-ghost btn-small') : '') : '',
      rows.map((r) => el('li', {},
        el('span', { textContent: `${r.label}${String(r.value) === String(current) ? ' — ishlatilmoqda' : ''}` }),
        String(r.value) === String(current) ? '' : btn('Tanlash', () => set(String(r.value), r.short || r.label), 'btn-ghost btn-small')))));
}

function groupCard(group, state, reload) {
  const controls = {};
  const make = ([key, label, opts]) => {
    controls[key] = state[key].secret ? secretControl(key, label, state[key]) : plainControl(key, label, state[key], opts);
    return controls[key].node;
  };
  const result = el('div', { className: 'test-result', ariaLive: 'polite' });
  const overrides = () => Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.override()]));

  const save = btn('Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
    const patch = {};
    for (const [k, c] of Object.entries(controls)) {
      const v = c.patch();
      if (v !== undefined) patch[k] = v;
    }
    if (!Object.keys(patch).length) return toast('O‘zgarish yo‘q.');
    try {
      await api('/integrations', { method: 'PUT', body: patch });
      toast('Saqlandi.');
      window.__adminDirty = false;
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  const actions = [save];
  let extra = '';
  const show = (...nodes) => result.replaceChildren(...nodes);
  const fail = (err) => show(el('p', { className: 'form-error', textContent: err.message }));

  if (group.id === 'pos') {
    extra = misonWebhookBox();
    actions.push(btn('Tekshirish', (e) => busy(e.currentTarget, 'Tekshirilmoqda…', async () => {
      try {
        const r = await api('/test/pos', { method: 'POST', body: overrides() });
        const point = r.points.find((p) => p.id === r.pointId);
        show(
          el('p', { className: r.count ? 'ok-text' : 'form-error', textContent: r.count ? `Ulandi: ${r.count} ta taom, ${r.categories.length} ta kategoriya${r.stopped ? `, stop-listda ${r.stopped} ta` : ''}.` : 'Javob keldi, lekin undan taom topilmadi. Pastdagi javobni ko‘ring.' }),
          point ? el('p', { textContent: `Filial: ${point.name}${point.address ? `, ${point.address}` : ''}` }) : '',
          r.shift ? el('p', { className: r.shift.alive ? 'ok-text' : 'form-error', textContent: r.shift.alive ? `Kassa smenasi ochiq${r.shift.since ? ` (${r.shift.since} dan)` : ''}.` : 'Kassada smena yopiq — buyurtmalar Mison’ga tushmaydi, smena ochilganda ishlaydi.' }) : '',
          el('ul', { className: 'facts' },
            el('li', { textContent: `Rasmli: ${r.withImage} · og‘irligi bor: ${r.withWeight} · kaloriyasi bor: ${r.withNutrition}` }),
            el('li', { textContent: `Qo‘shimcha (modifikator) bor: ${r.withOptions} ta taom${r.requiredOptions.length ? `, majburiy tanlov: ${r.requiredOptions.join(', ')}` : ''} — mijoz saytda tanlaydi` }),
            r.limited ? el('li', { textContent: `Cheklangan qoldiq: ${r.limited} ta taom (saytda "N ta qoldi")` }) : '',
            el('li', { textContent: r.tables?.error ? `Stollar: olinmadi (${r.tables.error}) — stol raqami izohda yuboriladi` : `Stollar: ${r.tables?.count || 0} ta${r.tables?.sample?.length ? ` (${r.tables.sample.map((t) => t.name).join(', ')})` : ''} — buyurtma stoliga bog‘lanadi` })),
          r.sample.length ? el('table', { className: 'table' },
            el('thead', {}, el('tr', {}, ['Taom', 'Narx', 'Kategoriya', 'Holat'].map((h) => el('th', { textContent: h })))),
            el('tbody', {}, r.sample.map((i) => el('tr', {}, el('td', { textContent: i.name }), el('td', { textContent: formatPrice(i.price) }), el('td', { textContent: i.category }), el('td', { textContent: i.available ? 'Bor' : 'Stop-list' }))))) : '',
          r.points.length > 1 ? pickList('Filiallar', r.points.map((p) => ({ value: p.id, label: `${p.name}${p.address ? ` — ${p.address}` : ''}`, short: p.name })), controls.misonPointId, r.pointId, '') : '',
          r.menus.length ? pickList('Menyular (vitrina)', r.menus.map((m) => ({ value: m.id, label: `${m.name} (ID ${m.id})`, short: m.name })), controls.misonMenuId, r.menuId, 'To‘liq nomenklatura') : '',
          r.paymentTypes.length ? pickList('To‘lov turi (Mison’ga yuboriladigan buyurtmalar uchun)', r.paymentTypes.map((t) => ({ value: t.id, label: `${t.name} (ID ${t.id})`, short: t.name })), controls.misonPaymentTypeId, overrides().misonPaymentTypeId || r.paymentTypeId, '') : '',
          el('details', {}, el('summary', { textContent: 'Mison javobi (boshi)' }), el('pre', { textContent: r.raw })));
      } catch (err) {
        fail(err);
      }
    }), 'btn-ghost'));
    actions.push(btn('Menyuni hozir yangilash', (e) => busy(e.currentTarget, 'Yangilanmoqda…', async () => {
      try {
        const m = await api('/menu/refresh', { method: 'POST', body: {} });
        if (m.source === 'pos') toast(`Menyu yangilandi: ${m.count} ta taom.`);
        else show(el('p', { className: 'form-error', textContent: m.posError || 'POS’dan olib bo‘lmadi.' }));
      } catch (err) {
        fail(err);
      }
    }), 'btn-text'));
  }

  if (group.id === 'groq') {
    const q = el('input', { value: 'Qanday taomlaringiz bor?', maxLength: 300, ariaLabel: 'Sinov savoli' });
    actions.push(btn('Tekshirish', (e) => busy(e.currentTarget, 'Javob kutilmoqda…', async () => {
      try {
        const r = await api('/test/groq', { method: 'POST', body: { ...overrides(), question: q.value } });
        show(el('p', { className: 'ok-text', textContent: 'Ulandi. Yordamchi javobi:' }), el('blockquote', { className: 'reply', textContent: r.reply }));
      } catch (err) {
        fail(err);
      }
    }), 'btn-ghost'));
    q.id = 'groq-question';
    extra = el('div', { className: 'field' }, el('label', { htmlFor: q.id, textContent: 'Sinov savoli' }), q);
  }

  if (group.id === 'telegram') {
    const addId = (input, id) => {
      const ids = input.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.includes(id)) ids.push(id);
      input.value = ids.join(', ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      toast('Qo‘shildi. Endi "Saqlash"ni bosing.');
    };
    extra = botStatus();
    actions.push(btn('Chat ID topish', (e) => busy(e.currentTarget, 'Qidirilmoqda…', async () => {
      try {
        const { chats } = await api('/telegram/chats', { method: 'POST', body: overrides() });
        if (!chats.length) return show(el('p', { className: 'form-error', textContent: 'Hech kim yozmagan. Telegram’da shikoyatlar botiga (va asosiy botga) /start yozing va qayta bosing.' }));
        const via = (c) => [c.complaints && 'shikoyatlar boti', c.orders && 'asosiy bot'].filter(Boolean).join(', ');
        show(el('p', { textContent: 'Botlarga yozgan chatlar — kerakligini qo‘shing:' }),
          el('ul', { className: 'chat-list' }, chats.map((c) => el('li', {},
            el('span', { textContent: `${c.name || 'Nomsiz'} (${c.type === 'private' ? 'shaxsiy' : c.type}) — ${c.id} · ${via(c)}` }),
            el('span', { className: 'row' },
              c.complaints ? btn('Shikoyatlarga', () => addId(controls.telegramChatId.input, c.id), 'btn-ghost btn-small') : '',
              c.orders ? btn('Buyurtmalarga', () => addId(controls.telegramOrdersChatId.input, c.id), 'btn-ghost btn-small') : '')))),
          chats.some((c) => c.complaints) ? '' : el('p', { className: 'muted', textContent: 'Shikoyatlar botiga hali hech kim yozmagan — shikoyat keladigan odam unga /start yozsin.' }));
      } catch (err) {
        fail(err);
      }
    }), 'btn-ghost'));
    actions.push(btn('Shikoyatlar chatiga sinov', (e) => busy(e.currentTarget, 'Yuborilmoqda…', async () => {
      try {
        const r = await api('/test/telegram', { method: 'POST', body: overrides() });
        show(el('p', { className: 'ok-text', textContent: `Yuborildi: ${r.sent} ta chatga.${r.failed.length ? ` Xato: ${r.failed.join('; ')}` : ''}` }));
      } catch (err) {
        fail(err);
      }
    }), 'btn-ghost'));
  }

  return card(group.title, group.desc,
    el('div', { className: 'grid-2' }, group.fields.map(make)),
    group.advanced ? el('details', { className: 'advanced' }, el('summary', { textContent: 'Qo‘shimcha sozlamalar' }), el('div', { className: 'grid-2' }, group.advanced.map(make))) : '',
    extra,
    el('div', { className: 'card-actions' }, actions),
    result);
}

export async function render(root) {
  const state = await api('/integrations');
  const list = el('div', { className: 'stack' });
  const reload = async () => {
    const fresh = await api('/integrations');
    list.replaceChildren(...GROUPS.map((g) => groupCard(g, fresh, reload)));
  };
  list.append(...GROUPS.map((g) => groupCard(g, state, reload)));
  list.addEventListener('input', () => (window.__adminDirty = true));
  root.append(
    pageHead('Kalitlar va ulanishlar', 'Kalitlar shifrlangan holda saqlanadi va bu yerda faqat oxirgi 4 belgisi ko‘rinadi. Firebase kalitlari xavfsizlik uchun faqat Netlify / .env’da turadi.'),
    list);
}
