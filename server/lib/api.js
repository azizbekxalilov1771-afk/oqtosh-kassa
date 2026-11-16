import { AppError, envBool, env } from './env.js';
import { pulse, pulseInfo, cached, ttlFor, serverPulseKey } from './pulse.js';
import { json, readJson, rateLimit, errorResponse } from './http.js';
import { str } from './validate.js';
import { getConfig, clearConfigCache, staffSiteUrl } from './config.js';
import { getMenu } from './menu.js';
import { getTables, publicTables } from './tables.js';
import { tableOccupancy, getCustomerTab, staffTableMap, getTabForStaff, closeTab, listTabs, mergeTabs, setTabWaiter, setTabService, setTabDiscount } from './tabs.js';
import { publicDelivery, quoteDelivery } from './delivery.js';
import { listStaff, STAFF_ROLES } from './customers.js';
import { getRestaurantInfo } from './info.js';
import { getSections } from './layout.js';
import { getNews } from './news.js';
import { serveMedia } from './media.js';
import { askAssistant, groqConfigured, COMPLAINT_TAG } from './assistant.js';
import { submitComplaint, validateComplaint } from './complaint.js';
import { posConfigured, listCancelCauses } from './pos.js';
import { telegramConfigured, webhookSecret, loginBot } from './telegram.js';
import { getDb, localMode } from './firebase.js';
import { safeEqual } from './crypto.js';
import { handleTelegramUpdate } from './bot.js';
import { verifyMisonSignature, noteMisonReject, handleMisonEvent } from './mison-events.js';
import { startLogin, loginStatus, verifyLogin, reviewLogin, reviewLoginEnabled } from './login.js';
import { sessionCookie, clearSessionCookie, currentCustomer, requireCustomer, assertSameOrigin } from './session.js';
import { requireStaffAccess, need, needAny, permsFor } from './perms.js';
import { UNITS, stockToday, listProducts, listSuppliers, saveProduct, saveSupplier, addReceipt, listMoves, deleteMove, saveCount, stockReport } from './stock.js';
import { getShiftConfig, shiftReport, shiftBrief, openShift, cashOp, closeShift, listShifts, currentShiftId, shiftForPayment } from './shifts.js';
import { kassaMethods, methodLabels } from './payments.js';
import { listDebts, payDebt, debtOfPhone } from './debts.js';
import { getCustomer, createGuest, publicProfile, renameCustomer } from './customers.js';
import {
  createOrder, listCustomerOrders, getCustomerOrder, cancelByCustomer,
  listOrdersForStaff, getOrderForStaff, tashkentDay, findTodayByNumber, acceptOrder, rejectOrder, createStaffOrder, reprintKitchen, cancelStaffOrder,
  listDeliveries, takeDelivery, markDelivered, staffStats, voidOrderItem, payOrder, moveTabToTable, splitTab, cancelTab,
} from './orders.js';
import { wageReport, getWageRates, saveWageRates } from './wages.js';
import { callWaiter, openCalls, ackCall } from './calls.js';
import { deleteOwnAccount } from './guests.js';
import { touchDevice, printInfo, requestPrint, stationJobs, finishJob, printPaid, printDoc } from './printing.js';
import { getWorkplace, isWorkplaceIp, passwordLogin, pinLogin, PW_SESSION_HOURS } from './workplace.js';
import { requireAgent, agentHello, agentJobs, agentFinish, pairWithCode } from './agent.js';
import { saveAgentCameras } from './cameras.js';
import { ownerReport } from './owner.js';
import './kitchen.js'; // printer IP→MAC ko'chishida sozlamalarni yangilash uchun

const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=30' };

// Saytga chiqadigan ma'lumot: maxfiy hech narsa yo'q
const publicInfo = ({ news, ...info }) => info;

// Ommaviy sayt API'si (/api/*)
let lastCfgRefresh = 0;

// Profil + xodim bo'lsa ruxsatlari (sahifa tugmalarni shunga qarab ko'rsatadi)
const profileOut = async (c) => ({ ...publicProfile(c), ...(STAFF_ROLES.includes(c.role) ? { perms: await permsFor(c) } : {}) });

// scope: 'public' — mijozlar sayti (xodim API'lari yopiq, ular admin saytiga ko'chgan);
//        'staff'  — admin saytidagi xodim sahifalari (/xodim/...) uchun; 'all' — lokal ishga tushirish va sinov
const STAFF_ROUTE = /^\/api\/(staff|kassa|kuryer|ombor)(\/|$)|^\/api\/auth\/password$/;
const STAFF_SITE_ROUTE = /^\/api\/(staff|kassa|kuryer|ombor|print-agent)(\/|$)|^\/api\/(auth\/(password|logout)|me|info|menu|delivery|health)$/;

// Buyurtma, stol hisobi, chaqiruv, smena, chek yoki yetkazishni o'zgartiradigan so'rovlar — muvaffaqiyatli
// bo'lsa, xodim sahifalariga "yurak urishi" yuboriladi (ular faqat shunda yangilanadi; lib/pulse.js)
// Sahifa ko'rgan "yurak urishi" qiymati — qisqa kesh kaliti uchun
const pulseKey = (url) => String(url.searchParams.get('p') || '').replace(/\D/g, '').slice(0, 16);
// p bo'lmasa (Realtime Database o'chiq) — serverdagi o'zgarish vaqti (Firestore'dagi bitta hujjat)
const pk = async (url) => pulseKey(url) || `f${await serverPulseKey()}`;
const PULSE_ROUTE = /^\/api\/(staff|kassa|kuryer|orders?|tab|telegram\/webhook|print-agent)(\/|$)/;
export async function handleApi(request, opts = {}) {
  const res = await handleApiInner(request, opts);
  if (request.method !== 'GET' && res.status < 400) {
    const route = new URL(request.url).pathname;
    if (PULSE_ROUTE.test(route) && !/\/print-agent\/(poll|jobs|hello|ping)/.test(route) && !/\/auth\//.test(route)) await pulse().catch(() => {});
  }
  return res;
}

async function handleApiInner(request, { ip = 'unknown', scope = 'all' } = {}) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const parts = route.split('/'); // ['', 'api', ...]

  try {
    if (scope === 'public' && STAFF_ROUTE.test(route)) {
      return json({ error: `Xodimlar sahifalari ko‘chdi: ${staffSiteUrl()}/xodim/`, code: 'moved', moved: `${staffSiteUrl()}/xodim/` }, 410);
    }
    if (scope === 'staff' && !STAFF_SITE_ROUTE.test(route) && !route.startsWith('/api/media/')) return json({ error: 'Topilmadi' }, 404);
    if (route.startsWith('/api/media/') && method === 'GET') return serveMedia(parts.at(-1));

    /* ───────── Telegram bot webhook ───────── */
    if (route === '/api/telegram/webhook' && method === 'POST') {
      const cfg = loginBot(await getConfig());
      const secret = request.headers.get('x-telegram-bot-api-secret-token') || '';
      if (!cfg.telegramBotToken || !safeEqual(secret, webhookSecret(cfg))) return json({ error: 'Ruxsat yo‘q' }, 401);
      try {
        await handleTelegramUpdate(await readJson(request, 100_000), { siteUrl: url.origin });
      } catch (e) {
        console.error('[bot]', e); // Telegram qayta yubormasligi uchun baribir 200
      }
      return json({ ok: true });
    }

    /* ───────── Mison POS webhook (buyurtma holati, stop-list) ───────── */
    if (route === '/api/mison/webhook' && method === 'POST') {
      let cfg = await getConfig();
      const raw = await request.text();
      if (raw.length > 500_000) return json({ error: 'Juda katta' }, 413);
      const sig = request.headers.get('x-mison-signature');
      let valid = verifyMisonSignature(raw, sig, cfg.misonWebhookSecret);
      // admin hozirgina kalitni saqlagan bo'lishi mumkin — keshni yangilab, bir marta qayta tekshiramiz
      if (!valid && sig && Date.now() - lastCfgRefresh > 10_000) {
        lastCfgRefresh = Date.now();
        clearConfigCache();
        cfg = await getConfig();
        valid = verifyMisonSignature(raw, sig, cfg.misonWebhookSecret);
      }
      if (!valid) {
        // Mison "Проверить" oynasida server javobini ko'rsatadi — sababini aniq yozamiz
        const why = !sig ? 'X-Mison-Signature sarlavhasi yo‘q'
          : !cfg.misonWebhookSecret ? 'Saytda webhook maxfiy kaliti kiritilmagan: admin panel → Kalitlar → Mison → «Webhook maxfiy kaliti»'
            : 'Imzo mos kelmadi: admin paneldagi «Webhook maxfiy kaliti» Mison’dagi «Секрет подписи» bilan bir xil emas (yoki kalit qayta chiqarilgan)';
        await noteMisonReject(why);
        return json({ error: why }, 401);
      }
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return json({ error: 'JSON emas' }, 400);
      }
      try {
        return json({ ok: true, ...(await handleMisonEvent(evt)) });
      } catch (e) {
        console.error('[mison webhook]', e.message);
        return json({ error: 'Vaqtincha xato' }, 500); // Mison keyinroq qayta yuboradi
      }
    }

    /* ───────── Printer dasturi (kassa kompyuteridagi Windows dasturi) ───────── */
    if (parts[2] === 'print-agent') {
      if (route === '/api/print-agent/pair' && method === 'POST') {
        rateLimit(`agent-pair:${ip}`, 10, 10 * 60_000);
        return json({ ...(await pairWithCode((await readJson(request)).code)), ...(localMode() ? {} : { site: env('PUBLIC_SITE_URL').replace(/\/+$/, '') }) });
      }
      rateLimit(`agent:${ip}`, 240, 60_000);
      await requireAgent(request);
      if (route === '/api/print-agent/hello' && method === 'POST') return json(await agentHello(await readJson(request, 200_000)));
      if (route === '/api/print-agent/jobs' && method === 'GET') return json(await agentJobs());
      if (route === '/api/print-agent/cameras' && method === 'POST') return json(await saveAgentCameras(await readJson(request, 100_000)));
      if (parts[3] === 'jobs' && parts[4] && method === 'POST') return json(await agentFinish(parts[4], await readJson(request)));
      return json({ error: 'Topilmadi' }, 404);
    }

    if (method !== 'GET') assertSameOrigin(request);

    /* ───────── Ochiq ma'lumot ───────── */
    if (route === '/api/site' && method === 'GET') {
      const [info, sections, news] = await Promise.all([getRestaurantInfo(), getSections(), getNews()]);
      return json({ info: publicInfo(info), sections: sections.filter((s) => s.visible), news }, 200, PUBLIC_CACHE);
    }
    if (route === '/api/delivery' && method === 'GET') return json(await publicDelivery(), 200, { 'Cache-Control': 'public, max-age=60' });
    if (route === '/api/tables/busy' && method === 'GET') {
      const c = await currentCustomer(request);
      return json(await tableOccupancy(c?.id || ''), 200, { 'Cache-Control': 'no-store' });
    }
    if (route === '/api/tables' && method === 'GET') {
      return json(publicTables(await getTables()), 200, { 'Cache-Control': 'public, max-age=60' });
    }
    if (route === '/api/info' && method === 'GET') {
      const [info, cfg] = await Promise.all([getRestaurantInfo(), getConfig()]);
      return json({ ...publicInfo(info), loginReady: Boolean(loginBot(cfg).telegramBotToken) }, 200, PUBLIC_CACHE);
    }
    if (route === '/api/news' && method === 'GET') return json({ items: await getNews() }, 200, PUBLIC_CACHE);
    if (route === '/api/menu' && method === 'GET') {
      const { posError, ...menu } = await getMenu(); // POS xatosi faqat admin panelda ko'rinadi
      return json(menu, 200, PUBLIC_CACHE);
    }

    if (route === '/api/chat' && method === 'POST') {
      rateLimit(`chat:${ip}`, 20, 60_000);
      const raw = await askAssistant((await readJson(request, 20_000)).messages);
      return json({ reply: raw.replaceAll(COMPLAINT_TAG, '').trim(), suggestComplaint: raw.includes(COMPLAINT_TAG) });
    }

    if (route === '/api/complaint' && method === 'POST') {
      const body = await readJson(request, 20_000);
      validateComplaint(body); // xato kiritish limitni yemasin
      rateLimit(`complaint:${ip}`, 5, 10 * 60_000);
      return json({ ok: true, ...(await submitComplaint(body, { userAgent: request.headers.get('user-agent') })) });
    }

    /* ───────── Telegram orqali kirish ───────── */
    if (route === '/api/auth/start' && method === 'POST') {
      rateLimit(`login:${ip}`, 10, 10 * 60_000);
      return json(await startLogin());
    }
    if (route === '/api/auth/status' && method === 'GET') {
      return json({ status: await loginStatus(url.searchParams.get('id')) });
    }
    if (route === '/api/auth/verify' && method === 'POST') {
      rateLimit(`verify:${ip}`, 30, 10 * 60_000);
      const body = await readJson(request);
      const tgId = await verifyLogin(body.id, body.code);
      const customer = await getCustomer(tgId);
      if (!customer) throw new AppError(404, 'Hisob topilmadi. Qaytadan boshlang.');
      return json({ profile: await profileOut(customer) }, 200, { 'Set-Cookie': sessionCookie(request, customer) });
    }
    // Telegram mini-ilova: bot ichida ochilgan sahifa — Telegram imzolagan initData bilan kirish
    if (route === '/api/auth/telegram-webapp' && method === 'POST') {
      rateLimit(`twa:${ip}`, 30, 10 * 60_000);
      const { webAppLogin } = await import('./webapp.js');
      const customer = await webAppLogin((await readJson(request))?.initData);
      // Telegram Web (brauzer) ichida sahifa iframe'da — cookie bormasligi mumkin; shuning uchun kalit javobda ham
      const cookie = sessionCookie(request, customer);
      return json({ profile: await profileOut(customer), session: cookie.split(';')[0].split('=').slice(1).join('=') }, 200, { 'Set-Cookie': cookie });
    }
    // Stol QR orqali: faqat telefon raqami (Telegram'siz) — 12 soatlik mehmon sessiyasi, faqat stolga buyurtma
    if (route === '/api/auth/guest' && method === 'POST') {
      rateLimit(`guest:${ip}`, 8, 10 * 60_000);
      const b = await readJson(request);
      if (!str(b?.tableId, 40) && !str(b?.table, 10)) throw new AppError(400, 'Stol QR kodini skanerlang.');
      const guest = await createGuest({ phone: b.phone, name: b.name });
      return json({ profile: await profileOut(guest) }, 200, { 'Set-Cookie': sessionCookie(request, guest, { hours: 12 }) });
    }
    if (route === '/api/auth/review' && method === 'GET') return json({ enabled: reviewLoginEnabled() });
    if (route === '/api/auth/review' && method === 'POST') {
      rateLimit(`review:${ip}`, 8, 10 * 60_000);
      const customer = await getCustomer(await reviewLogin((await readJson(request)).code));
      return json({ profile: await profileOut(customer) }, 200, { 'Set-Cookie': sessionCookie(request, customer) });
    }
    // Xodimlar: 4 xonali PIN (telefonsiz; eski usul — telefon + PIN — ham ishlaydi) (admin "faqat restoran Wi‑Fi'sidan" desa — faqat o'sha tarmoqdan, kuryerdan tashqari)
    if (route === '/api/auth/password' && method === 'GET') {
      const w = await getWorkplace();
      return json({ wifiOnly: Boolean(w.enabled), onSite: await isWorkplaceIp(ip) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (route === '/api/auth/password' && method === 'POST') {
      rateLimit(`pw:${ip}`, 60, 10 * 60_000); // restorandagi hamma bitta IP'da — cheklov hisob bo'yicha ham bor
      const body = await readJson(request);
      const staff = body?.phone ? await passwordLogin(ip, body) : await pinLogin(ip, { pin: body?.pin ?? body?.password });
      return json({ profile: await profileOut(staff) }, 200, { 'Set-Cookie': sessionCookie(request, staff, { hours: PW_SESSION_HOURS, password: true }) });
    }
    if (route === '/api/auth/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
    }

    /* ───────── Mijoz ───────── */
    if (route === '/api/me' && method === 'GET') {
      const c = await currentCustomer(request);
      return c ? json({ profile: await profileOut(c) }, 200, { 'Cache-Control': 'no-store' }) : json({ profile: null });
    }
    if (route === '/api/me/delete' && method === 'POST') {
      const c = await requireCustomer(request);
      rateLimit(`del:${c.id}`, 5, 10 * 60_000);
      if ((await readJson(request))?.confirm !== true) throw new AppError(400, 'Tasdiqlang.');
      await deleteOwnAccount(c);
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
    }
    if (route === '/api/me' && method === 'PATCH') {
      const c = await requireCustomer(request);
      const name = await renameCustomer(c.id, (await readJson(request)).name);
      return json({ profile: publicProfile({ ...c, name }) });
    }

    if (route === '/api/orders' && method === 'GET') return json({ items: await listCustomerOrders(await requireCustomer(request)) });
    if (route === '/api/orders' && method === 'POST') {
      const c = await requireCustomer(request);
      const ob = await readJson(request);
      if (c.guest && ob?.mode === 'delivery') throw Object.assign(new AppError(403, 'Yetkazib berish uchun raqamingizni Telegram orqali tasdiqlang.'), { code: 'login' });
      rateLimit(`order:${c.id}`, 10, 10 * 60_000);
      return json({ order: await createOrder(c, ob) });
    }
    if (parts[2] === 'orders' && parts[3] && parts.length === 4 && method === 'GET') {
      return json({ order: await getCustomerOrder(await requireCustomer(request), parts[3]) });
    }
    if (parts[2] === 'orders' && parts[4] === 'cancel' && method === 'POST') {
      return json({ order: await cancelByCustomer(await requireCustomer(request), parts[3]) });
    }

    /* ───────── Mijoz: yetkazish narxi, stol hisobi ───────── */
    if (route === '/api/delivery/quote' && method === 'POST') {
      rateLimit(`quote:${ip}`, 60, 60_000);
      const b = await readJson(request);
      return json(await quoteDelivery(b.lat, b.lng));
    }
    if (route === '/api/tab' && method === 'GET') return json({ tab: await getCustomerTab(await requireCustomer(request)) });
    if (route === '/api/tab/call' && method === 'POST') {
      const c = await requireCustomer(request);
      rateLimit(`call:${c.id}`, 8, 5 * 60_000);
      return json(await callWaiter(c, (await readJson(request))?.kind));
    }

    /* ───────── Xodimlar: ofitsiant / kassir / kuryer (har amal — ruxsat bo'yicha) ───────── */
    // manager: yetkazishni boshqa kuryer olgan bo'lsa ham "yetkazildi" deya oladi
    const actorOf = (st) => ({ id: `tg:${st.id}`, name: st.name || st.firstName || 'Xodim', admin: false, manager: Boolean(st.can?.has('delivery.manage')) });

    if (parts[2] === 'staff') {
      const staff = await requireStaffAccess(request, ['page.ofitsiant', 'page.kassa']);
      const actor = actorOf(staff);
      await touchDevice(request, staff, ip);
      if (route === '/api/staff/orders' && method === 'GET') {
        const all = url.searchParams.get('mode') === 'all';
        const p = await pk(url);
        const [items, stats, calls, print, live] = await Promise.all([
          listOrdersForStaff(actor.id, { days: url.searchParams.get('days'), mode: all ? '' : 'table', liveOnly: true, p }),
          staffStats(actor.id, { p }), openCalls(actor.id, { all: staff.can.has('page.kassa'), p }), printInfo(request), pulseInfo()]);
        return json({ items, stats, calls, print, today: tashkentDay(), perms: [...staff.can], pulse: live });
      }
      // Chek: telefondan so'rov → kassa kompyuteridagi printer
      if (route === '/api/staff/print' && method === 'POST') {
        need(staff, 'bill.print');
        rateLimit(`print:${staff.id}`, 20, 60_000);
        return json(await requestPrint(await readJson(request), actor, { request, staff }));
      }
      if (route === '/api/staff/print/jobs' && method === 'GET') return json(await stationJobs(request));
      if (parts[3] === 'print' && parts[4] === 'jobs' && parts[5] && method === 'POST') return json(await finishJob(request, parts[5], await readJson(request)));
      // Xodim buyurtmasi: bo'sh/band stolga, ochiq hisobga yoki saboy
      if (route === '/api/staff/orders/new' && method === 'POST') {
        need(staff, 'order.create');
        rateLimit(`staff-order:${staff.id}`, 60, 60_000);
        return json(await createStaffOrder(staff, actor, await readJson(request, 100_000)));
      }
      if (route === '/api/staff/lookup' && method === 'GET') return json({ order: await findTodayByNumber(url.searchParams.get('number')) });
      if (route === '/api/staff/tables' && method === 'GET') {
        const p = await pk(url);
        return json(await cached(`staff-tables|${p}`, ttlFor(p, 60_000), () => staffTableMap()));
      }
      if (parts[3] === 'calls' && parts[4] && parts[5] === 'ack' && method === 'POST') return json(await ackCall(parts[4], actor));
      if (parts[3] === 'tabs' && parts[4] && parts.length === 5 && method === 'GET') return json({ tab: await getTabForStaff(parts[4]) });
      if (parts[3] === 'tabs' && parts[5] === 'close' && method === 'POST') {
        need(staff, 'tab.close');
        return json({ tab: await closeTab(parts[4], actor) });
      }
      if (parts[3] === 'orders' && parts[4] && parts.length === 5 && method === 'GET') return json({ order: await getOrderForStaff(parts[4]) });
      if (parts[3] === 'orders' && parts[5] === 'accept' && method === 'POST') {
        need(staff, 'order.accept');
        rateLimit(`accept:${staff.id}`, 60, 60_000);
        const body = await readJson(request);
        return json({ order: await acceptOrder(parts[4], { token: body.token, code: body.code }, actor) });
      }
      if (parts[3] === 'orders' && parts[5] === 'reject' && method === 'POST') {
        need(staff, 'order.accept');
        return json({ order: await rejectOrder(parts[4], (await readJson(request)).reason, actor) });
      }
      if (parts[3] === 'orders' && parts[5] === 'kitchen' && method === 'POST') {
        need(staff, 'kitchen.reprint');
        rateLimit(`kitchen:${staff.id}`, 20, 60_000);
        return json(await reprintKitchen(parts[4]));
      }
    }

    if (parts[2] === 'kassa') {
      const staff = await requireStaffAccess(request, ['page.kassa']);
      const actor = actorOf(staff);
      await touchDevice(request, staff, ip);
      if (route === '/api/kassa/tabs' && method === 'GET') {
        const closed = url.searchParams.get('scope') === 'closed';
        if (closed) need(staff, 'tab.history');
        return json({ items: await listTabs({ scope: closed ? 'closed' : 'open', days: url.searchParams.get('days') }) });
      }
      if (route === '/api/kassa/staff' && method === 'GET') {
        return json({ items: (await listStaff()).filter((s) => s.role === 'waiter' || s.role === 'cashier').map((s) => ({ id: `tg:${s.id}`, name: s.name || s.phone, role: s.role })) });
      }
      if (route === '/api/kassa/orders' && method === 'GET') {
        if (Number(url.searchParams.get('days')) > 1) need(staff, 'tab.history');
        return json({ items: await listOrdersForStaff(actor.id, { days: url.searchParams.get('days') }), today: tashkentDay() });
      }
      // 📒 Qarzlar (nasiya): ro'yxat, telefon bo'yicha ochiq qarz, qarz to'lovi
      if (route === '/api/kassa/debts' && method === 'GET') {
        need(staff, 'debt.collect');
        return json(await listDebts({ status: url.searchParams.get('status') || 'open', q: url.searchParams.get('q') || '' }));
      }
      if (route === '/api/kassa/debts/phone' && method === 'GET') {
        if (!staff.can.has('tab.debt') && !staff.can.has('debt.collect')) need(staff, 'tab.debt');
        return json(await debtOfPhone(url.searchParams.get('phone')));
      }
      if (parts[3] === 'debts' && parts[4] && parts[5] === 'pay' && method === 'POST') {
        need(staff, 'debt.collect');
        rateLimit(`debtpay:${staff.id}`, 60, 60_000);
        const b = await readJson(request);
        return json(await payDebt(parts[4], b, actor, { methods: await methodLabels(), shiftId: await shiftForPayment(actor) }));
      }
      if (route === '/api/kassa/payments' && method === 'GET') {
        const { clickPassReady } = await import('./clickpass.js');
        return json({ items: await kassaMethods(), clickPass: clickPassReady(await getConfig()) });
      }
      // ⚙ Kassa sozlamalari: savdo hisoboti va xodimlar ish haqi
      if (route === '/api/kassa/report' && method === 'GET') {
        need(staff, 'reports.view');
        const r = await ownerReport({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), source: 'site' });
        return json({ range: r.range, totals: r.totals, payments: r.payments, waiters: r.waiters, types: r.types, byHour: r.byHour, products: (r.products || []).slice(0, 15), categories: (r.categories || []).slice(0, 10) });
      }
      if (route === '/api/kassa/wages' && method === 'GET') {
        need(staff, 'wages.view');
        return json(await wageReport({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
      }
      if (route === '/api/kassa/wages/rates') {
        if (method === 'GET') {
          need(staff, 'wages.view');
          return json(await getWageRates());
        }
        if (method === 'PUT') {
          need(staff, 'wages.manage');
          return json(await saveWageRates(await readJson(request)));
        }
      }
      if (route === '/api/kassa/deliveries' && method === 'GET') {
        need(staff, 'delivery.manage');
        const days = Number(url.searchParams.get('days')) || 1;
        const p = await pk(url);
        return json({ items: await cached(`kassa-deliveries|${days}|${p}`, days === 1 ? ttlFor(p) : 0, () => listDeliveries({ days })) });
      }

      /* — smena — */
      // ?brief=1 — faqat smena ochiqmi (stollar sahifasi uchun, yengil); aks holda — X-hisobot (ruxsatga qarab)
      if (route === '/api/kassa/shift' && method === 'GET') {
        const full = url.searchParams.get('brief') !== '1' && (staff.can.has('reports.view') || staff.can.has('shift.close') || staff.can.has('shift.cash'));
        // stollar sahifasi har yangilanishda so'raydi — qisqa umumiy kesh
        const { id, required, brief } = await cached(`shift-brief|${await pk(url)}`, full ? 0 : 120_000, async () => {
          const sid = await currentShiftId();
          return { id: sid, required: Boolean((await getShiftConfig()).required), brief: await shiftBrief(sid) };
        });
        const report = brief && full ? await shiftReport(id) : null;
        let current = brief;
        if (report) current = staff.can.has('reports.view') || staff.can.has('shift.close') ? report : { ...brief, ops: report.ops, cashIn: report.cashIn, cashOut: report.cashOut };
        return json({ current, required, history: !full || !staff.can.has('reports.view') ? [] : await listShifts(20) });
      }
      if (route === '/api/kassa/shift/open' && method === 'POST') {
        need(staff, 'shift.open');
        return json({ shift: await openShift(actor, await readJson(request)) });
      }
      if (route === '/api/kassa/shift/cash' && method === 'POST') {
        need(staff, 'shift.cash');
        return json({ shift: await cashOp(actor, await readJson(request)) });
      }
      if (route === '/api/kassa/shift/close' && method === 'POST') {
        need(staff, 'shift.close');
        const b = await readJson(request);
        const shift = await closeShift(actor, b);
        const print = b.print === false ? null : await printDoc('shift', shift, actor, { request, staff }).catch((e) => ({ printed: false, reason: e.message }));
        return json({ shift, print });
      }
      if (parts[3] === 'shift' && parts[4] && !['open', 'cash', 'close'].includes(parts[4])) {
        need(staff, 'reports.view');
        const shift = await shiftReport(parts[4]);
        if (parts[5] === 'print' && method === 'POST') return json({ print: await printDoc('shift', shift, actor, { request, staff }) });
        if (!parts[5] && method === 'GET') return json({ shift });
      }

      if (parts[3] === 'tabs' && parts[4]) {
        const b = method === 'POST' ? await readJson(request) : {};
        if (parts[5] === 'merge' && method === 'POST') {
          need(staff, 'tab.merge');
          return json({ tab: await mergeTabs(parts[4], String(b.sourceId || '')) });
        }
        if (parts[5] === 'split' && method === 'POST') {
          need(staff, 'tab.split');
          return json(await splitTab(parts[4], actor, b));
        }
        if (parts[5] === 'service' && method === 'POST') {
          need(staff, 'tab.service');
          return json({ tab: await setTabService(parts[4], b.pct) });
        }
        if (parts[5] === 'discount' && method === 'POST') {
          need(staff, 'tab.discount');
          return json({ tab: await setTabDiscount(parts[4], b, actor) });
        }
        if (parts[5] === 'move' && method === 'POST') {
          need(staff, 'tab.move');
          return json(await moveTabToTable(parts[4], b.tableId, actor));
        }
        if (parts[5] === 'cancel' && method === 'POST') {
          need(staff, 'tab.cancel');
          rateLimit(`tabcancel:${staff.id}`, 20, 60_000);
          return json(await cancelTab(parts[4], actor, { reason: b.reason }));
        }
        if (parts[5] === 'close' && method === 'POST') {
          need(staff, 'tab.pay');
          if (b.payment?.debt) need(staff, 'tab.debt');
          const tab = await closeTab(parts[4], actor, { payment: b.payment || { method: 'naqd' } });
          // To'lov cheki asosiy printerdan o'zi chiqadi
          const print = b.print === false ? null : await printPaid(tab, actor, { request, staff }).catch((e) => ({ printed: false, reason: e.message }));
          return json({ tab, print });
        }
        if (parts[5] === 'waiter' && method === 'POST') {
          need(staff, 'tab.waiter');
          const w = (await listStaff()).find((s) => `tg:${s.id}` === String(b.staffId));
          if (!w) throw new AppError(404, 'Xodim topilmadi.');
          return json({ tab: await setTabWaiter(parts[4], { id: `tg:${w.id}`, name: w.name || w.phone }) });
        }
        if (!parts[5] && method === 'GET') return json({ tab: await getTabForStaff(parts[4]) });
      }
      if (parts[3] === 'orders' && parts[4]) {
        const b = method === 'POST' ? await readJson(request) : {};
        if (parts[5] === 'accept' && method === 'POST') {
          need(staff, 'order.accept');
          return json({ order: await acceptOrder(parts[4], {}, actor) });
        }
        if (parts[5] === 'reject' && method === 'POST') {
          need(staff, 'order.accept');
          return json({ order: await rejectOrder(parts[4], b.reason, actor) });
        }
        if (parts[5] === 'delivered' && method === 'POST') {
          need(staff, 'delivery.manage');
          return json({ order: await markDelivered(parts[4], actor) });
        }
        // Yetkazish: to'lov (kerak bo'lsa qabul ham) → kassa printeridan "TO'LANDI" cheki
        if (parts[5] === 'pay' && method === 'POST') {
          need(staff, 'tab.pay');
          need(staff, 'delivery.manage');
          if (b.accept !== false) need(staff, 'order.accept');
          if (b.payment?.debt) need(staff, 'tab.debt');
          const order = await payOrder(parts[4], actor, b.payment);
          const print = b.print === false ? null : await printDoc('paidorder', order, actor, { request, staff }).catch((e) => ({ printed: false, reason: e.message }));
          return json({ order, print });
        }
        if (parts[5] === 'void' && method === 'POST') {
          need(staff, 'order.void');
          rateLimit(`void:${staff.id}`, 60, 60_000);
          return json(await voidOrderItem(parts[4], actor, b));
        }
        if (parts[5] === 'cancel' && method === 'POST') {
          need(staff, 'order.cancel');
          rateLimit(`cancel:${staff.id}`, 30, 60_000);
          return json(await cancelStaffOrder(parts[4], actor, { reason: b.reason, causeId: b.causeId }));
        }
        if (!parts[5] && method === 'GET') return json({ order: await getOrderForStaff(parts[4]) });
      }
      // Mison'dagi bekor qilish sabablari (Mison kabinetida sozlanadi; bo'sh bo'lishi mumkin)
      if (route === '/api/kassa/mison/cancel-causes' && method === 'GET') {
        const cfg = await getConfig();
        if (!posConfigured(cfg)) return json({ items: [] });
        return json({ items: await listCancelCauses(cfg).catch(() => []) });
      }
    }

    if (parts[2] === 'kuryer') {
      const staff = await requireStaffAccess(request, ['page.kuryer']);
      const actor = actorOf(staff);
      await touchDevice(request, staff, ip);
      if (route === '/api/kuryer/orders' && method === 'GET') {
        const [all, live] = await Promise.all([pk(url).then((p) => cached(`deliveries|${p}`, ttlFor(p), () => listDeliveries({ days: 1 }))), pulseInfo()]);
        return json({ items: all.filter((o) => o.status === 'qabul' && (o.deliveryStatus !== 'yolda' || o.courierId === actor.id) && (o.deliveryStatus !== 'yetkazildi' || o.courierId === actor.id)), me: actor.id, perms: [...staff.can], pulse: live });
      }
      if (parts[3] === 'orders' && parts[5] === 'take' && method === 'POST') {
        need(staff, 'delivery.take');
        return json({ order: await takeDelivery(parts[4], actor) });
      }
      if (parts[3] === 'orders' && parts[5] === 'delivered' && method === 'POST') {
        need(staff, 'delivery.take');
        return json({ order: await markDelivered(parts[4], actor) });
      }
      if (parts[3] === 'orders' && parts[4] && parts.length === 5 && method === 'GET') return json({ order: await getOrderForStaff(parts[4]) });
    }

    /* ───────── Ombor (omborchi) ───────── */
    if (parts[2] === 'ombor') {
      const staff = await requireStaffAccess(request, ['page.ombor']);
      const actor = actorOf(staff);
      await touchDevice(request, staff, ip);
      const body = ['POST', 'PUT'].includes(method) ? await readJson(request, 200_000) : null;
      if (route === '/api/ombor/data' && method === 'GET') return json({ products: await listProducts(), suppliers: await listSuppliers(), units: UNITS, today: stockToday(), perms: [...staff.can] });
      if (route === '/api/ombor/in' && method === 'POST') {
        need(staff, 'stock.receive');
        return json({ move: await addReceipt(actor, body) });
      }
      if (route === '/api/ombor/moves' && method === 'GET') {
        needAny(staff, ['stock.receive', 'stock.reports']);
        return json({ items: await listMoves({ days: url.searchParams.get('days') }) });
      }
      if (parts[3] === 'moves' && parts[4] && method === 'DELETE') {
        need(staff, 'stock.receive');
        return json(await deleteMove(parts[4], actor));
      }
      if (route === '/api/ombor/report' && method === 'GET') {
        needAny(staff, ['stock.count', 'stock.reports']);
        return json({ report: await stockReport(url.searchParams.get('day')) });
      }
      if (route === '/api/ombor/count' && method === 'POST') {
        need(staff, 'stock.count');
        return json({ report: await saveCount(actor, body) });
      }
      if (parts[3] === 'products' && method === 'POST' && !parts[4]) {
        need(staff, 'stock.products');
        return json({ item: await saveProduct('', body) });
      }
      if (parts[3] === 'products' && parts[4] && method === 'PUT') {
        need(staff, 'stock.products');
        return json({ item: await saveProduct(parts[4], body) });
      }
      if (parts[3] === 'suppliers' && method === 'POST' && !parts[4]) {
        need(staff, 'stock.suppliers');
        return json({ item: await saveSupplier('', body) });
      }
      if (parts[3] === 'suppliers' && parts[4] && method === 'PUT') {
        need(staff, 'stock.suppliers');
        return json({ item: await saveSupplier(parts[4], body) });
      }
    }

    if (route === '/api/health' && method === 'GET') {
      const cfg = await getConfig();
      return json({ pos: posConfigured(cfg), groq: groqConfigured(cfg), telegram: telegramConfigured(cfg), firebase: Boolean(await getDb()), demo: envBool('DEMO_MODE') });
    }

    return json({ error: 'Topilmadi' }, 404);
  } catch (e) {
    return errorResponse(e, route);
  }
}
