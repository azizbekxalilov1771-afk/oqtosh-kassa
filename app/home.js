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

setInterval(paint, 30_000);
init();
