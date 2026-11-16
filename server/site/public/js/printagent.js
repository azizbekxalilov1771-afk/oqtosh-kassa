import { el, api } from './common.js';
import { receiptHtml } from './receipt.js';

// Chek printeri: admin panelda "asosiy kassa kompyuteri" qilib tanlangan qurilmada ishlaydi.
// Telefonlardan kelgan cheklarni oladi va ulangan printerga chiqaradi. Chrome "--kiosk-printing" bilan
// ochilgan bo'lsa — oynasiz, darhol chiqadi.
// Netlify kreditlarini tejash uchun alohida tez-tez so'rov yo'q: kassa sahifasi o'zi har 12 soniyada
// yangilanadi va server "navbatda chek bor" (pending) desa — shunda oladi. "Qo'ng'iroq" (Firebase)
// yoqilgan bo'lsa — chek paydo bo'lishi bilan darhol. Zaxira tekshiruv: 30 soniya (qo'ng'iroq bilan 2 daqiqa).

let state = 'off'; // off | waiting (boshqa oynada ishlayapti) | on
let worker = null;
let release = null;
let busy = false;
let badge = null;
let printedToday = 0;
let lastError = '';
let ringSrc = null;
let ringUrl = '';

const DONE_KEY = 'oq_printed';
const doneIds = new Set((() => {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) || '[]');
  } catch {
    return [];
  }
})());
function remember(id) {
  doneIds.add(id);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...doneIds].slice(-200)));
  } catch {}
}

function paintBadge() {
  if (state !== 'on') {
    badge?.remove();
    badge = null;
    return;
  }
  if (!badge) {
    badge = el('div', { className: 'print-badge no-print', role: 'status' });
    // xodim terminalida — yuqori panelda (pastdagi To'lov tugmalarini yopmaydi)
    (document.querySelector('.staff-app .app-header') || document.body).append(badge);
  }
  badge.classList.toggle('is-error', Boolean(lastError));
  badge.textContent = lastError ? `🖨 Printer: ${lastError}` : `🖨 Chek printeri faol${printedToday ? ` · ${printedToday} ta chiqdi` : ''}`;
}

// Chekni alohida yashirin oynada chop etish — sahifaning o'zi qog'ozga tushmaydi
function printHtml(html) {
  // Oqtosh Kassa (kompyuter dasturi) ichida — oynasiz, tanlangan printerga darhol
  if (window.OqDesktop?.printHtml) {
    return window.OqDesktop.printHtml(html).then((r) => {
      if (r && r.ok === false) lastError = r.error || 'chop etib bo‘lmadi';
    }, () => {
      lastError = 'chop etib bo‘lmadi';
    });
  }
  return new Promise((resolve) => {
    const frame = el('iframe', { title: 'Chek', tabIndex: -1, ariaHidden: 'true' });
    Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '80mm', height: '20px', border: '0' });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setTimeout(() => {
        frame.remove();
        resolve();
      }, 1200);
    };
    frame.addEventListener('load', () => {
      setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch (e) {
          lastError = 'chop etib bo‘lmadi';
          console.error('[print]', e);
        }
        finish();
      }, 200);
    }, { once: true });
    frame.srcdoc = html;
    document.body.append(frame);
    setTimeout(finish, 15000);
  });
}

// Chop etish paytida yangi chek kelsa (masalan, hisob chekidan darhol keyin to'lov) — tashlab yuborilmaydi,
// joriy chek tugashi bilan yana tekshiriladi
let again = false;
async function tick() {
  if (state !== 'on') return;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  again = false;
  try {
    const r = await api('/api/staff/print/jobs');
    if (!r.station) return stop();
    lastError = '';
    for (const job of r.jobs) {
      if (state !== 'on') break;
      if (!doneIds.has(job.id)) {
        await printHtml(receiptHtml(job));
        remember(job.id);
        printedToday++;
      }
      await api(`/api/staff/print/jobs/${encodeURIComponent(job.id)}`, { method: 'POST', body: JSON.stringify({ status: 'done' }) }).catch(() => {});
    }
  } catch (e) {
    lastError = e.status === 401 || e.status === 403 ? 'qayta kiring' : 'internet yo‘q';
  } finally {
    busy = false;
    paintBadge();
    if (again && state === 'on') setTimeout(tick, 50);
  }
}

const tickMs = () => (ringSrc ? 120_000 : 30_000);

function run() {
  return new Promise((resolve) => {
    release = resolve;
    state = 'on';
    try {
      worker = new Worker(new URL('./print-tick.js', import.meta.url));
      worker.onmessage = tick;
      worker.postMessage(tickMs());
    } catch {
      worker = { t: setInterval(tick, 30_000), terminate() { clearInterval(this.t); }, postMessage() {} };
    }
    listenRing(lastInfo?.ring || '');
    tick();
    paintBadge();
  });
}

// "Qo'ng'iroq": Firebase Realtime Database'dagi raqam o'zgarsa — yangi chek bor
let ringErrors = 0;
function listenRing(url) {
  if (url === ringUrl && (ringSrc || !url)) return;
  ringSrc?.close();
  ringSrc = null;
  ringUrl = url;
  if (!url || typeof EventSource === 'undefined' || state !== 'on') return worker?.postMessage(tickMs());
  try {
    ringSrc = new EventSource(url);
    const hit = () => {
      ringErrors = 0;
      setTimeout(tick, 100);
    };
    ringSrc.addEventListener('put', hit);
    ringSrc.addEventListener('patch', hit);
    ringSrc.addEventListener('error', () => {
      if (++ringErrors >= 5) { // ishlamayapti — oddiy tekshiruvga qaytamiz
        ringSrc?.close();
        ringSrc = null;
        worker?.postMessage(tickMs());
      }
    });
  } catch {
    ringSrc = null;
  }
  worker?.postMessage(tickMs());
}

function start() {
  if (state !== 'off') return;
  state = 'waiting';
  // Bitta kompyuterda bir nechta oyna ochiq bo'lsa — chek faqat bittasidan chiqadi
  if (navigator.locks?.request) {
    navigator.locks.request('oq-print-agent', { ifAvailable: true }, (lock) => {
      if (!lock) {
        state = 'off'; // boshqa oyna printer bo'lib turibdi; keyingi tekshiruvda yana urinadi
        return undefined;
      }
      return run();
    });
  } else run();
}

function stop() {
  worker?.terminate();
  worker = null;
  ringSrc?.close();
  ringSrc = null;
  ringUrl = '';
  state = 'off';
  release?.();
  release = null;
  paintBadge();
}

// Har so'rovda server aytadi: shu qurilma chek printerimi ({ configured, station })
export function syncPrintAgent(info) {
  if (info?.station) start();
  else if (info && state === 'on') stop();
}

// Chekni asosiy printerga yuborish. Shu qurilmaning o'zi printer bo'lsa — darhol chop etadi.
export async function sendToPrinter(body) {
  const r = await api('/api/staff/print', { method: 'POST', body: JSON.stringify(body) });
  if (r.self) return printHere();
  if (r.agent) return r.station.online ? `Chek chiqyapti (${r.station.name}).` : 'Printer dasturi hozir oflayn — kassa kompyuteri yoqilganda chek chiqadi.';
  return r.station.online
    ? `Chek kassada chiqyapti (${r.station.name}).`
    : `Kassa kompyuteri hozir oflayn — yoqilganda chek chiqadi (30 daqiqa ichida).`;
}

// To'lovdan keyin server chek qo'ygan bo'lsa (yoki shu kompyuter printer bo'lsa) — darhol olish
export function printHere() {
  lastInfo = { ...(lastInfo || {}), configured: true, station: true };
  if (state === 'off') start();
  setTimeout(tick, 150);
  return 'Chek chiqyapti.';
}

// Xodim sahifasi har so'rovdan keyin chaqiradi: printer holatini eslab qoladi va kerak bo'lsa agentni yoqadi
let lastInfo = null;
export function noteInfo(info) {
  lastInfo = info || lastInfo;
  syncPrintAgent(info);
  if (info?.station && state === 'on') {
    if ((info.ring || '') !== ringUrl && ringErrors < 5) listenRing(info.ring || '');
    if (info.pending) setTimeout(tick, 50);
  }
}

// "🖨 Chek chiqarish" tugmasi: chek kassa kompyuteridagi printerga boradi.
// Printer tanlanmagan bo'lsa va local berilgan bo'lsa — shu qurilmaning o'zida chop etadi.
export function printButton(body, { label = '🖨 Chek chiqarish', className = 'btn btn-ghost btn-wide', local } = {}) {
  const b = el('button', { type: 'button', className, textContent: label });
  const msg = el('p', { className: 'print-msg', role: 'status', hidden: true });
  let hideTimer = null;
  const say = (text, bad = false) => {
    clearTimeout(hideTimer);
    msg.textContent = text;
    msg.classList.toggle('is-bad', bad);
    msg.hidden = false;
    hideTimer = setTimeout(() => (msg.hidden = true), 6000);
  };
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      say(await sendToPrinter(body));
      navigator.vibrate?.(30);
    } catch (e) {
      if (e.status === 409 && local && /printeri tanlanmagan/.test(e.message)) local();
      else say(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  const extra = local && lastInfo?.configured && !lastInfo.station
    ? el('button', { type: 'button', className: 'btn-link small', textContent: 'yoki shu qurilmada chop etish', onclick: local }) : '';
  return el('div', { className: 'print-ctl' }, b, extra, msg);
}

// Buyurtma oynasida: oshxonaga chiqqan bo'limlar va "Qayta chiqarish" (qog'oz tugagan, chek yo'qolgan...)
export function kitchenControl(order) {
  if (order?.status !== 'qabul' || (!order.kitchenAt && !lastInfo?.kitchen)) return '';
  const msg = el('p', { className: 'print-msg', role: 'status', hidden: true });
  const say = (t, bad = false) => {
    msg.textContent = t;
    msg.classList.toggle('is-bad', bad);
    msg.hidden = false;
  };
  const sent = order.kitchenStations || [];
  const missing = order.kitchenMissing || [];
  const text = sent.length ? `🍳 Oshxonaga chiqdi: ${sent.join(', ')}` : '🍳 Oshxona cheki chiqmagan';
  const b = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: sent.length ? 'Qayta chiqarish' : 'Oshxonaga chiqarish' });
  b.addEventListener('click', async () => {
    if (sent.length && !confirm('Oshxona cheklari qayta chiqarilsinmi? (oshpaz ikki marta tayyorlab qo‘ymasin)')) return;
    b.disabled = true;
    try {
      const r = await api(`/api/staff/orders/${encodeURIComponent(order.id)}/kitchen`, { method: 'POST', body: '{}' });
      say(`Chiqyapti: ${r.stations.join(', ')}`);
      navigator.vibrate?.(30);
    } catch (e) {
      say(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return el('div', { className: 'kitchen-ctl' },
    el('p', { className: 'kitchen-ctl-text', textContent: text }),
    missing.length ? el('p', { className: 'small warn-text', textContent: `Printer tanlanmagan: ${missing.join(', ')}` }) : '',
    b, msg);
}
