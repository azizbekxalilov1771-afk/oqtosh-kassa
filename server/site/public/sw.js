// Xodim sahifalari (kassa, ofitsiant, kuryer, ombor) uchun service worker — admin saytida /xodim/sw.js.
// Internet bor paytda har doim serverdagi yangi fayl olinadi va nusxasi saqlanadi (network-first);
// internet uzilsa — sahifa, JS, CSS va rasmlar shu nusxadan ochiladi (oq "sahifa topilmadi" oynasi chiqmaydi).
// /api so'rovlari, POST va boshqa saytlar hech qachon saqlanmaydi: buyurtma va to'lov faqat server orqali.

const CACHE = 'oq-xodim-v1';
const SHELL = ['kassa.html', 'ofitsiant.html', 'kuryer.html', 'ombor.html', 'styles.css', 'order.css', 'pos.css', 'logo.jpg', 'favicon.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((f) => c.add(new URL(f, self.registration.scope)).catch(() => {})))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('oq-xodim-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const scope = () => new URL(self.registration.scope);
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const s = scope();
  if (url.origin !== s.origin || !url.pathname.startsWith(s.pathname) || url.pathname.endsWith('/sw.js')) return;
  if (req.headers.get('accept')?.includes('text/event-stream')) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    throw err;
  }
}
