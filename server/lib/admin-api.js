import { env, AppError } from './env.js';
import { invalidateLocal } from './pulse.js';
import { forgetCustomerCache } from './session.js';
import { json, readJson, rateLimit, errorResponse } from './http.js';
import { getDb, firebaseConfigured } from './firebase.js';
import { verifyAdmin, verifyUser, firebaseVerify, adminEmails } from './auth.js';
import { setupPin, pinLoginAdmin, isPinSession, verifyPinSession, forgetPin, listPinDevices, revokePinDevice } from './adminpin.js';
import { getConfig, getConfigForAdmin, saveIntegrations, configWithOverrides } from './config.js';
import { posConfigured, fetchPosRaw, normalizeMenu, listPoints, listMenus, listPaymentTypes, defaultPaymentType, pointAlive, listTables } from './pos.js';
import { lastMisonEvent } from './mison-events.js';
import { getTables, publicTables, clearTablesMemory } from './tables.js';
import { resetMisonLive } from './mison-live.js';
import { getServiceConfig, saveServiceConfig } from './tabs.js';
import { getDeliverySettings, saveDeliverySettings, deliveryOrigin } from './delivery.js';
import { getMenuConfig, saveMenuConfig } from './menuconfig.js';
import { getMenu, clearMenuMemory } from './menu.js';
import { askAssistant, groqConfigured } from './assistant.js';
import { telegramConfigured, sendTelegram, findAllChats, getBotInfo, getWebhookInfo, setWebhook, deleteWebhook, loginBot } from './telegram.js';
import { listOrdersForAdmin, acceptOrder, rejectOrder, retryMison, countPendingOrders, STATUSES as ORDER_STATUSES } from './orders.js';
import { listStaff, setRoleByPhone, setRoleById, countCustomers, renameCustomer } from './customers.js';
import { listGuests, clearGuestHistory, deleteGuest, clearAllHistory } from './guests.js';
import { listDevicesForAdmin, savePrinting, renameDevice, deleteDevice, testPrint, brandOf, getPrinting } from './printing.js';
import { kitchenForAdmin, saveKitchen, getKitchen, printKitchen } from './kitchen.js';
import { agentStatus, askScan, listPrinters, addManualPrinter, updatePrinter, deletePrinter, testPrinter, newAgentKey, revokeAgent, recentAgentJobs, newPairCode } from './agent.js';
import { setupRing, disableRing, ringStatus } from './doorbell.js';
import { buildAgentScript, AGENT_VERSION } from './agent-script.js';
import { ownerReport, ownerExtras } from './owner.js';
import { listOwners, addOwner, setOwnerPassword, removeOwner, verifyOwner } from './owners.js';
import { getReceipt, saveReceipt, normalizeReceipt, misonComment, RECEIPT_DEFAULT, getReceiptMedia, saveReceiptMedia, billFmt } from './receipt-settings.js';
import { kitchenTicket, billTicket } from './escpos.js';
import { workplaceForAdmin, saveWorkplace, addNetwork, removeNetwork, setStaffPassword, clearStaffPassword, createPasswordStaff } from './workplace.js';
import { getRestaurantForAdmin, saveRestaurantInfo, getRestaurantInfo } from './info.js';
import { getSections, saveSections, BUILTIN } from './layout.js';
import { listNewsAdmin, createNews, updateNews, deleteNews } from './news.js';
import { listComplaints, updateComplaint, countNewComplaints, STATUSES } from './complaint.js';
import { saveImage, serveMedia, withLocalImages } from './media.js';
import { runBackup, backupStatus } from './backup.js';
import { PERMS, ROLE_DEFAULTS, getRolePerms, saveRolePerms, saveStaffPerms } from './perms.js';
import { getPayments, savePayments } from './payments.js';
import { UNITS, stockToday, listProducts, listSuppliers, saveProduct, saveSupplier, listMoves, deleteMove, stockReport } from './stock.js';
import { getShiftConfig, saveShiftConfig, listShifts, shiftReport, currentShiftId } from './shifts.js';
import { getOwnMenu, getOwnTables, importFromMison, saveItem, deleteItem, setAvailable, saveCategories, saveTables, clearOwnMemory } from './ownpos.js';

// Admin sayt API'si (/admin-api/*). /admin-api/config dan boshqa hamma yo'l kirishni talab qiladi.

function publicFirebaseConfig() {
  const projectId = env('FIREBASE_PROJECT_ID');
  return {
    apiKey: env('FIREBASE_WEB_API_KEY'),
    authDomain: env('FIREBASE_AUTH_DOMAIN', projectId ? `${projectId}.firebaseapp.com` : ''),
    projectId,
    ready: Boolean(env('FIREBASE_WEB_API_KEY') && projectId && firebaseConfigured()),
  };
}

async function logAction(email, action, detail = '') {
  const db = await getDb();
  if (!db) return;
  await db.collection('admin_log').add({ email, action, detail: String(detail).slice(0, 300), at: new Date() }).catch(() => {});
}

// Test tugmalari xatoni foydalanuvchiga ko'rsatadi (kalit noto'g'ri, manzil topilmadi...)
const testError = (e) => new AppError(400, e.expose ? e.message : `Ulanmadi: ${e.message}`);

export function createAdminApi({ verifier } = {}) {
  const inner = createAdminApiInner({ verifier });
  // admin biror narsani o'zgartirsa — shu nusxadagi qisqa keshlar (xodim hujjati, stollar…) eskirgan hisoblanadi
  return async function handleAdminApi(request, opts) {
    const res = await inner(request, opts);
    if (request.method !== 'GET' && res.status < 400) {
      invalidateLocal();
      forgetCustomerCache();
    }
    return res;
  };
}

function createAdminApiInner({ verifier: base = firebaseVerify } = {}) {
  // PIN sessiyasi (oqa1.…) yoki Firebase ID token
  const verifier = (token) => (isPinSession(token) ? verifyPinSession(token) : base(token));
  return async function handleAdminApiInner(request, { ip = 'unknown' } = {}) {
    const url = new URL(request.url);
    const { pathname } = url;
    const route = pathname.replace(/\/+$/, '');
    const method = request.method;

    try {
      if (route.startsWith('/api/media/') && method === 'GET') return serveMedia(route.split('/').pop());
      if (route === '/admin-api/config' && method === 'GET') return json(publicFirebaseConfig());
      if (!route.startsWith('/admin-api/')) return json({ error: 'Topilmadi' }, 404);

      rateLimit(`admin:${ip}`, 180, 60_000);
      // ── PIN bilan kirish (admin va egasi, faqat avval email bilan kirilgan qurilmada) ──
      if (route === '/admin-api/pin/login' && method === 'POST') {
        rateLimit(`admin-pin:${ip}`, 12, 5 * 60_000);
        return json(await pinLoginAdmin(await readJson(request)));
      }
      if (route === '/admin-api/pin/forget' && method === 'POST') return json(await forgetPin(await readJson(request)));
      if (route === '/admin-api/pin/setup' && method === 'POST') {
        rateLimit(`admin-pin-set:${ip}`, 10, 10 * 60_000);
        const user = await verifyUser(request, verifier);
        if (user.pin) throw new AppError(403, 'PIN’ni o‘zgartirish uchun email bilan kiring.');
        if (!user.email_verified) throw new AppError(403, 'Email tasdiqlanmagan.');
        const b = await readJson(request);
        return json(await setupPin(user, { pin: b?.pin, label: b?.label, ua: request.headers.get('user-agent') || '' }));
      }
      // ── kim kirdi: admin yoki egasi (egasi panelda faqat hisobotlarni ko'radi) ──
      if (route === '/admin-api/me' && method === 'GET') {
        const user = await verifyUser(request, verifier);
        const email = String(user.email || '').toLowerCase();
        if (!adminEmails().includes(email)) {
          const owner = await verifyOwner(request, verifier).catch(() => null);
          if (owner) return json({ email: owner.email, role: 'owner', pin: Boolean(user.pin), publicSiteUrl: env('PUBLIC_SITE_URL') });
        }
      }
      // ── Owner sahifasi (faqat hisobotlar): admin yoki "Owner kirishi"dagi email ──
      if (route.startsWith('/admin-api/owner/')) {
        const owner = await verifyOwner(request, verifier);
        if (route === '/admin-api/owner/me' && method === 'GET') return json({ email: owner.email, admin: owner.admin });
        if (route === '/admin-api/owner/report' && method === 'GET') {
          rateLimit(`owner:${owner.email}`, 40, 60_000);
          return json(await ownerReport(Object.fromEntries(url.searchParams)));
        }
        // AI tahlil: raqamlarni server hisoblaydi, AI faqat izoh yozadi (lib/insights.js)
        if (route === '/admin-api/owner/insights' && method === 'GET') {
          const fresh = url.searchParams.get('fresh') === '1';
          rateLimit(`owner-ai:${owner.email}`, fresh ? 6 : 30, 10 * 60_000);
          const { ownerInsights } = await import('./insights.js');
          return json(await ownerInsights(Object.fromEntries(url.searchParams), { fresh }));
        }
        if (route === '/admin-api/owner/extra' && method === 'GET') {
          rateLimit(`owner-x:${owner.email}`, 30, 60_000);
          return json(await ownerExtras(Object.fromEntries(url.searchParams)));
        }
        return json({ error: 'Topilmadi' }, 404);
      }
      const admin = await verifyAdmin(request, verifier);
      const path = route.slice('/admin-api'.length);
      const [, section, itemId] = path.split('/');
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(request, section === 'media' ? 1_400_000 : 200_000) : null;
      const done = async (action, detail, data) => {
        await logAction(admin.email, action, detail);
        return json(data ?? { ok: true });
      };

      // ── umumiy ──
      if (path === '/me' && method === 'GET') return json({ email: admin.email, role: 'admin', publicSiteUrl: env('PUBLIC_SITE_URL') });
      if (path === '/pin-devices' && method === 'GET') return json({ items: await listPinDevices() });
      if (section === 'pin-devices' && itemId && method === 'DELETE') return done('pin.revoke', itemId, await revokePinDevice(itemId));

      if (path === '/overview' && method === 'GET') {
        const cfg = await getConfig();
        const [menu, newComplaints, db, pendingOrders, customers] = await Promise.all([getMenu(), countNewComplaints(), getDb(), countPendingOrders(), countCustomers()]);
        return json({
          firebase: Boolean(db),
          integrations: { pos: posConfigured(cfg), groq: groqConfigured(cfg), telegram: telegramConfigured(cfg) },
          menu: { source: menu.source, count: menu.items.length, updatedAt: menu.updatedAt, posError: menu.posError || '' },
          newComplaints,
          pendingOrders,
          customers,
          loginReady: Boolean(loginBot(cfg).telegramBotToken),
          publicSiteUrl: env('PUBLIC_SITE_URL'),
        });
      }

      // ── kalitlar va ulanishlar ──
      if (path === '/integrations' && method === 'GET') return json(await getConfigForAdmin());
      if (path === '/integrations' && method === 'PUT') {
        const changed = await saveIntegrations(body);
        if (changed.some((k) => /^mison|posMode/.test(k))) await resetMisonLive();
        return done('integrations.save', changed.join(','), await getConfigForAdmin());
      }

      if (path === '/test/pos' && method === 'POST') {
        const cfg = await configWithOverrides(body);
        try {
          const [points, menus] = await Promise.all([listPoints(cfg), listMenus(cfg).catch(() => [])]);
          const pointId = cfg.misonPointId || points[0]?.id || '';
          const [raw, paymentTypes, shift, tables] = await Promise.all([
            fetchPosRaw(cfg),
            pointId ? listPaymentTypes(cfg, pointId).catch(() => []) : [],
            pointId ? pointAlive(cfg, pointId).catch(() => null) : null,
            pointId ? listTables(cfg, pointId).catch((e) => ({ error: e.status === 403 ? 'kalitda "Бронирование столов" ruxsati yo‘q' : e.message })) : [],
          ]);
          const menu = normalizeMenu(raw, cfg);
          const withOptions = menu.items.filter((i) => i.options?.length);
          return json({
            count: menu.items.length, categories: menu.categories, sample: menu.items.slice(0, 8),
            stopped: menu.items.filter((i) => !i.available).length,
            limited: menu.items.filter((i) => i.left > 0).length,
            withOptions: withOptions.length,
            requiredOptions: withOptions.filter((i) => i.options.some((g) => g.required)).map((i) => i.name).slice(0, 12),
            withWeight: menu.items.filter((i) => i.weight).length,
            withNutrition: menu.items.filter((i) => i.nutrition).length,
            withImage: menu.items.filter((i) => i.image).length,
            tables: Array.isArray(tables) ? { count: tables.length, sample: tables.slice(0, 12) } : tables,
            points, pointId, menus, menuId: cfg.misonMenuId || '',
            paymentTypes, paymentTypeId: Number(cfg.misonPaymentTypeId) || defaultPaymentType(paymentTypes)?.id || null,
            shift, ordersOn: cfg.misonOrders !== 'off',
            raw: JSON.stringify(raw, null, 2).slice(0, 3000),
          });
        } catch (e) {
          throw testError(e);
        }
      }
      if (path === '/test/groq' && method === 'POST') {
        const cfg = await configWithOverrides(body);
        try {
          return json({ reply: await askAssistant([{ role: 'user', content: String(body.question || 'Qanday taomlaringiz bor?').slice(0, 300) }], cfg) });
        } catch (e) {
          throw testError(e);
        }
      }
      if (path === '/test/telegram' && method === 'POST') {
        const cfg = await configWithOverrides(body);
        try {
          return json(await sendTelegram(cfg, '✅ Sinov xabari: sayt shikoyatlari shu chatga keladi.'));
        } catch (e) {
          throw testError(e);
        }
      }
      if (path === '/mison/webhook' && method === 'GET') {
        const site = env('PUBLIC_SITE_URL').replace(/\/+$/, '');
        const cfg = await getConfig();
        // Manzil haqiqatan yangi saytga ochiladimi (domen eski loyihada qolib ketmaganmi)
        let fresh = null;
        if (/^https:\/\//.test(site)) {
          try {
            const r = await fetch(`${site}/api/delivery`, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
            fresh = r.ok && /json/.test(r.headers.get('content-type') || '');
          } catch {
            fresh = false;
          }
        }
        return json({ url: site ? `${site}/api/mison/webhook` : '', https: /^https:\/\//.test(site), fresh, secretSet: Boolean(cfg.misonWebhookSecret), last: await lastMisonEvent() });
      }
      if (path === '/tables' && method === 'GET') {
        const t = await getTables({ force: url.searchParams.get('fresh') === '1' });
        return json({ ...publicTables(t), error: t.error || '', updatedAt: t.atMs ? new Date(t.atMs).toISOString() : '', siteUrl: env('PUBLIC_SITE_URL').replace(/\/+$/, '') });
      }
      if (path === '/tables/config' && method === 'GET') return json(await getServiceConfig());
      if (path === '/tables/config' && method === 'PUT') return done('tables.service', '', await saveServiceConfig(body));
      if (path === '/delivery' && method === 'GET') return json({ ...(await getDeliverySettings()), originFound: Boolean(await deliveryOrigin()) });
      if (path === '/delivery' && method === 'PUT') {
        const r = await saveDeliverySettings(body);
        return done('delivery.save', r.enabled ? 'on' : 'off', r);
      }
      if (path === '/menu/items' && method === 'GET') {
        const [menu, conf] = await Promise.all([getMenu(), getMenuConfig()]);
        return json({ items: menu.items.map(({ id, name, price, category, weight, perKg, byWeight }) => ({ id, name, price, category, weight: weight || '', perKg: Boolean(perKg), byWeight: byWeight || null })), config: conf });
      }
      // Stolga qo'yiladigan bosma menyu: Mison menyusi + restoran ma'lumoti + stollar (QR uchun)
      if (path === '/menu/print' && method === 'GET') {
        const [menu, info, svc, t] = await Promise.all([getMenu(), getRestaurantInfo(), getServiceConfig(), getTables().catch(() => null)]);
        const variants = (i) => {
          const g = (i.options || []).find((x) => x.required && x.max === 1 && x.items.length >= 2);
          return g ? g.items.slice(0, 5).map((m) => ({ name: m.name, price: i.price + (m.price || 0) })) : [];
        };
        const loc = (info.locations || [])[0] || {};
        return json({
          items: menu.items.map((i) => ({
            id: i.id, name: i.name, price: i.price, category: i.category, weight: i.weight || '', kg: Boolean(i.perKg || i.byWeight),
            image: i.image || '', available: i.available !== false, description: i.description || '', variants: variants(i),
          })),
          categories: menu.categories || [], categoryImages: menu.categoryImages || {},
          restaurant: { name: info.name || 'Restoran', tagline: info.tagline || '', logo: info.logo || '', phone: info.phone || loc.phone || '', address: loc.address || '', instagram: info.instagram || '', telegram: info.telegram || '' },
          servicePct: Number(svc?.defaultPct) || 0,
          halls: t ? publicTables(t).halls.map((h) => ({ name: h.name, tables: h.tables.map((x) => ({ id: x.id, label: x.label })) })) : [],
          siteUrl: env('PUBLIC_SITE_URL').replace(/\/+$/, ''),
          updatedAt: menu.updatedAt, source: menu.source, posError: menu.posError || '',
        });
      }
      if (path === '/menu/config' && method === 'PUT') {
        const r = await saveMenuConfig(body);
        clearMenuMemory();
        return done('menu.config', '', r);
      }
      if (path === '/mison/points' && method === 'POST') {
        try {
          return json({ points: await listPoints(await configWithOverrides(body)) });
        } catch (e) {
          throw testError(e);
        }
      }
      if (path === '/telegram/chats' && method === 'POST') {
        try {
          return json({ chats: await findAllChats(await configWithOverrides(body)) });
        } catch (e) {
          throw testError(e);
        }
      }
      if (path === '/menu/refresh' && method === 'POST') {
        clearMenuMemory();
        const menu = await getMenu({ force: true });
        return done('menu.refresh', menu.source, { source: menu.source, count: menu.items.length, updatedAt: menu.updatedAt, posError: menu.posError || '' });
      }

      // ── restoran ma'lumotlari (manzillar ham shu yerda) ──
      if (path === '/restaurant' && method === 'GET') return json(await getRestaurantForAdmin());
      if (path === '/restaurant' && method === 'PUT') return done('restaurant.save', '', await saveRestaurantInfo(body));

      // ── bo'limlar ──
      if (path === '/sections' && method === 'GET') return json({ sections: await getSections(), builtin: BUILTIN });
      if (path === '/sections' && method === 'PUT') {
        const sections = await saveSections(body.sections);
        return done('sections.save', `${sections.length} ta`, { sections, builtin: BUILTIN });
      }

      // ── yangiliklar ──
      if (section === 'news' && !itemId && method === 'GET') return json({ items: await listNewsAdmin() });
      if (section === 'news' && !itemId && method === 'POST') {
        const item = await createNews(body);
        return done('news.create', item.title, item);
      }
      if (section === 'news' && itemId && method === 'PUT') {
        const item = await updateNews(itemId, body);
        return done('news.update', item.title, item);
      }
      if (section === 'news' && itemId && method === 'DELETE') {
        await deleteNews(itemId);
        return done('news.delete', itemId);
      }

      // ── shikoyatlar ──
      if (section === 'complaints' && !itemId && method === 'GET') return json({ items: await listComplaints(), statuses: STATUSES });
      if (section === 'complaints' && itemId && method === 'PATCH') {
        const r = await updateComplaint(itemId, body, admin.email);
        return done('complaint.update', `${itemId} ${r.status || ''}`, r);
      }

      // ── Telegram bot: holat va webhook ──
      if (path === '/telegram/info' && method === 'GET') {
        const cfg = loginBot(await getConfig()); // webhook verifikatsiya botida
        const site = env('PUBLIC_SITE_URL').replace(/\/+$/, '');
        const out = { configured: Boolean(cfg.telegramBotToken), expectedUrl: site ? `${site}/api/telegram/webhook` : '', canSet: /^https:\/\//.test(site) };
        if (!cfg.telegramBotToken) return json(out);
        try {
          const [bot, hook] = await Promise.all([getBotInfo(cfg), getWebhookInfo(cfg)]);
          return json({
            ...out, bot: { username: bot.username, name: bot.first_name },
            webhook: { url: hook.url || '', pending: hook.pending_update_count || 0, lastError: hook.last_error_message || '', lastErrorAt: hook.last_error_date ? new Date(hook.last_error_date * 1000).toISOString() : '' },
          });
        } catch (e) {
          return json({ ...out, error: e.message });
        }
      }
      if (path === '/telegram/webhook' && method === 'POST') {
        const cfg = loginBot(await getConfig());
        if (!cfg.telegramBotToken) throw new AppError(400, 'Avval bot tokenini kiriting va saqlang.');
        try {
          if (body.action === 'delete') {
            await deleteWebhook(cfg);
            return done('telegram.webhook.delete', '', { ok: true });
          }
          const site = env('PUBLIC_SITE_URL');
          if (!/^https:\/\//.test(site)) throw new AppError(400, 'Admin saytda PUBLIC_SITE_URL https:// bilan boshlanadigan haqiqiy sayt manzili bo‘lishi kerak.');
          const hookUrl = await setWebhook(cfg, site);
          // bot pastidagi "🍽 Menyu" — Telegram ichida buyurtma (mini-ilova)
          const { setMenuButton } = await import('./webapp.js');
          const miniApp = await setMenuButton(cfg, site).catch(() => false);
          return done('telegram.webhook.set', hookUrl, { ok: true, url: hookUrl, miniApp });
        } catch (e) {
          throw e.expose ? e : testError(e);
        }
      }

      // ── buyurtmalar ──
      if (section === 'orders' && !itemId && method === 'GET') return json({ items: await listOrdersForAdmin(), statuses: ORDER_STATUSES });
      if (section === 'orders' && itemId) {
        const actor = { id: `admin:${admin.email}`, name: `Admin (${admin.email})`, admin: true };
        const action = path.split('/')[3];
        if (action === 'accept' && method === 'POST') {
          const o = await acceptOrder(itemId, {}, actor);
          return done('order.accept', `#${o.number}`, { order: o });
        }
        if (action === 'reject' && method === 'POST') {
          const o = await rejectOrder(itemId, body.reason, actor);
          return done('order.reject', `#${o.number}`, { order: o });
        }
        if (action === 'mison' && method === 'POST') {
          const o = await retryMison(itemId);
          return done('order.mison', `#${o.number} → ${o.misonOrderId}`, { order: o });
        }
      }

      // ── mehmonlar: soni, tarixi, tozalash ──
      if (section === 'guests' && !itemId && method === 'GET') return json(await listGuests());
      if (path === '/guests/clear' && method === 'POST') {
        if (body?.confirm !== 'TOZALASH') throw new AppError(400, 'Tasdiqlash uchun TOZALASH deb yozing.');
        const r = await clearAllHistory({ guests: Boolean(body.guests) });
        return done('guests.clear', `${r.orders} buyurtma, ${r.tabs} hisob, ${r.guests} mehmon`, r);
      }
      if (section === 'guests' && itemId && itemId !== 'clear') {
        const action = path.split('/')[3];
        if (action === 'history' && method === 'DELETE') {
          const r = await clearGuestHistory(itemId);
          return done('guest.history', `${itemId}: ${r.orders} buyurtma`, r);
        }
        if (!action && method === 'DELETE') {
          const r = await deleteGuest(itemId);
          return done('guest.delete', itemId, r);
        }
      }

      // ── Misonsiz ishlash: zaxira, rejim, o'z menyumiz va stollarimiz ──
      const ownChanged = () => {
        clearOwnMemory();
        clearMenuMemory();
        clearTablesMemory();
      };
      if (path === '/zaxira' && method === 'GET') return json(await backupStatus());
      if (path === '/zaxira/run' && method === 'POST') return json(await runBackup({ budgetMs: 7000, force: Boolean(body?.force) }));
      if (path === '/pos-mode' && method === 'PUT') {
        const mode = body?.mode === 'own' ? 'own' : 'mison';
        if (mode === 'own') {
          const [m, t] = await Promise.all([getOwnMenu(), getOwnTables()]);
          if (!m?.items?.length) await importFromMison({ menu: true, tables: !t?.halls?.length });
          else if (!t?.halls?.length) await importFromMison({ menu: false, tables: true }).catch(() => {});
        }
        await saveIntegrations({ posMode: mode });
        ownChanged();
        return done('pos.mode', mode, await backupStatus());
      }
      if (path === '/own/import' && method === 'POST') {
        const r = await importFromMison({ menu: body?.menu !== false, tables: body?.tables !== false });
        ownChanged();
        return done('own.import', JSON.stringify(r), r);
      }
      if (path === '/own/menu' && method === 'GET') {
        const m = await getOwnMenu();
        return json({ menu: m ? await withLocalImages(m) : null, status: await backupStatus() });
      }
      if (path.startsWith('/own/items/')) {
        const [, , , id, sub] = path.split('/');
        if (sub === 'available' && method === 'PUT') {
          const r = await setAvailable(id, body?.available);
          ownChanged();
          return done('own.available', `${id}=${Boolean(body?.available)}`, r);
        }
        if (!sub && method === 'PUT') {
          const r = await saveItem(id, body || {});
          ownChanged();
          return done(id === 'new' ? 'own.item.add' : 'own.item.save', `${r.id} ${r.name}`, { item: r });
        }
        if (!sub && method === 'DELETE') {
          const r = await deleteItem(id);
          ownChanged();
          return done('own.item.delete', id, r);
        }
      }
      if (path === '/own/categories' && method === 'PUT') {
        const r = await saveCategories(body || {});
        ownChanged();
        return done('own.categories', '', r);
      }
      if (path === '/own/tables' && method === 'GET') return json({ own: await getOwnTables(), current: await getTables() });
      if (path === '/own/tables' && method === 'PUT') {
        const r = await saveTables(body?.halls);
        ownChanged();
        return done('own.tables', `${r.halls.length} zal`, r);
      }

      // ── qurilmalar va chek printeri ──
      if (section === 'devices' && !itemId && method === 'GET') return json(await listDevicesForAdmin());
      if (path === '/printing' && method === 'PUT') {
        const r = await savePrinting(body || {});
        return done('printing.save', `printer=${r.stationId || '—'} ${r.paper}mm`, { printing: r });
      }
      if (path === '/printing/test' && method === 'POST') return done('printing.test', '', await testPrint(admin.email));
      if (section === 'devices' && itemId) {
        if (method === 'PUT') return done('device.rename', itemId, await renameDevice(itemId, body?.name));
        if (method === 'DELETE') return done('device.delete', itemId, await deleteDevice(itemId));
      }

      // ── Owner kirishi (hisobotlar sahifasi) ──
      if (path === '/owners' && method === 'GET') return json({ items: await listOwners() });
      if (path === '/owners' && method === 'POST') {
        const r = await addOwner(body || {});
        return done('owner.add', r.email, { ...r, items: await listOwners() });
      }
      if (section === 'owners' && itemId && method === 'PUT') return done('owner.password', decodeURIComponent(itemId), await setOwnerPassword(decodeURIComponent(itemId), body?.password));
      if (section === 'owners' && itemId && method === 'DELETE') return done('owner.remove', decodeURIComponent(itemId), await removeOwner(decodeURIComponent(itemId)));

      // ── chek ko'rinishi (oshxona, kassa, Mison izohi) ──
      if (path === '/receipt' && method === 'GET') {
        const [receipt, printing, media] = await Promise.all([getReceipt(), getPrinting(), getReceiptMedia()]);
        return json({ receipt, media, defaults: RECEIPT_DEFAULT, footer: printing.footer || '', paper: printing.paper || 80 });
      }
      if (path === '/receipt/media' && method === 'PUT') return done('receipt.media', '', { media: await saveReceiptMedia(body) });
      if (path === '/receipt' && method === 'PUT') return done('receipt.save', '', { receipt: await saveReceipt(body) });
      if (path === '/receipt/preview' && method === 'POST') {
        const r = normalizeReceipt(body?.receipt || {});
        const width = Number(body?.paper) === 58 ? 32 : 48;
        const menu = await getMenu().catch(() => ({ items: [] }));
        const pickItem = (n, fb) => {
          const it = menu.items?.[n];
          return it ? { id: String(it.id), name: it.name, price: it.price || 0 } : fb;
        };
        const a = pickItem(0, { id: '1', name: 'Toshkent oshi', price: 45000 });
        const b = pickItem(3, { id: '2', name: 'Sezar salati', price: 38000 });
        const c = pickItem(6, { id: '3', name: 'Ko‘k choy', price: 8000 });
        const items = [
          { ...a, qty: 2, sum: a.price * 2, mods: [{ name: 'Qo‘shimcha go‘sht', qty: 1 }] },
          { ...b, qty: 1, sum: b.price, mods: [] },
          { ...c, qty: 3, sum: c.price * 3, mods: [] },
        ];
        const now = Date.now();
        const order = { number: 27, mode: 'table', table: '8', tableHall: 'Asosiy zal', tableLabel: 'Asosiy zal · Stol 8', acceptedByName: 'Sardor', acceptedAtMs: now, items, comment: 'Achchiqsiz, tezroq', byStaff: true, createdByName: 'Sardor', total: items.reduce((x, i) => x + i.sum, 0) };
        const subtotal = order.total;
        const tab = { kind: 'table', tableLabel: 'Asosiy zal · Stol 8', waiterName: 'Sardor', rounds: [{ status: 'qabul', takeaway: false, items }], subtotal, servicePct: 10, service: Math.round(subtotal * 0.1), total: Math.round(subtotal * 1.1), takeaway: 0, payment: { method: 'naqd', label: 'Naqd', received: Math.ceil(subtotal * 1.1 / 10000) * 10000, change: Math.ceil(subtotal * 1.1 / 10000) * 10000 - Math.round(subtotal * 1.1) } };
        const brand = await brandOf();
        const footer = (await getPrinting()).footer || '';
        const kind = ['kitchen', 'tab', 'paid'].includes(body?.kind) ? body.kind : 'kitchen';
        const lines = kind === 'kitchen'
          ? kitchenTicket({ station: 'ISSIQ OVQAT', order, items, width, beep: false, fmt: r.kitchen, preview: true })
          : billTicket({ kind, data: tab, brand, footer, width, number: 'A7K2', byName: 'Malika', fmt: await billFmt(r), preview: true });
        return json({ lines, width, misonComment: misonComment(order, { tableFound: true, opts: r.mison }), misonCommentNoTable: misonComment(order, { tableFound: false, opts: r.mison }) });
      }

      // ── tayyorlash joylari (oshxona printerlari) va printer dasturi ──
      if (path === '/kitchen' && method === 'GET') {
        const [kitchen, printers, agent, ring, jobs, cfg] = await Promise.all([kitchenForAdmin(), listPrinters(), agentStatus(), ringStatus(), recentAgentJobs(20), getConfig()]);
        return json({ kitchen, printers, agent, ring, jobs, posMode: cfg.posMode || 'mison', misonOn: posConfigured(cfg), agentVersion: AGENT_VERSION, projectId: env('FIREBASE_PROJECT_ID'), siteUrl: env('PUBLIC_SITE_URL').replace(/\/+$/, '') });
      }
      if (path === '/kitchen' && method === 'PUT') {
        const r = await saveKitchen(body || {});
        return done('kitchen.save', `enabled=${r.enabled} stations=${r.stations.length} kassa=${r.kassaPrinterId || '—'}`, { kitchen: r });
      }
      // Har bir tayyorlash joyiga sinov cheki (shu bo'limning 2 ta taomi bilan)
      if (path === '/kitchen/test' && method === 'POST') {
        const k = await getKitchen();
        const menu = await getMenu().catch(() => ({ items: [] }));
        const sample = [];
        for (const st of (k.stations || []).filter((x) => x.on !== false && x.printerId)) {
          const its = menu.items.filter((i) => st.items?.includes(String(i.id)) || st.categories?.includes(i.category)).slice(0, 2);
          sample.push(...(its.length ? its : []).map((i) => ({ id: String(i.id), name: i.name, qty: 1, sum: i.price })));
        }
        if (!sample.length) throw new AppError(409, 'Printer tanlangan tayyorlash joyi yo‘q (yoki ularga taom bog‘lanmagan).');
        const fake = { number: 0, mode: 'table', tableLabel: 'SINOV', items: sample, comment: 'Bu sinov cheki - tayyorlamang', acceptedByName: 'Admin', acceptedAtMs: Date.now() };
        const r = await printKitchen(fake, '__test__', { force: true });
        if (r.error) throw new AppError(503, r.error);
        return done('kitchen.test', (r.stations || []).join(', '), r);
      }
      if (path === '/print-agent/download' && method === 'POST') {
        const site = env('PUBLIC_SITE_URL').replace(/\/+$/, '');
        if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(site)) throw new AppError(400, 'Admin saytda PUBLIC_SITE_URL to‘g‘ri yozilmagan (masalan https://oqtoshrestoran.uz).');
        const key = await newAgentKey();
        return done('agent.download', '', { filename: 'oqtosh-printer.cmd', content: buildAgentScript({ site, key }) });
      }
      if (path === '/print-agent/revoke' && method === 'POST') return done('agent.revoke', '', await revokeAgent());
      if (path === '/print-agent/pair' && method === 'POST') return done('agent.pair', '', await newPairCode());
      if (path === '/print-agent/scan' && method === 'POST') return json(await askScan());
      if (path === '/ring/setup' && method === 'POST') return done('ring.setup', body?.url || '', await setupRing(body?.url || ''));
      if (path === '/ring/off' && method === 'POST') return done('ring.off', '', await disableRing());
      if (path === '/ring' && method === 'GET') return json(await ringStatus());
      if (section === 'printers' && !itemId && method === 'POST') return done('printer.add', body?.ip || '', await addManualPrinter(body || {}));
      if (section === 'printers' && itemId && path.split('/')[3] === 'test' && method === 'POST') {
        const k = await getKitchen();
        const names = [...(k.stations || []).filter((x) => x.printerId === itemId).map((x) => x.name), ...(k.kassaPrinterId === itemId ? ['Kassa'] : [])];
        return json(await testPrinter(itemId, { brand: await brandOf(), footer: (await getPrinting()).footer || '', station: names.join(', ') }));
      }
      if (section === 'printers' && itemId && !path.split('/')[3]) {
        if (method === 'PUT') return done('printer.update', itemId, await updatePrinter(itemId, body || {}));
        if (method === 'DELETE') return done('printer.delete', itemId, await deletePrinter(itemId));
      }

      // ── xodimlar (ofitsiantlar) ──
      if (section === 'staff' && !itemId && method === 'GET') return json({ items: await listStaff(), customers: await countCustomers() });
      // Xodim qo'shish: ism + lavozim (+ ixtiyoriy telefon) → darhol yagona 4 xonali PIN (raqam bilan hisob bo'lsa — o'sha xodim qilinadi)
      if (section === 'staff' && !itemId && method === 'POST') {
        const role = ['waiter', 'cashier', 'courier', 'storekeeper'].includes(body.role) ? body.role : 'waiter';
        if (body.noPin) {
          const s = await setRoleByPhone(body.phone, role);
          return done('staff.add', `${s.phone} ${role}`, { item: s });
        }
        const r = await createPasswordStaff({ phone: body.phone, name: body.name, role, pin: body.pin });
        return done('staff.create', `${r.item.name}${r.item.phone ? ` ${r.item.phone}` : ''} ${role} (PIN)`, r);
      }
      if (section === 'staff' && itemId && path.split('/')[3] === 'perms' && method === 'PUT') {
        return done('staff.perms', itemId, await saveStaffPerms(itemId, body?.perms));
      }
      if (section === 'staff' && itemId && path.split('/')[3] === 'name' && method === 'PUT') {
        return done('staff.name', itemId, { name: await renameCustomer(itemId, body?.name) });
      }
      if (section === 'staff' && itemId && path.split('/')[3] === 'role' && method === 'PUT') {
        const role = ['waiter', 'cashier', 'courier', 'storekeeper'].includes(body?.role) ? body.role : '';
        if (!role) throw new AppError(400, 'Lavozimni tanlang.');
        return done('staff.role', `${itemId} ${role}`, { item: await setRoleById(itemId, role) });
      }
      // Ruxsatlar: lavozim bo'yicha
      if (path === '/permissions' && method === 'GET') return json({ groups: PERMS, roles: await getRolePerms(), defaults: ROLE_DEFAULTS });
      if (path === '/permissions' && method === 'PUT') return done('permissions.save', '', { roles: await saveRolePerms(body) });
      // To'lov turlari va smena qoidasi
      if (path === '/payments' && method === 'GET') return json({ methods: await getPayments(), shift: await getShiftConfig() });
      if (path === '/payments' && method === 'PUT') {
        const out = {};
        if (body?.methods) out.methods = await savePayments(body);
        if (body?.shift) out.shift = await saveShiftConfig(body.shift);
        return done('payments.save', Object.keys(out).join(','), { methods: await getPayments(), shift: await getShiftConfig() });
      }
      // Ombor: mahsulotlar, ta'minotchilar, hisobot
      if (path === '/stock' && method === 'GET') return json({ products: await listProducts({ all: true }), suppliers: await listSuppliers({ all: true }), units: UNITS, today: stockToday() });
      if (path === '/stock/products' && method === 'POST') return done('stock.product', body?.name || '', { item: await saveProduct('', body) });
      if (path.startsWith('/stock/products/') && method === 'PUT') return done('stock.product', path.split('/')[3], { item: await saveProduct(path.split('/')[3], body) });
      if (path === '/stock/suppliers' && method === 'POST') return done('stock.supplier', body?.name || '', { item: await saveSupplier('', body) });
      if (path.startsWith('/stock/suppliers/') && method === 'PUT') return done('stock.supplier', path.split('/')[3], { item: await saveSupplier(path.split('/')[3], body) });
      if (path === '/stock/report' && method === 'GET') return json({ report: await stockReport(url.searchParams.get('day')) });
      if (path === '/stock/moves' && method === 'GET') return json({ items: await listMoves({ days: url.searchParams.get('days') || 30 }) });
      if (path.startsWith('/stock/moves/') && method === 'DELETE') return done('stock.move.delete', path.split('/')[3], await deleteMove(path.split('/')[3], { name: 'Admin' }, { admin: true }));
      if (path === '/shifts' && method === 'GET') return json({ items: await listShifts(30), current: await currentShiftId() });
      if (section === 'shifts' && itemId && method === 'GET') return json({ shift: await shiftReport(itemId) });
      if (section === 'staff' && itemId && path.split('/')[3] === 'password') {
        if (method === 'POST') {
          const r = await setStaffPassword(itemId, body?.password);
          return done('staff.password', itemId, r);
        }
        if (method === 'DELETE') return done('staff.password.clear', itemId, await clearStaffPassword(itemId));
      }

      // ── ishxona tarmog'i (parol bilan kirish faqat shu yerdan) ──
      if (path === '/workplace' && method === 'GET') return json(await workplaceForAdmin(ip));
      if (path === '/workplace' && method === 'PUT') return done('workplace.save', `enabled=${Boolean(body?.enabled)}`, await saveWorkplace(body || {}, ip));
      if (path === '/workplace/networks' && method === 'POST') {
        const r = await addNetwork(body || {}, ip);
        return done('workplace.add', body?.ip || ip, r);
      }
      if (path.startsWith('/workplace/networks/') && method === 'DELETE') {
        const net = path.slice('/workplace/networks/'.length);
        return done('workplace.remove', net, await removeNetwork(net, ip));
      }
      if (section === 'staff' && itemId && method === 'DELETE') {
        const s = await setRoleById(itemId, 'customer');
        return done('staff.remove', s.phone, { item: s });
      }

      // ── rasm yuklash ──
      if (path === '/media' && method === 'POST') {
        const r = await saveImage(body.dataUrl);
        return done('media.upload', r.id, r);
      }

      return json({ error: 'Topilmadi' }, 404);
    } catch (e) {
      return errorResponse(e, route);
    }
  };
}
