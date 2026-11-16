import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, listField, group, saveBar } from '../ui.js';

// Yandex / Google xarita havolasidan koordinata ajratib olish
export function parseCoords(link) {
  const s = decodeURIComponent(String(link || ''));
  let m;
  if (/google\./i.test(s)) {
    m = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s) || /[?&](?:q|query|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(s); // kenglik,uzunlik
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  m = /[?&](?:ll|pt|whatshere\[point\])=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s); // Yandex: uzunlik,kenglik
  if (m) return { lat: Number(m[2]), lng: Number(m[1]) };
  m = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/.exec(s); // "41.311081, 69.240562"
  if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  return null;
}

function locationForm(l) {
  const g = group({
    name: textField({ label: 'Filial nomi', value: l.name, placeholder: 'Markaziy filial', maxlength: 80 }),
    address: textField({ label: 'Manzil', value: l.address, placeholder: 'Toshkent sh., ... ko‘chasi, 12-uy', maxlength: 200 }),
    landmark: textField({ label: 'Mo‘ljal', value: l.landmark, maxlength: 150 }),
    phone: textField({ label: 'Telefon', value: l.phone, type: 'tel', maxlength: 30 }),
    hours: textField({ label: 'Ish vaqti', value: l.hours, placeholder: '10:00 – 23:00', maxlength: 80 }),
    lat: textField({ label: 'Kenglik (lat)', value: l.lat, inputmode: 'decimal', maxlength: 20 }),
    lng: textField({ label: 'Uzunlik (lng)', value: l.lng, inputmode: 'decimal', maxlength: 20 }),
  });
  const link = el('input', { type: 'url', placeholder: 'Yandex yoki Google xarita havolasini shu yerga qo‘ying', maxLength: 1000 });
  const fill = btn('Koordinatani olish', () => {
    const c = parseCoords(link.value);
    if (!c) return toast('Havoladan koordinata topilmadi. Xaritada joyni bosib, havolani qayta nusxalang.', 'error');
    g.fields.lat.set(c.lat.toFixed(6));
    g.fields.lng.set(c.lng.toFixed(6));
    link.value = '';
    g.node.dispatchEvent(new Event('input', { bubbles: true }));
    toast('Koordinata qo‘yildi.');
  }, 'btn-ghost btn-small');
  return {
    node: el('div', { className: 'stack-sm' }, g.node, el('div', { className: 'field coords-helper' }, el('span', { className: 'field-label', textContent: 'Xaritadan olish' }), el('div', { className: 'row' }, link, fill))),
    get: g.get,
  };
}

export async function render(root) {
  const data = await api('/restaurant');
  const list = listField({
    items: data.locations || [], max: 20, addLabel: 'Filial qo‘shish',
    itemTitle: (i) => `${i + 1}-filial`,
    blank: () => ({ name: '', address: '', landmark: '', phone: '', hours: '', lat: '', lng: '' }),
    make: locationForm,
  });
  // Mison POS'dagi filiallar: nom, manzil, telefon, koordinata. Mavjud (shu nomli) filiallarga tegmaydi.
  const fromMison = btn('Mison’dan filiallarni olish', (e) => busy(e.currentTarget, 'Olinmoqda…', async () => {
    try {
      const { points } = await api('/mison/points', { method: 'POST', body: {} });
      const have = new Set(list.get().map((l) => l.name.trim().toLowerCase()));
      let added = 0;
      for (const p of points) {
        if (have.has(p.name.trim().toLowerCase())) continue;
        if (!list.add({ name: p.name, address: p.address, landmark: '', phone: p.phone, hours: '', lat: p.lat ?? '', lng: p.lng ?? '' })) break;
        added++;
      }
      toast(added ? `${added} ta filial qo‘shildi. Ish vaqti va mo‘ljalni yozing, keyin "Saqlash".` : points.length ? 'Mison’dagi filiallar ro‘yxatda bor.' : 'Mison’da filial topilmadi.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }), 'btn-ghost btn-small');
  const page = el('div', { className: 'stack' },
    card('Filiallar', 'Har bir filial saytdagi "Manzillar" bo‘limida xarita bilan ko‘rinadi. Koordinata bo‘lmasa, xarita o‘rniga faqat manzil va xarita tugmalari chiqadi.',
      el('div', { className: 'row' }, fromMison, el('span', { className: 'hint', textContent: 'Nom, manzil, telefon va koordinata Mison POS’dan olinadi.' })), list.node));
  const bar = saveBar(page, async () => {
    Object.assign(data, await api('/restaurant', { method: 'PUT', body: { ...data, locations: list.get() } }));
  });
  root.append(pageHead('Manzillar', 'Restoran filiallari va xaritadagi joylashuvi.'), page, bar.node);
}
