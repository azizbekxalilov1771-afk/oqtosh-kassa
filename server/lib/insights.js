import { getConfig } from './config.js';
import { ownerReport } from './owner.js';
import { groqChat } from './assistant.js';

// AI tahlil (bosh panel): eng yaxshi taomlar, eng yaxshi xodimlar, nimaga e'tibor berish.
//   1) Hamma raqamlarni server o'zi hisoblaydi (facts) — AI hech narsa hisoblamaydi.
//   2) AI (Groq) shu raqamlardan 3–5 qisqa xulosa yozadi (o'zbekcha).
//   3) Tekshiruvchi: AI matnidagi har bir raqam facts'da bo'lishi shart; bo'lmasa — AI matni tashlanadi
//      va xulosalar oddiy qoidalar bilan yoziladi. Shunday qilib "o'ylab topilgan" raqam ko'rinmaydi.
//   Natija 20 daqiqa xotirada (har ochilganda AI'ga so'rov ketmasin).

const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const cache = new Map();

export function buildFacts(r) {
  const t = r.totals || {};
  const p = r.prevTotals || {};
  const products = (r.products || []).filter((x) => x.sum > 0);
  const top = products.slice(0, 5).map((x) => ({ name: x.name, qty: x.qty, sum: x.sum, share: pct(x.sum, t.revenue) }));
  const byQty = [...products].sort((a, b) => b.qty - a.qty).slice(0, 3).map((x) => ({ name: x.name, qty: x.qty }));
  const weak = products.length > 8 ? products.slice(-3).reverse().map((x) => ({ name: x.name, qty: x.qty, sum: x.sum })) : [];
  const waiters = (r.waiters || []).filter((w) => w.cheques > 0);
  const topStaff = waiters.slice(0, 5).map((w) => ({ name: w.name, revenue: w.revenue, cheques: w.cheques, avg: w.avg, share: pct(w.revenue, t.revenue) }));
  const bestAvg = waiters.filter((w) => w.cheques >= 3).sort((a, b) => b.avg - a.avg)[0];
  const hours = (r.byHour || []).filter((h) => h.revenue > 0);
  const peak = hours.length ? hours.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;
  const days = (r.byDay || []).filter((d) => d.revenue > 0);
  const bestDay = days.length > 1 ? days.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null;
  return {
    range: r.range,
    source: r.source,
    revenue: t.revenue || 0,
    cheques: t.cheques || 0,
    avg: t.avg || 0,
    prevRevenue: p.revenue || 0,
    change: p.revenue ? Math.round(((t.revenue - p.revenue) / p.revenue) * 100) : null,
    topProducts: top,
    mostOrdered: byQty,
    weakProducts: weak,
    unsold: (r.unsold || []).slice(0, 5).map((x) => x.name),
    topStaff,
    bestAvgStaff: bestAvg ? { name: bestAvg.name, avg: bestAvg.avg, cheques: bestAvg.cheques } : null,
    peakHour: peak ? { label: peak.label, revenue: peak.revenue, cheques: peak.cheques } : null,
    bestDay: bestDay ? { day: bestDay.label, revenue: bestDay.revenue } : null,
  };
}

// AI'siz xulosalar (AI ulanmagan yoki xato raqam yozgan bo'lsa)
export function plainLines(f) {
  const out = [];
  if (!f.revenue) return ['Bu davrda sotuv yo‘q — tahlil uchun ma’lumot kam.'];
  if (f.change !== null) out.push(`Tushum ${fmt(f.revenue)} so‘m — oldingi davrga nisbatan ${f.change >= 0 ? `${f.change}% ko‘p` : `${Math.abs(f.change)}% kam`}.`);
  const [a, b] = f.topProducts;
  if (a) out.push(`Eng ko‘p pul keltirgan taom — ${a.name}: ${fmt(a.sum)} so‘m (tushumning ${a.share}%)${b ? `, keyin ${b.name}` : ''}.`);
  const s = f.topStaff[0];
  if (s) out.push(`Eng ko‘p sotgan xodim — ${s.name}: ${s.cheques} ta buyurtma, ${fmt(s.revenue)} so‘m.`);
  if (f.bestAvgStaff && f.bestAvgStaff.name !== s?.name) out.push(`O‘rtacha chek bo‘yicha eng yaxshisi — ${f.bestAvgStaff.name}: ${fmt(f.bestAvgStaff.avg)} so‘m.`);
  if (f.peakHour) out.push(`Eng gavjum soat — ${f.peakHour.label} (${f.peakHour.cheques} ta buyurtma): shu vaqtga xodim va tayyor mahsulotni oldindan tayyorlang.`);
  if (f.weakProducts.length) out.push(`Kam sotilgan: ${f.weakProducts.map((x) => x.name).join(', ')} — menyudagi o‘rni yoki narxini ko‘rib chiqing.`);
  return out.slice(0, 5);
}

// AI matnidagi raqamlar facts'dagi raqamlardan biri bo'lishi kerak (1 000 000 → "1 000 000", foiz, soat)
function allowedNumbers(f) {
  const set = new Set();
  const walk = (v) => {
    if (typeof v === 'number') {
      set.add(String(Math.round(v)));
      set.add(String(Math.abs(Math.round(v))));
      if (!Number.isInteger(v)) set.add(String(v).replace('.', ','));
    } else if (typeof v === 'string') (v.match(/\d+/g) || []).forEach((d) => set.add(String(Number(d))));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(f);
  return set;
}
export function validateText(text, f) {
  const ok = allowedNumbers(f);
  // "1 250 000", "1,5", "12%", "18:00" → raqam guruhlari
  const nums = String(text).replace(/(\d)[\s  ](?=\d{3}\b)/g, '$1').match(/\d+(?:[.,]\d+)?/g) || [];
  for (const n of nums) {
    const v = n.replace(',', '.');
    const whole = String(Math.round(Number(v)));
    if (!ok.has(n) && !ok.has(whole) && !ok.has(String(Number(v)))) return { ok: false, bad: n };
  }
  return { ok: true };
}

const SYSTEM = `Siz restoran egasiga savdo tahlilini yozadigan yordamchisiz. Faqat o'zbek tilida (lotin), qisqa va aniq yozing.
QOIDALAR:
- Faqat berilgan JSON ma'lumotdagi raqamlarni ishlating. Hech qanday raqamni o'zingiz hisoblamang, yaxlitlamang va o'ylab topmang.
- Summalarni "1 250 000 so'm" ko'rinishida yozing (JSON'dagi qiymatning o'zi).
- 3–5 ta qator yozing, har biri alohida qatorda, "- " bilan boshlansin. Har qator — bitta foydali xulosa yoki maslahat.
- Mavzular: eng yaxshi taomlar, eng yaxshi xodimlar, gavjum soat, kam sotilganlar, o'tgan davr bilan solishtirish.
- Kirish so'zlari, sarlavha, emoji yozmang.`;

export async function ownerInsights(query = {}, { fresh = false } = {}) {
  const key = JSON.stringify([query.from || '', query.to || '', query.days || '', query.source || '']);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 20 * 60_000) return hit.value;
  const r = await ownerReport(query);
  const facts = buildFacts(r);
  let lines = plainLines(facts);
  let ai = false;
  let aiNote = '';
  const cfg = await getConfig().catch(() => ({}));
  if (cfg.groqApiKey && facts.revenue) {
    try {
      const text = await groqChat(cfg, [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(facts) }], { temperature: 0.2, maxTokens: 500, timeoutMs: 12_000 });
      const got = text.split('\n').map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, '').trim()).filter((l) => l.length > 8).slice(0, 5);
      const check = validateText(got.join('\n'), facts);
      if (got.length && check.ok) {
        lines = got;
        ai = true;
      } else aiNote = check.bad ? `AI noto‘g‘ri raqam yozdi (${check.bad}) — tekshirilgan xulosalar ko‘rsatildi.` : '';
    } catch (e) {
      aiNote = e.message;
    }
  }
  const value = { facts, lines, ai, aiNote, aiAvailable: Boolean(cfg.groqApiKey), source: r.source, generatedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}
