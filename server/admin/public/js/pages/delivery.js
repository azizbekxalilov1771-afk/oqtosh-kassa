import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, toggleField, group } from '../ui.js';

// Yetkazib berish sozlamalari: narx masofaga qarab, izoh mijozga ko'rinadi
export async function render(root) {
  const d = await api('/delivery');
  const enabled = toggleField({ label: 'Yetkazib berish yoqilgan', checked: d.enabled, hint: 'Yoqilsa, saytda “Restoranda / Yetkazib berish” tanlovi chiqadi.' });
  const f = group({
    baseFee: textField({ label: 'Yaqin masofa narxi, so‘m', value: d.baseFee, type: 'number', inputmode: 'numeric' }),
    baseRadiusKm: textField({ label: 'Yaqin masofa, km (masalan, mahalla ichi)', value: d.baseRadiusKm, type: 'number', inputmode: 'decimal' }),
    perKm: textField({ label: 'Undan keyin har km uchun, so‘m', value: d.perKm, type: 'number', inputmode: 'numeric' }),
    maxKm: textField({ label: 'Eng uzoq masofa, km', value: d.maxKm, type: 'number', inputmode: 'decimal' }),
    minOrder: textField({ label: 'Eng kam buyurtma, so‘m (0 — cheklovsiz)', value: d.minOrder, type: 'number', inputmode: 'numeric' }),
    roadFactor: textField({ label: 'Yo‘l koeffitsienti', value: d.roadFactor, type: 'number', inputmode: 'decimal', hint: 'Xaritadagi to‘g‘ri masofa × shu son = yo‘l masofasi. Shahar uchun 1,3.' }),
  });
  const note = textField({ label: 'Mijozga izoh', value: d.note, rows: 3, maxlength: 400, placeholder: 'Masalan: Oqtosh mahallasi ichida — 15 000 so‘m, qolgan joylarga masofaga qarab (har km 3 000 so‘m).', hint: 'Bo‘sh qoldirilsa, narxlardan o‘zi yoziladi.' });
  const lat = textField({ label: 'Restoran kengligi (lat)', value: d.lat ?? '', type: 'number', inputmode: 'decimal', placeholder: '41.2995' });
  const lng = textField({ label: 'Restoran uzunligi (lng)', value: d.lng ?? '', type: 'number', inputmode: 'decimal', placeholder: '69.2401' });
  const example = el('p', { className: 'notice' });
  const fmt = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} so‘m`;
  const paintExample = () => {
    const v = f.get();
    const fee = (km) => Math.round((Number(v.baseFee) + Math.max(0, Math.ceil(km - Number(v.baseRadiusKm))) * Number(v.perKm)) / 500) * 500;
    example.textContent = `Misol: 1 km — ${fmt(fee(1))}, 3 km — ${fmt(fee(3))}, 5 km — ${fmt(fee(5))}, 10 km — ${fmt(fee(10))}.`;
  };
  root.addEventListener('input', paintExample);
  paintExample();

  const here = btn('Hozirgi joyim (restoranda turib bosing)', () => {
    navigator.geolocation?.getCurrentPosition((p) => {
      lat.set(p.coords.latitude.toFixed(6));
      lng.set(p.coords.longitude.toFixed(6));
      toast('Joylashuv olindi. Saqlashni bosing.');
    }, () => toast('Joylashuv olinmadi — brauzerga ruxsat bering.', 'error'), { enableHighAccuracy: true, timeout: 15000 });
  }, 'btn-ghost btn-small');

  const save = btn('Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
    try {
      await api('/delivery', { method: 'PUT', body: { ...f.get(), enabled: enabled.get(), note: note.get(), lat: lat.get(), lng: lng.get() } });
      toast('Saqlandi. Saytda 1 daqiqa ichida ko‘rinadi.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  root.append(
    pageHead('Yetkazib berish', 'Mijoz xaritada uyini belgilaydi — narx restorandan masofaga qarab o‘zi hisoblanadi. Buyurtmani kassa tasdiqlaydi, kuryer /kuryer.html sahifasida ko‘radi.', save),
    card('Holat', '', enabled.node,
      d.originFound ? '' : el('p', { className: 'notice warn', textContent: 'Restoran joyi belgilanmagan — yetkazish narxi hamma manzilga bir xil (yaqin masofa narxi). Masofaga qarab hisoblash uchun pastda “Restoran joyi”ni to‘ldiring.' })),
    card('Narx', '', f.node, example),
    card('Mijozga izoh', '', note.node),
    card('Restoran joyi', 'Masofa shu nuqtadan hisoblanadi. Bo‘sh qoldirilsa — “Manzillar”dagi birinchi filial koordinatasi olinadi.', el('div', { className: 'grid-2' }, lat.node, lng.node), here));
}
