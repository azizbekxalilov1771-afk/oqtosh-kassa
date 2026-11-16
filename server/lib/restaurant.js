// Boshlang'ich restoran ma'lumoti. Admin panelda "Restoran ma'lumotlari" saqlangandan keyin
// sayt Firestore'dagi (settings/restaurant) ma'lumotni ishlatadi — bu fayl faqat birinchi holat.

export const defaultRestaurant = {
  name: 'Oqtosh Restoran',
  tagline: 'Milliy taomlar, issiq non va choy — oilaviy davra uchun.',

  // Logo rasmi: public/ papkasiga logo.png qo'ying va '/logo.png' deb yozing.
  // Bo'sh bo'lsa, saytdagi sopol lagan belgisi logo bo'lib turadi.
  logo: '',

  // "Buyurtma berish" tugmasi qayerga olib boradi: bo'sh — saytdagi buyurtma bo'limi (/buyurtma.html)
  orderUrl: '',
  orderingEnabled: true, // onlayn buyurtma (Telegram orqali kirish → savat → QR → ofitsiant)
  orderingNote: '', // buyurtma sahifasida ko'rinadigan eslatma

  about: '', // Restoran haqida 2–4 gap: tarixi, oshxonasi, nimasi bilan mashhur
  phone: '', // Asosiy telefon: +998 90 123 45 67
  phone2: '',
  telegram: '', // @username yoki https://t.me/...
  instagram: '', // @username
  hours: [
    // { days: 'Har kuni', time: '10:00 – 23:00' },
  ],
  delivery: '', // Yetkazib berish shartlari
  payment: '', // To‘lov usullari: naqd, Click, Payme, Uzcard, Humo...
  features: [], // ['Oilaviy zal', 'Bolalar burchagi', 'Avtoturargoh', 'Wi‑Fi']
  banquet: '', // To‘y/banket, zal sig‘imi

  // Filiallar / manzillar. lat va lng bo'lsa saytda xarita chiqadi.
  // Koordinatani olish: Yandex xaritada joyni bosing → pastdagi raqamlar (41.311081, 69.240562)
  locations: [
    // {
    //   name: 'Markaziy filial',
    //   address: 'Toshkent sh., ... ko‘chasi, 12-uy',
    //   landmark: '... yonida',
    //   phone: '+998 90 123 45 67',
    //   hours: '10:00 – 23:00',
    //   lat: 41.311081,
    //   lng: 69.240562,
    // },
  ],

  // Yangiliklar. Firestore ulangan bo'lsa, ular "news" kolleksiyasidan olinadi
  // (Firebase Console → Firestore → news → Add document) va bu ro'yxat ishlatilmaydi.
  news: [
    // { title: 'Yangi taom: qozon kabob', date: '2026-11-01', text: '...', image: '' },
  ],

  faq: [
    // { q: 'Stol band qilsa bo‘ladimi?', a: 'Ha, telefon orqali.' },
  ],
};
