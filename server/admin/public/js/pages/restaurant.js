import { api } from '../auth.js';
import { el, pageHead, card, textField, imageField, chipsField, listField, group, saveBar, toggleField } from '../ui.js';

export async function render(root) {
  const data = await api('/restaurant');

  const f = {
    name: textField({ label: 'Restoran nomi', value: data.name, maxlength: 80 }),
    tagline: textField({ label: 'Qisqa shior', value: data.tagline, maxlength: 200, hint: 'Logo ostida ko‘rinadi' }),
    logo: imageField({ label: 'Logo', value: data.logo, hint: 'Bo‘sh bo‘lsa, sopol lagan belgisi chiqadi. Shaffof fonli PNG yaxshi ko‘rinadi.' }),
    orderLabel: textField({ label: 'Buyurtma tugmasi yozuvi', value: data.orderLabel, placeholder: 'Buyurtma berish', maxlength: 40 }),
    orderUrl: textField({ label: 'Buyurtma tugmasi havolasi', value: data.orderUrl, placeholder: '/buyurtma.html', maxlength: 600, hint: 'Bo‘sh bo‘lsa saytdagi buyurtma bo‘limi ochiladi (Telegram orqali kirish → savat → QR).' }),
    orderingEnabled: toggleField({ label: 'Onlayn buyurtma qabul qilinadi', checked: data.orderingEnabled !== false, hint: 'O‘chirilsa, mijozlar menyuni ko‘radi, lekin buyurtma bera olmaydi.' }),
    orderingNote: textField({ label: 'Buyurtma sahifasidagi eslatma', value: data.orderingNote, rows: 2, maxlength: 300, placeholder: 'Masalan: Onlayn buyurtma 10:00 dan 22:00 gacha' }),
    phone: textField({ label: 'Asosiy telefon', value: data.phone, type: 'tel', placeholder: '+998 90 123 45 67', maxlength: 30 }),
    phone2: textField({ label: 'Qo‘shimcha telefon', value: data.phone2, type: 'tel', maxlength: 30 }),
    telegram: textField({ label: 'Telegram', value: data.telegram, placeholder: '@username', maxlength: 100 }),
    instagram: textField({ label: 'Instagram', value: data.instagram, placeholder: '@username', maxlength: 100 }),
    hours: listField({
      label: 'Ish vaqti', items: data.hours || [], max: 10, addLabel: 'Qator qo‘shish',
      blank: () => ({ days: '', time: '' }),
      make: (h) => group({
        days: textField({ label: 'Kunlar', value: h.days, placeholder: 'Har kuni', maxlength: 60 }),
        time: textField({ label: 'Vaqt', value: h.time, placeholder: '10:00 – 23:00', maxlength: 60 }),
      }),
    }),
    about: textField({ label: 'Restoran haqida', value: data.about, rows: 6, maxlength: 3000 }),
    features: chipsField({ label: 'Qulayliklar', values: data.features || [], hint: 'Masalan: Oilaviy zal, Bolalar burchagi, Wi‑Fi' }),
    delivery: textField({ label: 'Yetkazib berish', value: data.delivery, rows: 3, maxlength: 600 }),
    payment: textField({ label: 'To‘lov usullari', value: data.payment, placeholder: 'Naqd, Click, Payme, Uzcard, Humo', maxlength: 300 }),
    banquet: textField({ label: 'Banket va to‘ylar', value: data.banquet, rows: 3, maxlength: 600 }),
    faq: listField({
      label: 'Savol-javoblar', items: data.faq || [], max: 30, addLabel: 'Savol qo‘shish',
      hint: 'AI yordamchi mijozlarga shu javoblarni beradi.',
      blank: () => ({ q: '', a: '' }),
      make: (x) => group({
        q: textField({ label: 'Savol', value: x.q, maxlength: 200 }),
        a: textField({ label: 'Javob', value: x.a, rows: 2, maxlength: 1000 }),
      }, 'stack-sm'),
    }),
  };

  const page = el('div', { className: 'stack' },
    card('Asosiy', 'Saytning birinchi qismi: logo, nom va buyurtma tugmasi.',
      el('div', { className: 'grid-2' }, f.name.node, f.tagline.node), f.logo.node,
      el('div', { className: 'grid-2' }, f.orderLabel.node, f.orderUrl.node)),
    card('Onlayn buyurtma', 'Stol QR stikerlari: Stollar bo‘limida (Mison’dagi stollar bo‘yicha) chop eting.', f.orderingEnabled.node, f.orderingNote.node),
    card('Bog‘lanish', 'Saytdagi "Bog‘lanish" bo‘limi va qo‘ng‘iroq tugmalari.',
      el('div', { className: 'grid-2' }, f.phone.node, f.phone2.node, f.telegram.node, f.instagram.node)),
    card('Ish vaqti', '', f.hours.node),
    card('Restoran haqida', '', f.about.node, f.features.node, el('div', { className: 'grid-2' }, f.delivery.node, f.banquet.node), f.payment.node),
    card('AI yordamchi uchun', 'Ko‘p so‘raladigan savollar.', f.faq.node));

  const bar = saveBar(page, async () => {
    const values = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.get()]));
    Object.assign(data, await api('/restaurant', { method: 'PUT', body: { ...data, ...values } }));
  });

  root.append(pageHead('Restoran ma’lumotlari', 'Saytda va AI yordamchida ko‘rinadigan barcha ma’lumot.'), page, bar.node);
}
