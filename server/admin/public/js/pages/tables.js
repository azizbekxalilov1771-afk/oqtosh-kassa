import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card } from '../ui.js';
import { qrSvg } from '../vendor/qrcode.js';

// Mison POS'dagi zal va stollar: xizmat foizi (umumiy va har bir stolga) + har bir stol uchun QR stiker
export async function render(root) {
  let [data, conf] = await Promise.all([api('/tables'), api('/tables/config')]);
  const body = el('div', { className: 'stack' });
  const link = (t) => `${data.siteUrl || location.origin}/buyurtma.html?stol_id=${encodeURIComponent(t.id)}`;
  const pctInputs = new Map(); // tableId → input
  const defInput = el('input', { type: 'number', min: 0, max: 50, step: 0.5, value: conf.defaultPct ?? 0, className: 'pct-input', inputMode: 'decimal', id: 'svc-default' });

  const save = btn('Foizlarni saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
    const perTable = {};
    for (const [id, input] of pctInputs) if (input.value.trim() !== '') perTable[id] = Number(input.value);
    try {
      conf = await api('/tables/config', { method: 'PUT', body: { defaultPct: Number(defInput.value || 0), perTable } });
      toast('Saqlandi. Yangi ochilgan stol hisoblariga qo‘llanadi; ochiq hisobni kassa o‘zgartiradi.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  function paint() {
    if (!data.halls.length) {
      body.replaceChildren(card('Stollar olinmadi',
        data.error === 'ruxsat'
          ? 'Mison API kalitida stollar (bron) ruxsati yo‘q. Mison kabineti → Tashqi xizmatlar → API → "Sayt uchun" kaliti → ruxsatlar: "Бронирование столов"ni yoqing, keyin "Mison’dan yangilash"ni bosing. Shungacha mijoz stol raqamini qo‘lda yozadi.'
          : `Mison’dan zal va stollar kelmadi${data.error ? `: ${data.error}` : ''}. Kalitlar → Mison → "Tekshirish" bilan ulanishni tekshiring. Shungacha mijoz stol raqamini qo‘lda yozadi.`));
      return;
    }
    const total = data.halls.reduce((s, h) => s + h.tables.length, 0);
    pctInputs.clear();
    body.replaceChildren(
      el('p', { className: 'muted no-print', textContent: `${data.halls.length} ta zal, ${total} ta stol${data.updatedAt ? ` · Mison’dan olingan: ${new Date(data.updatedAt).toLocaleString('ru-RU')}` : ''}. Mijoz avval zalni, keyin stolni tanlaydi; QR stikerni skanerlasa — stol o‘zi tanlanadi. Bitta stolda bitta mijoz.` }),
      ...data.halls.map((h) => el('section', { className: 'card qr-hall' },
        el('h2', { textContent: h.name }),
        el('div', { className: 'qr-grid' }, h.tables.map((t) => {
          const input = el('input', { type: 'number', min: 0, max: 50, step: 0.5, value: conf.perTable?.[t.id] ?? '', placeholder: String(conf.defaultPct ?? 0), className: 'pct-input', inputMode: 'decimal', ariaLabel: `${t.label}: xizmat foizi` });
          pctInputs.set(t.id, input);
          return el('figure', { className: 'qr-tile' },
            qrSvg(link(t), { label: `${t.label} QR kodi`, margin: 2 }),
            el('figcaption', {},
              el('strong', { textContent: t.label }),
              el('span', { className: 'qr-sub', textContent: 'Skanerlang va buyurtma bering' }),
              t.capacity ? el('span', { className: 'qr-cap muted no-print', textContent: `${t.capacity} kishilik` }) : '',
              el('label', { className: 'pct-field no-print' }, el('span', { textContent: 'Xizmat %' }), input)));
        })))));
  }

  const refresh = btn('Mison’dan yangilash', (e) => busy(e.currentTarget, 'Yangilanmoqda…', async () => {
    try {
      data = await api('/tables?fresh=1');
      paint();
      toast(data.halls.length ? 'Stollar yangilandi.' : 'Stollar olinmadi.', data.halls.length ? '' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  }), 'btn-ghost');
  const print = btn('QR stikerlarni chop etish', () => window.print(), 'btn-ghost');
  paint();
  root.append(
    pageHead('Stollar', 'Mison POS’dagi zallar va stollar — saytda ham xuddi shunday. Xizmat foizi mijozning oxirgi hisobida ko‘rinadi.'),
    card('Xizmat foizi', 'Hamma stollar uchun umumiy foiz. Alohida stolga boshqa foiz kerak bo‘lsa — pastdagi stol kartasida yozing (bo‘sh qoldirilsa — umumiy foiz).',
      el('div', { className: 'row align-end wrap no-print' },
        el('div', { className: 'field' }, el('label', { htmlFor: 'svc-default', textContent: 'Umumiy foiz, %' }), defInput),
        save)),
    el('div', { className: 'card-actions no-print' }, refresh, print),
    body);
}
