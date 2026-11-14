import { el } from './common.js';

// Xodim sahifalari uchun: ovozli "Yangi buyurtma", tebranish va brauzer bildirishnomasi.
// Brauzerlar ovozni faqat foydalanuvchi bir marta bosgandan keyin ruxsat beradi — shuning uchun "Ovozni yoqish" tugmasi.
// Telefon qulflangan bo'lsa ham xabar kelishi uchun — Telegram (har bir xodimga shaxsiy xabar boradi).

const KEY = 'oq_sound';
let ctx = null;
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
})();

function unlock() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
}

function chime() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const [i, f] of [[0, 880], [1, 1175], [2, 1568]]) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.35, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.32);
    o.connect(g).connect(ctx.destination);
    o.start(t + i * 0.16);
    o.stop(t + i * 0.16 + 0.34);
  }
}

function say(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /^uz/i.test(v.lang)) || voices.find((v) => /^(tr|ru)/i.test(v.lang)) || null;
    u.lang = u.voice?.lang || 'uz-UZ';
    u.rate = 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

// Yangi buyurtma: ovoz + ovozli xabar + tebranish + (sahifa yashirin bo'lsa) bildirishnoma
export function alertNew(title, body = '') {
  if (enabled) {
    unlock();
    chime();
    setTimeout(() => say(`${title}. ${body}`), 650);
  }
  navigator.vibrate?.([220, 90, 220, 90, 220]);
  try {
    if (document.hidden && Notification.permission === 'granted') new Notification(title, { body, icon: '/icon-192.png', tag: 'oqtosh-new', renotify: true });
  } catch {}
}

// Sarlavhadagi tugma: ovozni yoqish/o'chirish (bosilganda ovoz va bildirishnomaga ruxsat so'raladi)
export function soundToggle() {
  const b = el('button', { type: 'button', className: 'sound-toggle' });
  const paint = () => {
    b.textContent = enabled ? '🔔' : '🔕';
    b.title = enabled ? 'Ovozli bildirishnoma yoqilgan' : 'Ovozli bildirishnoma o‘chiq';
    b.setAttribute('aria-pressed', String(enabled));
    b.setAttribute('aria-label', b.title);
  };
  b.addEventListener('click', () => {
    enabled = !enabled;
    try {
      localStorage.setItem(KEY, enabled ? 'on' : 'off');
    } catch {}
    if (enabled) {
      unlock();
      chime();
      try {
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      } catch {}
    }
    paint();
  });
  // birinchi teginishda ovoz tizimini ochib qo'yamiz
  addEventListener('pointerdown', unlock, { once: true });
  paint();
  return b;
}

// Ro'yxatni kuzatish: yangi ID paydo bo'lsa — signal (birinchi yuklashda emas)
export function newItemsWatcher() {
  let seen = null;
  return (ids, onNew) => {
    const fresh = seen ? ids.filter((id) => !seen.has(id)) : [];
    seen = new Set(ids);
    if (fresh.length) onNew(fresh);
  };
}
