// Xodim sahifalari uchun "yurak urishi": Firebase Realtime Database'dagi bitta raqamga doimiy ulanish (SSE).
// Buyurtma, stol hisobi, chaqiruv yoki smena o'zgarsa — server shu raqamni yangilaydi va sahifa darhol
// (1–2 soniyada) serverdan yangisini so'raydi. O'zgarish bo'lmasa — serverga deyarli so'rov ketmaydi
// (zaxira uchun 1,5 daqiqada bir). Shunday qilib Firestore o'qishlari va Netlify kreditlari tejaladi.
// Realtime Database yoqilmagan bo'lsa — sahifa oddiy tekshiruvda qoladi (20 soniyada bir).

let src = null;
let srcUrl = '';
let value = '';
let errors = 0;
let timer = null;
const failed = new Map(); // ishlamagan manzil → qachon qayta urinish mumkin
const subs = new Set();

export const pulseValue = () => value;
export const pulseLive = () => Boolean(src);
// So'rovga sahifa ko'rgan qiymat qo'shiladi: server qisqa keshdan emas, yangisini beradi
export const withP = (path) => (value ? `${path}${path.includes('?') ? '&' : '?'}p=${value}` : path);
export function onPulse(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
// Keyingi tekshiruvgacha: ulangan bo'lsa — kamdan-kam (zaxira), aks holda — oddiy
export const nextDelay = (plain = 20_000) => (document.hidden ? (src ? 180_000 : 60_000) : src ? 90_000 : plain);

function fire() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const fn of subs) {
      try {
        fn();
      } catch {}
    }
  }, 600); // ketma-ket o'zgarishlar bitta so'rovga yig'iladi
}

function stop() {
  src?.close();
  src = null;
  srcUrl = '';
}

export function listenPulse(url) {
  if (!url || typeof EventSource === 'undefined') return stop();
  if (url === srcUrl && src) return;
  if ((failed.get(url) || 0) > Date.now()) return;
  stop();
  srcUrl = url;
  errors = 0;
  try {
    src = new EventSource(url);
    let primed = false; // ulanishdagi birinchi xabar — hozirgi qiymat (o'zgarish emas)
    const hit = (e) => {
      errors = 0;
      let v = '';
      try {
        v = String(JSON.parse(e.data)?.data ?? '');
      } catch {}
      if (v === 'null') v = '';
      if (!primed) {
        primed = true;
        const changed = Boolean(value) && Boolean(v) && v !== value; // qayta ulanganda o'tkazib yuborilgan o'zgarish
        if (v) value = v;
        if (changed) fire();
        return;
      }
      if (!v || v === value) return;
      value = v;
      fire();
    };
    src.addEventListener('put', hit);
    src.addEventListener('patch', hit);
    // ishlamasa — oddiy tekshiruvga qaytamiz (fire: sahifa hozir yangilanib, keyingisini 20 soniyaga qo'yadi)
    src.addEventListener('cancel', () => {
      failed.set(url, Date.now() + 10 * 60_000); // ruxsat yo'q — 10 daqiqa oddiy tekshiruv
      stop();
      fire();
    });
    src.addEventListener('error', () => {
      if (++errors >= 3) {
        failed.set(url, Date.now() + 2 * 60_000);
        stop();
        fire();
      }
    });
  } catch {
    src = null;
  }
}
