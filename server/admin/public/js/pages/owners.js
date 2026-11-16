import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, fmtDateTime } from '../ui.js';

// Owner kirishi: restoran egasi (yoki boshqaruvchi) faqat savdo hisobotlarini ko'radi — admin sozlamalariga kira olmaydi.
export async function render(root) {
  let items = (await api('/owners')).items;
  const url = `${location.origin}/`;
  const list = el('ul', { className: 'item-list' });
  const paint = () => list.replaceChildren(...(items.length ? items.map((o) => el('li', { className: 'item' },
    el('span', { className: 'device-kind', textContent: '📊', ariaHidden: 'true' }),
    el('div', { className: 'item-main' }, el('h3', { textContent: o.name || o.email }), el('p', { className: 'muted', textContent: [o.name ? o.email : '', o.addedAt && `qo‘shilgan: ${fmtDateTime(o.addedAt)}`].filter(Boolean).join(' · ') })),
    el('div', { className: 'item-actions' },
      btn('Parol', (e) => {
        const pw = prompt(`${o.email} uchun yangi parol (kamida 8 belgi):`, '');
        if (!pw) return;
        busy(e.currentTarget, '…', async () => {
          try {
            await api(`/owners/${encodeURIComponent(o.email)}`, { method: 'PUT', body: { password: pw } });
            toast('Parol yangilandi.');
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-ghost btn-small'),
      btn('O‘chirish', (e) => {
        if (!confirm(`${o.email} — Owner sahifasiga kirish huquqi olinsinmi?`)) return;
        busy(e.currentTarget, '…', async () => {
          try {
            await api(`/owners/${encodeURIComponent(o.email)}`, { method: 'DELETE' });
            items = (await api('/owners')).items;
            paint();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-text btn-small danger')))) : [el('li', { className: 'empty', textContent: 'Hali Owner qo‘shilmagan. Admin emaillari Owner sahifasiga o‘zi kira oladi.' })]));
  paint();

  const devList = el('ul', { className: 'item-list' });
  const UA = (ua) => (/iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android telefon' : /Windows/.test(ua) ? 'Windows kompyuter' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Qurilma');
  async function loadDevices() {
    let devs = [];
    try {
      devs = (await api('/pin-devices')).items;
    } catch (err) {
      return devList.replaceChildren(el('li', { className: 'empty', textContent: err.message }));
    }
    devList.replaceChildren(...(devs.length ? devs.map((d) => el('li', { className: 'item' },
      el('span', { className: 'device-kind', textContent: '🔢', ariaHidden: 'true' }),
      el('div', { className: 'item-main' }, el('h3', { textContent: `${d.email} · ${UA(d.ua)}` }),
        el('p', { className: 'muted', textContent: [`o‘rnatilgan: ${fmtDateTime(d.createdAt)}`, d.lastUsedAt && `oxirgi kirish: ${fmtDateTime(d.lastUsedAt)}`].filter(Boolean).join(' · ') })),
      el('div', { className: 'item-actions' }, btn('O‘chirish', (e) => {
        if (!confirm(`${d.email} — bu qurilmada PIN bilan kirish o‘chirilsinmi?`)) return;
        busy(e.currentTarget, '…', async () => {
          try {
            await api(`/pin-devices/${d.id}`, { method: 'DELETE' });
            loadDevices();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-text btn-small danger')))) : [el('li', { className: 'empty', textContent: 'Hali hech kim PIN o‘rnatmagan.' })]));
  }

  const email = textField({ label: 'Email', type: 'email', placeholder: 'egasi@gmail.com', maxlength: 120 });
  const name = textField({ label: 'Ismi', placeholder: 'Masalan: Aziz aka', maxlength: 60 });
  const pw = textField({ label: 'Parol (kamida 8 belgi)', type: 'password', maxlength: 64, hint: 'Bu email bilan Firebase hisobi allaqachon bo‘lsa, parol o‘zgarmaydi — o‘z paroli bilan kiradi.' });
  pw.input.autocomplete = 'new-password';
  const add = btn('Qo‘shish', (e) => busy(e.currentTarget, 'Qo‘shilmoqda…', async () => {
    try {
      const r = await api('/owners', { method: 'POST', body: { email: email.get(), name: name.get(), password: pw.input.value } });
      items = r.items;
      paint();
      email.set('');
      name.set('');
      pw.set('');
      toast(r.existed ? 'Qo‘shildi — mavjud hisob, o‘z paroli bilan kiradi.' : 'Qo‘shildi. Email va parolni egasiga yuboring.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  root.append(
    pageHead('Egasi va PIN kirish', 'Restoran egasi shu admin panelga kiradi va faqat hisobotlarni ko‘radi: savdo, eng ko‘p sotilgan taomlar, gavjum soatlar, ofitsiantlar, mijozlar. Sozlamalarni o‘zgartira olmaydi.'),
    card('Manzil', 'Egasi shu manzilda email va parol bilan kiradi; keyin o‘z telefonida PIN o‘rnatib, faqat PIN bilan kiradi.',
      el('div', { className: 'row wrap align-center' }, el('code', { className: 'owner-url', textContent: url }),
        btn('Nusxa olish', async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast('Nusxa olindi.');
          } catch {
            toast(url);
          }
        }, 'btn-ghost btn-small'))),
    card('Egalar', '', list),
    card('Yangi egasi', '', el('div', { className: 'grid-2' }, email.node, name.node), pw.node, el('div', { className: 'row' }, add)),
    card('PIN bilan kiradigan qurilmalar', 'Admin va egasi email bilan bir marta kirgach, shu qurilmada PIN o‘rnatadi. Telefon yo‘qolsa yoki xodim ketsa — shu yerda o‘chiring, o‘sha qurilmada PIN darhol ishlamay qoladi.', devList));
  loadDevices();
}
