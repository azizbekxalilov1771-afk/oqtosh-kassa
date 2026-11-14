// Cloudflare Worker: server kompyuteri o'chiq bo'lsa — "Restoran hozir yopiq" sahifasi (Cloudflare xatosi o'rniga).
// O'rnatish (bir marta, bepul):
//   dash.cloudflare.com → Workers & Pages → Create → Worker → nom: oqtosh-yopiq → Deploy → Edit code →
//   shu faylni to'liq qo'ying → Deploy. Keyin: Worker → Settings → Domains & Routes → Add → Route:
//   *oqtoshrestoran.uz/*   (Zone: oqtoshrestoran.uz) → Add route.
// Server ishlab tursa — hech narsa o'zgarmaydi (so'rov to'g'ridan-to'g'ri kompyuterga boradi).

const PAGE = (admin) => `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oqtosh — hozir yopiq</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f3ede2;font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;padding:24px}
.c{max-width:440px}h1{font:600 26px/1.2 Georgia,'Times New Roman',serif;margin:0 0 10px}p{color:#a49d92;margin:0 0 8px}b{color:#e5a33e}
</style></head><body><div class="c">
<h1>${admin ? 'Server kompyuteri o‘chiq' : 'Oqtosh restoran hozir yopiq'}</h1>
<p>${admin ? 'Restorandagi asosiy (server) kompyuter yoqilganda admin panel va xodim sahifalari o‘zi ishlaydi.' : 'Ish vaqtida sayt va onlayn buyurtma <b>qayta ishlaydi</b>.'}</p>
<p>${admin ? 'Kompyuter yoqiq bo‘lsa — internet aloqasini tekshiring.' : 'Iltimos, birozdan keyin qayta kiring.'}</p>
</div></body></html>`;

export default {
  async fetch(request) {
    let res;
    try {
      res = await fetch(request);
    } catch {
      res = null;
    }
    // Oqtosh serverining o'z javobi (X-Oq-Server) — o'zgarishsiz
    if (res && (res.status < 500 || res.headers.get('x-oq-server'))) return res;
    const url = new URL(request.url);
    const admin = url.hostname.startsWith('admin.');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin-api/') || url.pathname.startsWith('/live/')) {
      return new Response(JSON.stringify({ error: admin ? 'Server kompyuteri o‘chiq.' : 'Restoran hozir yopiq. Ish vaqtida qayta urinib ko‘ring.', closed: true }), {
        status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '300' },
      });
    }
    return new Response(PAGE(admin), { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '300' } });
  },
};
