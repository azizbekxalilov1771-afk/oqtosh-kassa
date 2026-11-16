import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, toggleField, fmtDateTime } from '../ui.js';

// To'lovlar: kassadagi to'lov turlari (yoqish/o'chirish, nomi, qo'shimcha turlar), to'lov tizimlari kalitlari
// (Click, Payme, Uzum — shifrlangan holda saqlanadi), smena qoidasi va oxirgi smenalar.

const KIND = { cash: 'naqd pul (qaytim bilan)', card: 'bank kartasi', click: 'Click', payme: 'Payme', uzum: 'Uzum', other: 'qo‘shimcha' };
const PROVIDERS = [
  { title: 'Click', desc: 'my.click.uz → Kabinet → Sozlamalar. Service ID, Merchant ID, Merchant user ID va Secret key.', fields: [
    ['clickServiceId', 'Service ID', 'numeric'], ['clickMerchantId', 'Merchant ID', 'numeric'], ['clickMerchantUserId', 'Merchant user ID', 'numeric'], ['clickSecretKey', 'Secret key', 'secret']] },
  { title: 'Payme', desc: 'business.payme.uz → Kassa → Sozlamalar. Kassa ID (merchant) va kalit; sinov uchun — test kaliti.', fields: [
    ['paymeMerchantId', 'Kassa ID (merchant ID)', 'text'], ['paymeKey', 'Kalit (key)', 'secret'], ['paymeTestKey', 'Test kaliti', 'secret']] },
  { title: 'Uzum', desc: 'Uzum Bank / Apelsin biznes kabineti: terminal ID va API kalit.', fields: [
    ['uzumTerminalId', 'Terminal ID', 'text'], ['uzumApiKey', 'API kalit', 'secret']] },
];

export async function render(root) {
  let [{ methods, shift }, cfg, shifts] = await Promise.all([api('/payments'), api('/integrations'), api('/shifts').catch(() => ({ items: [] }))]);

  /* — to'lov turlari — */
  const list = el('div', { className: 'pay-list' });
  let draft = methods.map((m) => ({ ...m }));
  function paintMethods() {
    list.replaceChildren(...draft.map((m, i) => {
      const on = el('input', { type: 'checkbox', className: 'switch', checked: m.on, ariaLabel: `${m.label} yoqilgan` });
      on.addEventListener('change', () => { m.on = on.checked; });
      const label = el('input', { type: 'text', value: m.label, maxLength: 40, ariaLabel: 'Nomi' });
      label.addEventListener('input', () => { m.label = label.value; });
      const move = el('span', { className: 'row' },
        btn('↑', () => { if (i) { [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; paintMethods(); } }, 'btn-text btn-small'),
        m.kind === 'other' ? btn('✕', () => { draft.splice(i, 1); paintMethods(); }, 'btn-text btn-small danger') : '');
      return el('div', { className: 'pay-item' }, on, label, el('span', { className: 'pay-kind', textContent: KIND[m.kind] || m.kind }), move);
    }));
  }
  paintMethods();
  const newLabel = textField({ label: 'Yangi to‘lov turi', placeholder: 'Masalan: Humo, Uzcard, Bank o‘tkazmasi, Apelsin' , maxlength: 40 });
  const addBtn = btn('Qo‘shish', () => {
    const v = newLabel.get();
    if (!v) return;
    draft.push({ key: '', label: v, kind: 'other', on: true });
    newLabel.set('');
    paintMethods();
  }, 'btn-ghost');
  const saveMethods = btn('Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
    try {
      const r = await api('/payments', { method: 'PUT', body: { methods: draft } });
      draft = r.methods.map((m) => ({ ...m }));
      paintMethods();
      toast('To‘lov turlari saqlandi. Kassada sahifa yangilanganda ko‘rinadi.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  /* — to'lov tizimlari kalitlari — */
  const providerCard = (p) => {
    const inputs = p.fields.map(([k, label, kind]) => {
      const c = cfg[k] || {};
      const f = textField({
        label, type: kind === 'secret' ? 'password' : 'text', inputmode: kind === 'numeric' ? 'numeric' : undefined,
        value: kind === 'secret' ? '' : c.value || '', placeholder: kind === 'secret' ? (c.set ? `saqlangan ${c.hint}` : 'kiritilmagan') : '',
      });
      return { k, kind, f };
    });
    const set = inputs.some(({ k }) => cfg[k]?.set || cfg[k]?.value);
    return card(`${p.title}${set ? ' · ✓ ulangan' : ''}`, p.desc,
      el('div', { className: 'grid-2' }, inputs.map((x) => x.f.node)),
      el('div', { className: 'row' },
        btn('Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
          const patch = {};
          for (const { k, kind, f } of inputs) {
            const v = f.get();
            if (kind === 'secret') {
              if (v) patch[k] = v;
            } else patch[k] = v;
          }
          try {
            cfg = await api('/integrations', { method: 'PUT', body: patch });
            toast(`${p.title} kalitlari saqlandi (shifrlangan).`);
            for (const { kind, f } of inputs) if (kind === 'secret') f.set('');
          } catch (err) {
            toast(err.message, 'error');
          }
        })),
        set ? btn('O‘chirish', (e) => busy(e.currentTarget, '…', async () => {
          if (!confirm(`${p.title} kalitlari o‘chirilsinmi?`)) return;
          const patch = Object.fromEntries(inputs.map(({ k, kind }) => [k, kind === 'secret' ? null : '']));
          try {
            cfg = await api('/integrations', { method: 'PUT', body: patch });
            toast('O‘chirildi.');
          } catch (err) {
            toast(err.message, 'error');
          }
        }), 'btn-text danger') : ''));
  };

  /* — smena qoidasi — */
  const req = toggleField({ label: 'Smena ochilmaguncha kassa to‘lov olmasin', checked: shift.required, hint: 'O‘chiq bo‘lsa — smena ochilmagan bo‘lsa birinchi to‘lov uni o‘zi ochadi (boshlang‘ich naqd 0).' });
  req.input.addEventListener('change', async () => {
    try {
      ({ shift } = await api('/payments', { method: 'PUT', body: { shift: { required: req.get() } } }));
      toast('Saqlandi.');
    } catch (err) {
      req.set(!req.get());
      toast(err.message, 'error');
    }
  });
  const money = (n) => (n === null || n === undefined ? '—' : `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`);
  const shiftList = shifts.items.length ? el('table', { className: 'stock-table' },
    el('thead', {}, el('tr', {}, ...['#', 'Ochildi', 'Yopildi', 'Savdo', 'Farq'].map((t, i) => el('th', { className: i > 2 ? 'num' : '', textContent: t })))),
    el('tbody', {}, shifts.items.map((s) => el('tr', {},
      el('td', { textContent: String(s.number) }), el('td', { textContent: `${fmtDateTime(s.openedAt)} · ${s.openedByName}` }),
      el('td', { textContent: s.status === 'open' ? 'ochiq' : `${fmtDateTime(s.closedAt)} · ${s.closedByName}` }),
      el('td', { className: 'num', textContent: money(s.revenue) }), el('td', { className: 'num', textContent: s.diff ? money(s.diff) : s.status === 'open' ? '' : '0' })))))
    : el('p', { className: 'muted', textContent: 'Hali smena bo‘lmagan.' });

  root.append(
    pageHead('To‘lovlar', 'Kassadagi to‘lov turlari, to‘lov tizimlari kalitlari va smena qoidasi.'),
    card('Kassadagi to‘lov turlari', 'Yoqilganlari kassaning to‘lov oynasida shu tartibda chiqadi. Naqd — qaytim bilan hisoblanadi.', list,
      el('div', { className: 'row align-end wrap' }, newLabel.node, addBtn), el('div', { className: 'row' }, saveMethods)),
    el('h2', { className: 'section-title', textContent: 'To‘lov tizimlari (API kalitlar)' }),
    el('p', { className: 'muted', textContent: 'Kalitlar shifrlangan holda saqlanadi va hech qayerda to‘liq ko‘rsatilmaydi. Onlayn to‘lov (mijoz QR orqali to‘laydi, kassa o‘zi tasdiqlaydi) shu kalitlar bilan ulanadi.' }),
    el('div', { className: 'grid-3 gap-lg' }, PROVIDERS.map(providerCard)),
    card('Smena', '', req.node),
    card('Oxirgi smenalar', 'Batafsil hisobot — Bosh panel (Owner) va kassadagi “Smena” bo‘limida.', shiftList));
}
