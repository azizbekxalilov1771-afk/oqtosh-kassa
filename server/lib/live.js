// Server kompyuteri rejimida "qo'ng'iroq" va "yurak urishi" — Firebase Realtime Database o'rniga shu serverning
// o'zi. Sahifalar va printer dasturi oldingidek SSE orqali ulanadi, xabar formati ham aynan Realtime Database'niki
// (event: put, data: {"path":"/","data":…}) — mijoz kodi o'zgarmaydi.
//   GET /live/rings/<kanal>.json  (Accept: text/event-stream)

const values = new Map();
const subs = new Map();
let open = 0;
const MAX_STREAMS = 400;

export const liveValue = (name) => (values.has(name) ? values.get(name) : null);

export function livePut(name, value) {
  values.set(name, value);
  for (const fn of subs.get(name) || []) {
    try {
      fn(value);
    } catch {}
  }
}

function subscribe(name, fn) {
  if (!subs.has(name)) subs.set(name, new Set());
  subs.get(name).add(fn);
  return () => {
    const s = subs.get(name);
    s?.delete(fn);
    if (s && !s.size) subs.delete(name);
  };
}

export const liveStats = () => ({ streams: open, channels: subs.size });

// Node http (req, res) — oqim uzoq ochiq turadi
export function handleLive(req, res, pathname) {
  const m = /^\/live\/(rings\/[a-z0-9]{32,48})\.json$/.exec(pathname);
  if (!m || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  if (open >= MAX_STREAMS) {
    res.writeHead(503, { 'Retry-After': '30' }).end();
    return;
  }
  const name = m[1];
  open++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('put', { path: '/', data: liveValue(name) });
  const off = subscribe(name, (v) => send('put', { path: '/', data: v }));
  // Cloudflare va proksilar jim ulanishni ~100 soniyada uzadi — har 25 soniyada belgi
  const ping = setInterval(() => res.write('event: keep-alive\ndata: null\n\n'), 25_000);
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    off();
    open = Math.max(0, open - 1);
  };
  req.on('close', done);
  res.on('error', done);
}
