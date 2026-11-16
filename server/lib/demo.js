// Faqat DEMO_MODE=true bo'lganda ishlatiladi (kalitlarsiz sinash uchun). Haqiqiy saytda o'chiring.
export const demoRestaurant = {
  about:
    'Bu demo matn. Oqtosh — milliy va yevropa taomlari restorani. Osh ertalabdan qozonda damlanadi, non tandirdan issiq chiqadi.',
  phone: '+998 90 000 00 00',
  telegram: '@oqtosh_demo',
  instagram: '@oqtosh_demo',
  locations: [
    { name: 'Markaziy filial', address: 'Toshkent sh., Demo ko‘chasi, 1-uy', landmark: 'Demo bozor yonida', phone: '+998 90 000 00 00', hours: '10:00 – 23:00', lat: 41.3111, lng: 69.2797 },
    { name: 'Chilonzor filiali', address: 'Toshkent sh., Chilonzor, Demo mavzesi, 5-uy', landmark: 'Metro yonida', phone: '+998 90 000 00 01', hours: '09:00 – 00:00', lat: 41.2756, lng: 69.2034 },
  ],
  news: [
    { title: 'Demo yangilik: kuzgi menyu', date: '2026-11-05', text: 'Bu demo matn. Kuzgi menyuga dimlama, mastava va issiq somsa qo‘shildi. Har kuni soat 12:00 dan 15:00 gacha biznes-lanch.', image: '' },
    { title: 'Demo yangilik: Chilonzorda yangi filial', date: '2026-10-20', text: 'Bu demo matn. Chilonzor filiali endi har kuni ochiq, 80 o‘rinli oilaviy zal bilan.', image: '' },
    { title: 'Demo yangilik: bepul yetkazib berish', date: '2026-10-02', text: 'Bu demo matn. 150 000 so‘mdan yuqori buyurtmalar shahar bo‘ylab bepul yetkaziladi.', image: '' },
  ],
  hours: [
    { days: 'Dushanba – Juma', time: '10:00 – 23:00' },
    { days: 'Shanba – Yakshanba', time: '09:00 – 00:00' },
  ],
  delivery: 'Shahar bo‘ylab yetkazib berish 40–60 daqiqa, 150 000 so‘mdan bepul.',
  payment: 'Naqd, Click, Payme, Uzcard, Humo',
  features: ['Oilaviy zal', 'Bolalar burchagi', 'Avtoturargoh', 'Wi‑Fi'],
  banquet: 'Banket zali 120 kishigacha.',
  faq: [{ q: 'Stol band qilsa bo‘ladimi?', a: 'Ha, telefon orqali kamida 2 soat oldin.' }],
};

export const demoMenu = {
  categories: ['Milliy taomlar', 'Sho‘rvalar', 'Salatlar', 'Ichimliklar'],
  items: [
    { id: 'd1', name: 'Toshkent oshi', price: 45000, category: 'Milliy taomlar', description: 'Devzira guruch, qazi, bedana tuxumi', image: '', available: true },
    { id: 'd2', name: 'Qozon kabob', price: 65000, category: 'Milliy taomlar', description: 'Qo‘y go‘shti va kartoshka, qozonda', image: '', available: true },
    { id: 'd3', name: 'Manti (5 dona)', price: 38000, category: 'Milliy taomlar', description: 'Qo‘y go‘shti va dumba', image: '', available: true },
    { id: 'd4', name: 'Lag‘mon', price: 35000, category: 'Milliy taomlar', description: 'Qo‘lda cho‘zilgan xamir', image: '', available: false },
    { id: 'd5', name: 'Mastava', price: 28000, category: 'Sho‘rvalar', description: 'Guruchli sho‘rva, qatiq bilan', image: '', available: true },
    { id: 'd6', name: 'Shurpa', price: 32000, category: 'Sho‘rvalar', description: 'Qo‘y go‘shti, sabzavotlar', image: '', available: true },
    { id: 'd7', name: 'Achchiq‑chuchuk', price: 15000, category: 'Salatlar', description: 'Pomidor, piyoz, achchiq qalampir', image: '', available: true },
    { id: 'd8', name: 'Toshkent salati', price: 32000, category: 'Salatlar', description: 'Turp, go‘sht, tuxum', image: '', available: true },
    { id: 'd9', name: 'Ko‘k choy (choynak)', price: 8000, category: 'Ichimliklar', description: '', image: '', available: true },
    { id: 'd10', name: 'Kompot', price: 12000, category: 'Ichimliklar', description: 'Uy kompoti, 1 litr', image: '', available: true },
  ],
};
