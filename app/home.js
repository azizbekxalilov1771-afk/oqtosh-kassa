'use strict';
/* global OqDesktop */
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'className') n.className = v;
    else if (k === 'textContent') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== '') n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'hozirgina';
  if (s < 3600) return `${Math.round(s / 60)} daq oldin`;
  return new Date(ms).toLocaleString('ru-RU');
};
const time = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let status = { paired: false };

// asosiy kompyuter / ofitsiant terminali
function paintMode(main) {
  for (const b of document.querySelectorAll('[data-main]')) b.hidden = !main;
  $('#mode-note').hidden = main;
}
// yangilanish holati
const UPD = { checking: 'Yangilanish tekshirilmoqda…', latest: '', downloading: 'Yangi versiya yuklanmoqda', ready: 'Yangi versiya tayyor', error: '' };
function paintUpdate(u) {
  if (!u) return;
  const text = u.status === 'downloading' ? `${UPD.downloading} ${u.version || ''}${u.percent ? ` · ${u.percent}%` : ''}` : u.status === 'ready' ? `${UPD.ready}: ${u.version}` : UPD[u.status] || '';
  $('#update').hidden = !text;
  $('#update').classList.toggle('is-ready', u.status === 'ready');
  $('#update-text').textContent = text;
  $('#update-btn').hidden = u.status !== 'ready';
}

for (const b of document.querySelectorAll('[data-open]')) {
  b.addEventListener('click', () => OqDesktop.open(b.dataset.open, b.dataset.hash || ''));
}

function paint() {
  const s = status;
  const pill = $('#pr-pill');
  $('#pair').hidden = Boolean(s.paired && !s.keyBad);
  $('#paired').hidden = !s.paired || s.keyBad;
  if (!s.paired || s.keyBad) {
    pill.textContent = s.keyBad ? 'qayta ulash kerak' : 'ulanmagan';
    pill.className = 'pill warn';
    if (s.keyBad) {
      $('#pair-err').textContent = s.error || 'Kalit eskirgan — yangi kod bilan qayta ulang.';
      $('#pair-err').hidden = false;
    }
    return;
  }
  pill.textContent = s.online ? (s.ring ? 'ishlayapti · darhol' : 'ishlayapti') : s.running ? 'internet yo‘q' : 'to‘xtagan';
  pill.className = `pill ${s.online ? 'ok' : 'warn'}`;
  $('#facts').replaceChildren(
    el('dt', {}, 'Sayt'), el('dd', {}, s.site || '—'),
    el('dt', {}, 'Qo‘ng‘iroq'), el('dd', {}, s.ring ? 'ulangan — cheklar 1 soniyada' : 'yo‘q — har 15 soniyada tekshiriladi'),
    el('dt', {}, 'Chiqqan cheklar'), el('dd', {}, `${s.printed || 0} ta${s.lastJobAt ? ` · oxirgisi ${ago(s.lastJobAt)}` : ''}`),
    el('dt', {}, 'Oxirgi qidiruv'), el('dd', {}, s.scanning ? 'qidirilmoqda…' : ago(s.lastScanAt)),
    s.error ? el('dt', {}, 'Xato') : '', s.error ? el('dd', { className: 'err-text' }, s.error) : '');
  const list = s.printers || [];
  $('#printers').replaceChildren(...(list.length ? list.map((p) => el('li', {},
    el('span', { className: 'ico', 'aria-hidden': 'true' }, p.type === 'win' ? '🔌' : '📶'),
    el('span', { className: 'pname' }, p.type === 'win' ? p.name : `${p.ip}:${p.port}`, p.model ? el('small', { className: 'muted' }, ` · ${p.model}`) : '', p.mac ? el('small', { className: 'muted' }, ` · ${p.mac.replace(/(..)(?!$)/g, '$1:')}`) : ''),
    el('button', { type: 'button', className: 'btn ghost small', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await OqDesktop.testLocal(p);
        b.textContent = '✓ yuborildi';
      } catch (err) {
        b.textContent = 'xato';
        b.title = err.message;
      } finally {
        setTimeout(() => {
          b.disabled = false;
          b.textContent = 'Sinov';
        }, 2500);
      }
    } }, 'Sinov'))) : [el('li', { className: 'muted' }, s.scanning ? 'Qidirilmoqda…' : 'Printer topilmadi. Printer yoqilganini va shu Wi‑Fi tarmoqda ekanini tekshiring.')]));
}

function addLog(l) {
  const ol = $('#log');
  ol.prepend(el('li', { className: `k-${l.kind || 'info'}` }, el('time', {}, time(l.at)), ' ', l.text));
  while (ol.children.length > 120) ol.lastChild.remove();
}

async function init() {
  const st = await OqDesktop.state();
  $('#ver').textContent = `versiya ${st.version} · printer moduli ${st.agentVersion} · ${st.main ? 'asosiy kompyuter' : 'ofitsiant terminali'}`;
  paintMode(st.main);
  paintUpdate(st.update);
  status = st.status || { paired: false };
  for (const l of st.logs || []) addLog(l);
  paint();
  const f = $('#settings');
  f.site.value = st.settings.site;
  f.admin.value = st.settings.admin;
  f.startWith.value = st.settings.startWith || 'home';
  f.autostart.checked = Boolean(st.settings.autostart);
  f.fullscreen.checked = st.settings.fullscreen !== false;
  f.htmlPrinter.replaceChildren(el('option', { value: '' }, 'Windows’dagi asosiy printer'), ...st.printers.map((p) => el('option', { value: p.name }, `${p.name}${p.isDefault ? ' (asosiy)' : ''}`)));
  f.htmlPrinter.value = st.settings.htmlPrinter || '';
  paintServer(st.server);
  for (const l of st.server?.logs || []) addLog({ ...l, text: `[server] ${l.text}` });
}

OqDesktop.onStatus((s) => {
  status = s;
  paint();
});
OqDesktop.onLog(addLog);
OqDesktop.onMode((m) => {
  paintMode(m.main);
  OqDesktop.state().then((st) => ($('#ver').textContent = `versiya ${st.version} · printer moduli ${st.agentVersion} · ${st.main ? 'asosiy kompyuter' : 'ofitsiant terminali'}`));
});
OqDesktop.onUpdate(paintUpdate);
$('#update-btn').addEventListener('click', () => OqDesktop.installUpdate());
$('#check-upd').addEventListener('click', () => OqDesktop.checkUpdates());

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#pair-err');
  err.hidden = true;
  const b = e.currentTarget.querySelector('button');
  b.disabled = true;
  b.textContent = 'Ulanmoqda…';
  try {
    await OqDesktop.pair($('#pair-code').value);
    $('#pair-code').value = '';
  } catch (x) {
    err.textContent = String(x.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    err.hidden = false;
  } finally {
    b.disabled = false;
    b.textContent = 'Ulash';
  }
});
$('#pair-code').addEventListener('input', (e) => {
  const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  e.target.value = v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
});
$('#scan').addEventListener('click', () => OqDesktop.scan());
$('#unpair').addEventListener('click', () => {
  if (confirm('Printer dasturi uzilsinmi? Shu kompyuterdan cheklar chiqmay qoladi.')) OqDesktop.unpair();
});
$('#test-html').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  await OqDesktop.setSettings({ htmlPrinter: $('#settings').htmlPrinter.value });
  const r = await OqDesktop.testHtml();
  b.textContent = r.ok ? '✓ chiqdi' : 'xato';
  b.title = r.error || '';
  setTimeout(() => (b.textContent = 'Sinov'), 2500);
});
$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const err = $('#set-err');
  err.hidden = true;
  try {
    await OqDesktop.setSettings({ site: f.site.value, admin: f.admin.value, htmlPrinter: f.htmlPrinter.value, startWith: f.startWith.value, autostart: f.autostart.checked, fullscreen: f.fullscreen.checked });
    $('#saved').hidden = false;
    setTimeout(() => ($('#saved').hidden = true), 2500);
  } catch (x) {
    err.textContent = String(x.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    err.hidden = false;
  }
});

/* ───────── server kompyuteri ───────── */
let srv = null;
const errText = (x) => String(x?.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function srvMsg(text, ok = false) {
  $('#srv-err').hidden = ok || !text;
  $('#srv-ok').hidden = !ok || !text;
  (ok ? $('#srv-ok') : $('#srv-err')).textContent = text || '';
}
async function srvRun(btn, fn, okText = '') {
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  srvMsg('');
  try {
    const r = await fn();
    if (okText) srvMsg(typeof okText === 'function' ? okText(r) : okText, true);
    return r;
  } catch (x) {
    srvMsg(errText(x));
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}
const PHASE = {
  none: 'Firebase’dan ko‘chirish kutilmoqda — sayt hozircha “texnik ishlar” sahifasini ko‘rsatadi.',
  essential: 'Firebase’dan ko‘chirilmoqda (sozlamalar, menyu, xodimlar, stollar)…',
  history: 'Asosiy ma’lumotlar ko‘chdi — sayt ishlayapti. Eski buyurtmalar tarixi ko‘chirilmoqda…',
  done: 'Firebase’dan ko‘chirish tugagan.',
  fresh: 'Bo‘sh bazadan boshlangan (ko‘chirishsiz).',
};
function paintServer(s) {
  if (!s) return;
  srv = s;
  const on = s.enabled;
  const st = s.status || {};
  const mig = s.migration || st.migration || { phase: 'none' };
  $('#srv-off').hidden = on;
  $('#srv-onbox').hidden = !on;
  $('#srv-keys').textContent = s.keys?.ok ? `✓ yuklangan (Firebase loyihasi: ${s.keys.project}, ${s.keys.count} ta qiymat)` : 'yuklanmagan — oqtosh-restoran papkasidagi .env yoki netlify-kalitlar.env fayli kerak';
  $('#srv-keys').className = s.keys?.ok ? 'ok-inline' : 'err-text';
  $('#srv-on').disabled = !s.keys?.ok;
  const pill = $('#srv-pill');
  if (!on) {
    pill.textContent = 'o‘chiq';
    pill.className = 'pill';
  } else if (!s.running) {
    pill.textContent = s.starting ? 'ishga tushmoqda…' : 'to‘xtagan';
    pill.className = 'pill warn';
  } else if (!st.ready) {
    pill.textContent = 'texnik ishlar';
    pill.className = 'pill warn';
  } else {
    pill.textContent = s.tunnel?.state === 'on' ? 'ishlayapti · internetda' : 'ishlayapti · faqat shu kompyuterda';
    pill.className = `pill ${s.tunnel?.state === 'on' ? 'ok' : 'warn'}`;
  }
  if (!on) return;
  const t = s.tunnel || {};
  const tunnelText = !s.tunnelReady ? 'ulanmagan — pastdagi “Cloudflare’ga ulash”' : t.state === 'on' ? `ulangan (${t.connections} kanal)` : t.state === 'error' ? `xato: ${t.error}` : 'ulanmoqda…';
  const b = st.backups || {};
  const db = st.db || {};
  const link = (what, url) => el('button', { type: 'button', className: 'btn-link', onclick: () => OqDesktop.server.open(what) }, url);
  $('#srv-facts').replaceChildren(
    el('dt', {}, 'Holat'), el('dd', {}, s.running ? `${st.ready ? 'tayyor' : 'texnik ishlar (ko‘chirish kutilmoqda)'} · ${st.requests || 0} so‘rov${st.errors ? ` · ${st.errors} xato` : ''}` : s.error || 'to‘xtagan'),
    el('dt', {}, 'Internet'), el('dd', { className: t.state === 'error' ? 'err-text' : '' }, tunnelText),
    el('dt', {}, 'Manzillar'), el('dd', {}, link('site', s.urls.site), ' · ', link('admin', s.urls.admin)),
    el('dt', {}, 'Ma’lumotlar'), el('dd', {}, db.docs !== undefined ? `${db.docs} ta yozuv · ${Object.keys(db.collections || {}).length} bo‘lim` : '—'),
    el('dt', {}, 'Zaxira'), el('dd', {}, `${b.lastLocalAtMs ? `oxirgisi ${ago(b.lastLocalAtMs)} (${kb(b.lastLocalSize || 0)})` : 'hali yo‘q'} · Telegram: ${b.lastTelegramAtMs ? ago(b.lastTelegramAtMs) : b.lastTelegramError ? `xato — ${b.lastTelegramError}` : 'hali yo‘q'}`),
    el('dt', {}, 'Papka'), el('dd', {}, s.backupDir || ''),
    s.error ? el('dt', {}, 'Xato') : '', s.error ? el('dd', { className: 'err-text' }, s.error) : '');
  // ko'chirish bosqichi
  const showMig = s.running && mig.phase !== 'done' && mig.phase !== 'fresh';
  $('#srv-mig').hidden = !showMig;
  if (showMig) {
    const extra = mig.lastError ? ` ${mig.lastError}` : mig.col ? ` (${mig.col}: ${mig.docs || 0} ta)` : mig.docs ? ` (${mig.docs} ta)` : '';
    $('#srv-mig-text').textContent = `${PHASE[mig.phase] || ''}${extra}`;
    $('#srv-fresh').hidden = mig.phase !== 'none';
  }
  $('#srv-cf').hidden = Boolean(s.tunnelReady);
  if (!$('#srv-domain').value) $('#srv-domain').value = s.domain || '';
  $('#srv-cf-login').hidden = !t.login;
}
$('#srv-keys-find').addEventListener('click', (e) => srvRun(e.currentTarget, async () => {
  const files = await OqDesktop.server.findKeys();
  if (!files.length) throw new Error('Kompyuterda oqtosh-restoran papkasi (.env) topilmadi — “Faylni tanlash…” bilan ko‘rsating.');
  await OqDesktop.server.importKeys(files);
  paintServer(await OqDesktop.server.state());
  return files;
}, (files) => `Kalitlar yuklandi: ${files.join(', ')}`));
for (const id of ['#srv-keys-pick', '#srv-keys-again']) {
  $(id).addEventListener('click', (e) => srvRun(e.currentTarget, async () => {
    await OqDesktop.server.importKeys([]);
    paintServer(await OqDesktop.server.state());
  }));
}
$('#srv-on').addEventListener('click', (e) => srvRun(e.currentTarget, async () => paintServer(await OqDesktop.server.enable(true)), 'Server ishga tushirildi.'));
$('#srv-offbtn').addEventListener('click', (e) => {
  if (!confirm('Server o‘chirilsinmi? Sayt va admin panel bu kompyuterdan ishlamay qoladi (ma’lumotlar o‘chmaydi).')) return;
  srvRun(e.currentTarget, async () => paintServer(await OqDesktop.server.enable(false)), 'Server o‘chirildi.');
});
$('#srv-migrate').addEventListener('click', (e) => srvRun(e.currentTarget, () => OqDesktop.server.migrate(), (r) => (r?.lastError ? r.lastError : `Ko‘chirildi: ${r?.docs || 0} ta yozuv.`)));
$('#srv-fresh').addEventListener('click', (e) => {
  if (!confirm('Firebase’dagi ma’lumotlarsiz, bo‘sh bazadan boshlansinmi? (Xodimlar, menyu sozlamalari, tarix — hammasi qaytadan kiritiladi.) Odatda bu kerak emas — “Firebase’dan ko‘chirish”ni kuting.')) return;
  srvRun(e.currentTarget, () => OqDesktop.server.fresh(), 'Bo‘sh baza bilan ishga tushdi.');
});
$('#srv-cf-form').addEventListener('submit', (e) => {
  e.preventDefault();
  srvRun(e.currentTarget.querySelector('button'), () => OqDesktop.server.tunnel($('#srv-domain').value), 'Cloudflare ulandi — bir necha daqiqada sayt internetda ochiladi.');
});
$('#srv-cf-link').addEventListener('click', () => srv?.tunnel?.login && window.open(srv.tunnel.login, '_blank'));
$('#srv-backup').addEventListener('click', (e) => srvRun(e.currentTarget, () => OqDesktop.server.backup(), (r) => `Zaxira saqlandi: ${r.file}`));
$('#srv-backup-tg').addEventListener('click', (e) => srvRun(e.currentTarget, () => OqDesktop.server.backupTelegram(), 'Zaxira Telegram’ga yuborildi (admin chati).'));
$('#srv-restore').addEventListener('click', (e) => srvRun(e.currentTarget, () => OqDesktop.server.restore(), (r) => (r ? `Tiklandi: ${r.docs} ta yozuv (${new Date(r.at).toLocaleString('ru-RU')}).` : '')));
$('#srv-open-bk').addEventListener('click', () => OqDesktop.server.open('backups'));
$('#srv-open-log').addEventListener('click', () => OqDesktop.server.open('log'));
OqDesktop.server.onState(paintServer);
OqDesktop.server.onLog((l) => addLog({ ...l, text: `[server] ${l.text}` }));

setInterval(paint, 30_000);
init();
