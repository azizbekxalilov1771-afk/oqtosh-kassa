import { AppError } from './env.js';
import { getConfig } from './config.js';
import { getOwnMenu, replaceOwnMenu } from './ownpos.js';
import { getKitchen, saveKitchen } from './kitchen.js';
import { groqChat } from './assistant.js';

// O'z menyumiz uchun tayyor to'plamlar va izohlar:
//   1) "Ichimliklar" — Toshkentda keng sotiladigan qadoqli ichimliklar, restoran narxlari bir-biriga moslangan
//      (do'kon narxidan ~1,5–2 baravar: 0,5 L gazli — 10 000, 1 L — 16 000, 1,5 L — 20 000; 1 L sharbat — 28 000).
//      Bor taom (nomi bir xil) qayta qo'shilmaydi; yangi bo'limlar oshxona chekiga chiqmaydi (tayyor ichimlik).
//   2) Izohlar — izohi bo'sh taomlarga: AI (Groq) yozadi, AI yo'q yoki xato bo'lsa — o'zbek taomlari lug'atidan.

const D = (name, price, weight, description) => ({ name, price, weight, description });
const JUICE = (flavor, what = 'nektari') => D(`Сочная Долина ${flavor} 1 L`, 28000, '1 L', `Сочная Долина ${flavor.toLowerCase()} ${what}, 1 litrli karton qadoq. Sovuq holda stakanlar bilan beriladi.`);

export const DRINKS = [
  { category: 'Sharbatlar', items: [
    JUICE('Apelsin'), JUICE('Olma', 'sharbati'), JUICE('Multifrukt'), JUICE('Mevalar aralashmasi'), JUICE('Ananas'),
    JUICE('Shaftoli'), JUICE('Olcha'), JUICE('Pomidor', 'sharbati'),
    D('Сочная Долина Olma 0,2 L', 8000, '0,2 L', 'Kichik qadoq (0,2 L) olma sharbati, naychasi bilan — bolalarga qulay.'),
    D('Сочная Долина Apelsin 0,2 L', 8000, '0,2 L', 'Kichik qadoq (0,2 L) apelsin nektari, naychasi bilan — bolalarga qulay.'),
    D('Dena Multifrukt 1 L', 24000, '1 L', 'Dena multifrukt nektari, 1 litrli qadoq. Sovuq holda stakanlar bilan beriladi.'),
    D('Dena Ananas-olma 1 L', 24000, '1 L', 'Dena ananas va olma nektari, 1 litrli qadoq. Sovuq holda beriladi.'),
    D('Dena Apelsin 1 L', 24000, '1 L', 'Dena apelsin nektari, 1 litrli qadoq. Sovuq holda beriladi.'),
    D('Dena Olma 1 L', 24000, '1 L', 'Dena olma sharbati, 1 litrli qadoq. Sovuq holda beriladi.'),
  ] },
  { category: 'Gazli ichimliklar', items: [
    D('Coca-Cola 0,5 L', 10000, '0,5 L', 'Klassik Coca-Cola, sovuq holda beriladi.'),
    D('Coca-Cola 1 L', 16000, '1 L', 'Klassik Coca-Cola, 1 litrli shisha — 2–3 kishiga.'),
    D('Coca-Cola 1,5 L', 20000, '1,5 L', 'Klassik Coca-Cola, 1,5 litrli shisha — butun stolga.'),
    D('Coca-Cola banka 0,33 L', 10000, '0,33 L', 'Klassik Coca-Cola, temir bankada.'),
    D('Coca-Cola Shakarsiz 0,5 L', 10000, '0,5 L', 'Shakarsiz Coca-Cola — ta’mi o‘sha, shakar yo‘q.'),
    D('Coca-Cola Shakarsiz 1,5 L', 20000, '1,5 L', 'Shakarsiz Coca-Cola, 1,5 litrli shisha.'),
    D('Fanta 0,5 L', 10000, '0,5 L', 'Apelsin ta’mli Fanta, sovuq holda beriladi.'),
    D('Fanta 1 L', 16000, '1 L', 'Apelsin ta’mli Fanta, 1 litrli shisha.'),
    D('Fanta 1,5 L', 20000, '1,5 L', 'Apelsin ta’mli Fanta, 1,5 litrli shisha — butun stolga.'),
    D('Sprite 0,5 L', 10000, '0,5 L', 'Limon-laym ta’mli Sprite, sovuq holda beriladi.'),
    D('Sprite 1 L', 16000, '1 L', 'Limon-laym ta’mli Sprite, 1 litrli shisha.'),
    D('Sprite 1,5 L', 20000, '1,5 L', 'Limon-laym ta’mli Sprite, 1,5 litrli shisha — butun stolga.'),
    D('Pepsi 0,5 L', 10000, '0,5 L', 'Pepsi kola, sovuq holda beriladi.'),
    D('Pepsi 1 L', 16000, '1 L', 'Pepsi kola, 1 litrli shisha.'),
    D('Pepsi 1,5 L', 20000, '1,5 L', 'Pepsi kola, 1,5 litrli shisha — butun stolga.'),
    D('Mirinda 0,5 L', 10000, '0,5 L', 'Apelsin ta’mli Mirinda, sovuq holda beriladi.'),
    D('Mirinda 1,5 L', 20000, '1,5 L', 'Apelsin ta’mli Mirinda, 1,5 litrli shisha.'),
    D('7Up 0,5 L', 10000, '0,5 L', 'Limon-laym ta’mli 7Up, sovuq holda beriladi.'),
    D('7Up 1,5 L', 20000, '1,5 L', 'Limon-laym ta’mli 7Up, 1,5 litrli shisha.'),
    D('Schweppes Tonik 0,5 L', 12000, '0,5 L', 'Achchiqroq tonik — muz va limon bilan yaxshi.'),
  ] },
  { category: 'Sovuq choy va energetiklar', items: [
    D('Fuse Tea limon 0,5 L', 10000, '0,5 L', 'Limonli sovuq qora choy, sovuq holda.'),
    D('Fuse Tea shaftoli 0,5 L', 10000, '0,5 L', 'Shaftolili sovuq qora choy, sovuq holda.'),
    D('Fuse Tea 1 L', 15000, '1 L', 'Sovuq choy, 1 litrli shisha.'),
    D('Lipton Ice Tea limon 0,5 L', 10000, '0,5 L', 'Limonli sovuq choy, sovuq holda.'),
    D('Lipton Ice Tea shaftoli 0,5 L', 10000, '0,5 L', 'Shaftolili sovuq choy, sovuq holda.'),
    D('Lipton Ice Tea 1 L', 15000, '1 L', 'Sovuq choy, 1 litrli shisha.'),
    D('Flash Up 0,5 L', 10000, '0,5 L', 'Energetik ichimlik. Kofein bor — bolalarga tavsiya etilmaydi.'),
    D('Adrenaline Rush 0,449 L', 18000, '0,449 L', 'Energetik ichimlik. Kofein bor — bolalarga tavsiya etilmaydi.'),
    D('Red Bull 0,25 L', 22000, '0,25 L', 'Energetik ichimlik. Kofein bor — bolalarga tavsiya etilmaydi.'),
  ] },
  { category: 'Suvlar', items: [
    D('Hydrolife gazsiz 0,5 L', 5000, '0,5 L', 'Gazsiz ichimlik suvi.'),
    D('Hydrolife gazli 0,5 L', 5000, '0,5 L', 'Gazli ichimlik suvi.'),
    D('Hydrolife gazsiz 1,5 L', 9000, '1,5 L', 'Gazsiz ichimlik suvi, katta shisha — butun stolga.'),
    D('Nestlé Pure Life 0,5 L', 5000, '0,5 L', 'Gazsiz ichimlik suvi.'),
    D('Nestlé Pure Life 1,5 L', 9000, '1,5 L', 'Gazsiz ichimlik suvi, katta shisha.'),
    D('Chortoq mineral suvi 0,5 L', 7000, '0,5 L', 'Chortoq buloqlaridan tabiiy mineral suv, gazli.'),
    D('Chortoq mineral suvi 1 L', 11000, '1 L', 'Chortoq tabiiy mineral suvi, gazli, katta shisha.'),
    D('Chortoq SUV gazsiz 0,5 L', 5000, '0,5 L', 'Chortoq gazsiz ichimlik suvi.'),
    D('Omonxona mineral suvi 0,5 L', 6000, '0,5 L', 'Omonxona tabiiy mineral suvi.'),
    D('Omonxona mineral suvi 1,5 L', 10000, '1,5 L', 'Omonxona tabiiy mineral suvi, katta shisha.'),
    D('Borjomi 0,5 L', 18000, '0,5 L', 'Gruziyaning tabiiy mineral suvi, shisha idishda.'),
  ] },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’ʻʼ`']/g, "'").replace(/\s+/g, ' ').trim();

export function presetSummary() {
  return { categories: DRINKS.map((c) => ({ name: c.category, count: c.items.length })), total: DRINKS.reduce((a, c) => a + c.items.length, 0) };
}

// Ichimliklar to'plamini o'z menyuga qo'shish → { added, skipped, categories }
export async function addDrinksPreset({ skipKitchen = true } = {}) {
  const m = (await getOwnMenu()) || { items: [], categories: [], categoryImages: {} };
  const have = new Set(m.items.map((i) => norm(i.name)));
  const items = [...m.items];
  const categories = [...m.categories];
  let added = 0;
  let skipped = 0;
  const touched = [];
  for (const c of DRINKS) {
    let any = false;
    for (const it of c.items) {
      if (have.has(norm(it.name))) {
        skipped += 1;
        continue;
      }
      items.push({ id: `o${Math.floor(1e8 + Math.random() * 9e8)}`, ...it, category: c.category, available: true });
      have.add(norm(it.name));
      added += 1;
      any = true;
    }
    if (any && !categories.includes(c.category)) categories.push(c.category);
    if (any) touched.push(c.category);
  }
  if (added) await replaceOwnMenu({ ...m, items, categories });
  // tayyor ichimlik oshxonaga chek bo'lib chiqmasin (bo'limga alohida bog'lanmagan bo'lsa)
  if (added && skipKitchen) {
    const k = await getKitchen();
    const mapped = new Set((k.stations || []).flatMap((s) => s.categories || []));
    const skip = new Set(k.skip?.categories || []);
    const add = touched.filter((c) => !mapped.has(c) && !skip.has(c));
    if (add.length) await saveKitchen({ skip: { categories: [...skip, ...add], items: k.skip?.items || [] } });
  }
  return { added, skipped, categories: touched };
}

/* ───────── Izohlar ───────── */

// AI'siz: o'zbek oshxonasidagi keng tarqalgan taomlar (nomdagi so'z bo'yicha). Mos kelmasa — bo'sh qoladi.
const DICT = [
  [/samarqand.*osh|osh.*samarqand/, 'Samarqandcha osh: go‘sht va sariq sabzi guruch ustida qatlam-qatlam pishiriladi, aralashtirilmasdan tortiladi.'],
  [/to.?y oshi|toshkent.*osh|osh.*toshkent/, 'Toshkentcha to‘y oshi: guruch, mol go‘shti, sariq va qizil sabzi, no‘xat, mayiz va bedana tuxumi bilan.'],
  [/\boshi?\b|palov|plov/, 'Qozonda damlangan an’anaviy osh: guruch, mol go‘shti, sariq va qizil sabzi, piyoz, zira va no‘xat.'],
  [/lag.?mon|lagman/, 'Qo‘lda cho‘zilgan xamir, ustidan mol go‘shti, bulg‘or qalampiri, pomidor va ko‘katlar bilan qovurilgan sous.'],
  [/manti/, 'Yupqa xamir ichida maydalangan go‘sht, piyoz va dumba; bug‘da pishiriladi, qaymoq yoki qatiq bilan tortiladi.'],
  [/chuchvara|pelmen/, 'Mayda tugilgan chuchvara: go‘shtli qiyma, piyoz va ziravorlar; qaymoq bilan tortiladi.'],
  [/somsa|samsa/, 'Tandirda yopilgan qatlamli xamir, ichida go‘sht, dumba va piyoz — issiq holda.'],
  [/norin|naryn/, 'Ingichka to‘g‘ralgan uy xamiri va qaynatilgan go‘sht, piyoz va qora murch bilan — sovuq holda.'],
  [/mastava/, 'Guruchli quyuq sho‘rva: mol go‘shti, sabzi, kartoshka va pomidor; qatiq va ko‘kat bilan.'],
  [/sho.?rva|shurpa|sho.rva/, 'Go‘sht, kartoshka, sabzi, piyoz va no‘xatli tiniq sho‘rva, ko‘kat bilan.'],
  [/moshxo.?rda|mosh/, 'Mosh, guruch, go‘sht va sabzili quyuq sho‘rva, qatiq bilan.'],
  [/dimlama/, 'Go‘sht, kartoshka, karam, sabzi, bulg‘or qalampiri va pomidor o‘z sharbatida sekin dimlangan.'],
  [/qozon kabob|kazan kabob/, 'Qozonda qovurilgan yumshoq go‘sht va kartoshka, piyoz va ko‘kat bilan.'],
  [/tandir/, 'Tandirda uzoq pishirilgan yumshoq go‘sht, ziravorlar bilan.'],
  [/lula/, 'Qiyma go‘sht, piyoz va ziravorlardan sixda ko‘mirda pishirilgan lula kabob, piyoz va ko‘kat bilan.'],
  [/jigar/, 'Dumba bilan navbatma-navbat terilgan jigar, ko‘mirda pishirilgan.'],
  [/tovuq.*(kabob|shashl)|(kabob|shashl).*tovuq|qanot/, 'Ziravorlarda marinadlangan tovuq go‘shti, ko‘mirda pishirilgan.'],
  [/qo.?y.*(kabob|shashl)|(kabob|shashl).*qo.?y/, 'Qo‘y go‘shti bo‘laklari, piyoz va ziravorlarda marinadlangan, ko‘mirda pishirilgan.'],
  [/kabob|shashl|kebab/, 'Marinadlangan go‘sht sixda ko‘mirda pishiriladi, piyoz, ko‘kat va non bilan tortiladi.'],
  [/achchiq.?chuchuk/, 'Yupqa to‘g‘ralgan pomidor, piyoz va achchiq qalampir — osh va kabobga.'],
  [/shakarob/, 'Pomidor, piyoz va ko‘katdan yengil salat.'],
  [/toshkent.*salat/, 'Turp, mol go‘shti, qovurilgan piyoz va tuxumdan Toshkentcha salat.'],
  [/olivye|olivier/, 'Qaynatilgan kartoshka, sabzi, tuxum, bodring, no‘xat va go‘shtli olivye, mayonez bilan.'],
  [/sezar|caesar/, 'Aysberg salat bargi, tovuq go‘shti, suxarik va parmezan, maxsus sous bilan.'],
  [/grek/, 'Pomidor, bodring, bulg‘or qalampiri, zaytun va brinza, zaytun moyi bilan.'],
  [/vinegret/, 'Lavlagi, kartoshka, sabzi, tuzlangan bodring va karam, o‘simlik moyi bilan.'],
  [/salat/, 'Yangi uzilgan sabzavot va ko‘katlardan salat.'],
  [/\bnon\b|lepyoshka|patir/, 'Tandirda yopilgan issiq non.'],
  [/ko.?k choy|yashil choy/, 'Choynakda damlangan ko‘k choy.'],
  [/qora choy/, 'Choynakda damlangan qora choy.'],
  [/limonli choy|choy.*limon/, 'Limon bo‘laklari bilan damlangan choy.'],
  [/\bchoy\b|\btea\b/, 'Choynakda damlangan choy.'],
  [/qatiq|ayron/, 'Sovuq qatiq ichimlik, tuz va yalpiz bilan.'],
  [/kompot/, 'Quritilgan mevalardan uyda qaynatilgan kompot.'],
];
export function dictDescription(name) {
  const n = norm(name);
  for (const [re, text] of DICT) if (re.test(n)) return text;
  return '';
}

const SYSTEM = `Siz o'zbek restorani menyusi uchun taom izohlarini yozasiz. Faqat o'zbek tilida (lotin), 1 jumla, 60–160 belgi.
QOIDALAR:
- Izoh taom nimadan tayyorlanishi va qanday tortilishini aytadi (asosiy masalliqlar, pishirish usuli).
- Hech qanday raqam yozmang: narx, og'irlik, gramm, kaloriya, kishi soni — yo'q.
- Reklama so'zlari (eng mazali, betakror...) va emoji yozmang.
- Taomni tanimasangiz yoki nomidan tushunib bo'lmasa — bo'sh qator ("") qaytaring, o'ylab topmang.
Javob faqat JSON: {"<id>": "<izoh>", ...}`;

function validDesc(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length < 25 || s.length > 220) return '';
  if (/\d/.test(s) || /[А-Яа-яЁё]/.test(s) || /https?:|[<>{}]/.test(s)) return '';
  return s;
}

async function aiDescriptions(cfg, items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 40) {
    const part = items.slice(i, i + 40).map((x) => ({ id: x.id, nomi: x.name, bo_lim: x.category }));
    const text = await groqChat(cfg, [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(part) }], { temperature: 0.3, maxTokens: 3000, timeoutMs: 25_000 });
    const json = String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1);
    let obj = {};
    try {
      obj = JSON.parse(json);
    } catch {
      continue;
    }
    for (const x of part) {
      const d = validDesc(obj[x.id]);
      if (d) out.set(x.id, d);
    }
  }
  return out;
}

// Izohi bo'sh taomlarga izoh yozish (overwrite — hammasini qaytadan) → { filled, ai, dict, left, aiError }
export async function fillDescriptions({ overwrite = false } = {}) {
  const m = await getOwnMenu();
  if (!m?.items?.length) throw new AppError(409, 'O‘z menyumiz hali yo‘q.');
  const todo = m.items.filter((i) => overwrite || !String(i.description || '').trim());
  if (!todo.length) return { filled: 0, ai: 0, dict: 0, left: 0, total: m.items.length };
  const cfg = await getConfig().catch(() => ({}));
  let ai = new Map();
  let aiError = '';
  if (cfg.groqApiKey) {
    try {
      ai = await aiDescriptions(cfg, todo);
    } catch (e) {
      aiError = e.message;
    }
  }
  let nAi = 0;
  let nDict = 0;
  const byId = new Map();
  for (const i of todo) {
    const d = dictDescription(i.name);
    // lug'atdagi aniq o'zbek taomlari — lug'atdan; qolganlari — AI'dan
    const v = d || ai.get(i.id) || '';
    if (!v) continue;
    if (d) nDict += 1;
    else nAi += 1;
    byId.set(i.id, v);
  }
  if (byId.size) await replaceOwnMenu({ ...m, items: m.items.map((i) => (byId.has(i.id) ? { ...i, description: byId.get(i.id) } : i)) });
  return { filled: byId.size, ai: nAi, dict: nDict, left: todo.length - byId.size, total: m.items.length, aiAvailable: Boolean(cfg.groqApiKey), aiError };
}
