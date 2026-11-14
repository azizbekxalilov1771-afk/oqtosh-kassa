import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, saveBar, fmtDateTime } from '../ui.js';

// Tayyorlash joylari: Salat, Issiq ovqat, Somsa, Shashlik... — har bo'lim cheki o'z printeridan.
// Printerlarni kassa kompyuteridagi "Oqtosh printer" dasturi Wi‑Fi tarmoqdan o'zi topadi.

const SKIP = '__skip';
const JOB = { new: 'navbatda', retry: 'qayta urinilmoqda', done: '✓ chiqdi', error: 'chiqmadi', expired: 'chiqmadi (vaqti o‘tdi)' };
const KIND = { kitchen: 'Oshxona', tab: 'Hisob', paid: 'To‘lov', order: 'Buyurtma', test: 'Sinov' };

const ago = (iso) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'hozirgina';
  if (m < 60) return `${m} daq oldin`;
  if (m < 24 * 60) return `${Math.round(m / 60)} soat oldin`;
  return fmtDateTime(iso);
};
const rid = () => `st${Math.random().toString(16).slice(2, 8)}`;

export async function render(root) {
  let data = await api('/kitchen');
  const k = data.kitchen;
  const cats = data.kitchen.menu.categories;
  const menuItems = data.kitchen.menu.items;
  const knownCats = new Set(cats);
  const knownItems = new Set(menuItems.map((i) => i.id));

  // ── tahrir holati ──
  const st = {
    enabled: Boolean(k.enabled),
    stations: k.stations.map((s) => ({ ...s })),
    otherStationId: k.otherStationId || '',
    kassaPrinterId: k.kassaPrinterId || '',
    sources: { qr: k.sources?.qr !== false, staff: k.sources?.staff !== false, delivery: k.sources?.delivery !== false },
    catMap: {},
    itemMap: {},
  };
  for (const c of cats) st.catMap[c] = '';
  for (const c of k.skip?.categories || []) if (knownCats.has(c)) st.catMap[c] = SKIP;
  for (const s of st.stations) for (const c of s.categories || []) if (knownCats.has(c) && !st.catMap[c]) st.catMap[c] = s.id;
  for (const i of k.skip?.items || []) if (knownItems.has(i)) st.itemMap[i] = SKIP;
  for (const s of st.stations) for (const i of s.items || []) if (knownItems.has(i)) st.itemMap[i] = s.id;

  const form = el('div', { className: 'kitchen-form' });
  const bar = saveBar(form, save);

  /* ───────── 1. Printer dasturi ───────── */
  const agentBox = el('div', { className: 'printer-status' });
  function paintAgent() {
    const a = data.agent;
    const status = !a.installed
      ? el('div', { className: 'printer-card is-off' }, el('span', { className: 'printer-icon', textContent: '🖥' }),
        el('div', {}, el('strong', { textContent: 'Dastur hali o‘rnatilmagan' }),
          el('p', { className: 'muted', textContent: 'Kassa kompyuterida (Windows 10/11) shu sahifani oching va dasturni yuklab oling.' })))
      : el('div', { className: `printer-card ${a.online ? 'is-on' : 'is-off'}` }, el('span', { className: 'printer-icon', textContent: '🖥' }),
        el('div', {},
          el('strong', { textContent: a.online ? `Ishlayapti${a.host ? ` · ${a.host}` : ''}` : a.lastSeenAt ? `Oflayn${a.host ? ` · ${a.host}` : ''}` : 'Yuklab olindi, hali ishga tushirilmagan' }),
          el('p', { className: 'muted' }, el('span', { className: `dot ${a.online ? 'is-on' : ''}`, style: 'margin:0 6px 0 0' }),
            [a.lastSeenAt && `oxirgi aloqa: ${ago(a.lastSeenAt)}`, a.ips?.length && `IP: ${a.ips.join(', ')}`, a.version && `v${a.version}`, a.scanAt && `qidiruv: ${ago(a.scanAt)}`].filter(Boolean).join(' · ') || 'faylni kompyuterda ishga tushiring'),
          a.version && a.version !== data.agentVersion ? el('p', { className: 'small warn-text', textContent: `Yangi versiya bor (${data.agentVersion}) — dasturni qayta yuklab, ishga tushiring.` }) : '',
          a.installed && !a.online && a.lastSeenAt ? el('p', { className: 'small warn-text', textContent: 'Kompyuter o‘chiq yoki internet yo‘q. Cheklar navbatda turadi: oshxona cheki 20 daqiqa, kassa cheki 30 daqiqa ichida chiqadi.' }) : '',
          a.installed && a.online && !a.winRaw ? el('p', { className: 'small warn-text', textContent: 'USB printerlar moduli ishlamadi — faqat Wi‑Fi/LAN printerlar ishlaydi.' }) : ''));
    const download = btn(a.installed ? '⬇ Dasturni qayta yuklab olish' : '⬇ Dasturni yuklab olish', (e) => {
      if (a.installed && !confirm('Yangi fayl yuklansa, eski fayl ishlashdan to‘xtaydi — kassa kompyuterida yangisini ishga tushirish kerak bo‘ladi. Davom etasizmi?')) return;
      busy(e.currentTarget, 'Tayyorlanmoqda…', async () => {
        try {
          const r = await api('/print-agent/download', { method: 'POST', body: {} });
          const url = URL.createObjectURL(new Blob([r.content], { type: 'application/octet-stream' }));
          const link = el('a', { href: url, download: r.filename });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
          toast('Fayl yuklandi. Uni kassa kompyuterida ikki marta bosib ishga tushiring.');
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    const scan = a.online ? btn(a.scanning ? 'Qidirilmoqda…' : '🔎 Printerlarni qidirish', (e) => busy(e.currentTarget, 'Qidirilmoqda…', async () => {
      try {
        await api('/print-agent/scan', { method: 'POST', body: {} });
        toast('Dastur tarmoqni tekshiryapti — 10–30 soniyada yangilanadi.');
        await waitScan();
      } catch (err) {
        toast(err.message, 'error');
      }
    }), 'btn-ghost') : '';
    if (scan && a.scanning) scan.disabled = true;
    const revoke = a.installed ? btn('O‘chirish', (e) => {
      if (!confirm('Printer dasturining kaliti bekor qilinsinmi? Kompyuterdagi dastur ishlashdan to‘xtaydi.')) return;
      busy(e.currentTarget, '…', async () => {
        try {
          await api('/print-agent/revoke', { method: 'POST', body: {} });
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }, 'btn-text btn-small danger') : '';
    const pairBox = el('div', { className: 'pair-box', hidden: true });
    const pair = btn('🖥 Oqtosh Kassa dasturini ulash', (e) => busy(e.currentTarget, '…', async () => {
      try {
        const r = await api('/print-agent/pair', { method: 'POST', body: {} });
        pairBox.replaceChildren(
          el('p', { className: 'muted small', textContent: 'Kompyuterdagi “Oqtosh Kassa” dasturida: Printerlar → Ulash — shu kodni kiriting (10 daqiqa amal qiladi):' }),
          el('strong', { className: 'pair-code', textContent: r.code }));
        pairBox.hidden = false;
      } catch (err) {
        toast(err.message, 'error');
      }
    }), 'btn-ghost');
    agentBox.replaceChildren(status, el('div', { className: 'row wrap align-center' }, download, pair, scan, revoke), pairBox);
  }

  async function waitScan() {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, i < 3 ? 4000 : 3000));
      data = await api('/kitchen');
      if (!data.agent.scanning) break;
    }
    paintAgent();
    paintPrinters();
    paintStations();
    paintKassa();
    if (data.agent.scanning) toast('Dastur hali javob bermadi. Kompyuterda dastur oynasi ochiqligini tekshiring.', 'error');
    else toast(`Topildi: ${data.printers.filter((p) => p.found).length} ta printer.`);
  }

  async function reload() {
    data = await api('/kitchen');
    paintAgent();
    paintPrinters();
    paintStations();
    paintKassa();
    paintRing();
    paintJobs();
  }

  /* ───────── 2. Printerlar ───────── */
  const printerList = el('ul', { className: 'item-list printer-list' });
  const usage = (id) => [...st.stations.filter((s) => s.printerId === id).map((s) => s.name), ...(st.kassaPrinterId === id ? ['Kassa'] : [])];
  function paintPrinters() {
    const ps = data.printers;
    printerList.replaceChildren(...(ps.length ? ps.map((p) => {
      const used = usage(p.id);
      const paper = el('select', { className: 'mini-select', ariaLabel: 'Qog‘oz eni' },
        el('option', { value: '80', textContent: '80 mm' }), el('option', { value: '58', textContent: '58 mm' }));
      paper.value = String(p.paper);
      paper.addEventListener('change', async (e) => {
        e.stopPropagation();
        try {
          await api(`/printers/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { paper: Number(paper.value) } });
          p.paper = Number(paper.value);
          toast('Qog‘oz eni saqlandi.');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      paper.addEventListener('input', (e) => e.stopPropagation());
      const details = p.type === 'win'
        ? [`Windows printer${p.winHost ? ` · ${p.winHost}` : ''}`, p.driver]
        : [`${p.ip}${p.port !== 9100 ? `:${p.port}` : ''}`, p.mac && `MAC ${p.mac.replace(/(..)(?!$)/g, '$1:')}`, p.model, p.manual && 'qo‘lda qo‘shilgan'];
      return el('li', { className: `item device-item${used.length ? ' is-station' : ''}` },
        el('span', { className: 'device-kind', textContent: p.type === 'win' ? '🔌' : '📶', ariaHidden: 'true' }),
        el('div', { className: 'item-main' },
          el('h3', {}, p.name, ...used.map((u) => el('span', { className: 'role-badge is-cashier', textContent: u })),
            el('span', { className: `dot ${p.found ? 'is-on' : ''}`, title: p.found ? 'Tarmoqda topildi' : 'Oxirgi qidiruvda topilmadi' })),
          el('p', { className: 'muted', textContent: details.filter(Boolean).join(' · ') }),
          el('p', { className: 'small muted', textContent: [p.found ? 'tarmoqda topildi' : `oxirgi qidiruvda topilmadi${p.lastSeenAt ? ` (ko‘rilgan: ${ago(p.lastSeenAt)})` : ''}`, p.lastPrintAt && `oxirgi chek: ${ago(p.lastPrintAt)}`].filter(Boolean).join(' · ') }),
          p.lastError ? el('p', { className: 'small warn-text', textContent: `Xato: ${p.lastError} (${ago(p.lastErrorAt)})` }) : ''),
        el('div', { className: 'item-actions' },
          btn('🖨 Sinov', (e) => busy(e.currentTarget, '…', async () => {
            try {
              const r = await api(`/printers/${encodeURIComponent(p.id)}/test`, { method: 'POST', body: {} });
              toast(r.online ? 'Sinov cheki yuborildi — printerdan nomi chiqadi.' : 'Yuborildi, lekin dastur oflayn — kompyuter yoqilganda chiqadi.');
              setTimeout(() => api('/kitchen').then((d) => { data = d; paintPrinters(); paintJobs(); }).catch(() => {}), 6000);
            } catch (err) {
              toast(err.message, 'error');
            }
          }), 'btn-small'),
          paper,
          btn('Nomi', async (e) => {
            const name = prompt('Printer nomi (masalan: Salat printeri, Kassa):', p.label || '');
            if (name === null) return;
            busy(e.currentTarget, '…', async () => {
              try {
                await api(`/printers/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { label: name } });
                await reload();
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          }, 'btn-ghost btn-small'),
          btn('O‘chirish', (e) => {
            if (!confirm(`${p.name} ro‘yxatdan o‘chirilsinmi?${used.length ? ` U ${used.join(', ')} uchun tanlangan.` : ''} Keyingi qidiruvda tarmoqda bo‘lsa, qaytadan paydo bo‘ladi.`)) return;
            busy(e.currentTarget, '…', async () => {
              try {
                await api(`/printers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
                for (const s of st.stations) if (s.printerId === p.id) s.printerId = '';
                if (st.kassaPrinterId === p.id) st.kassaPrinterId = '';
                await reload();
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          }, 'btn-text btn-small danger')));
    }) : [el('li', { className: 'empty', textContent: data.agent.online ? 'Printer topilmadi. Printer yoqilganini va kassa kompyuteri bilan bitta Wi‑Fi tarmoqda ekanini tekshiring, keyin “Printerlarni qidirish”ni bosing.' : 'Printerlar dastur ishga tushgandan keyin shu yerda paydo bo‘ladi.' })]));
  }

  const ipInput = el('input', { placeholder: '192.168.1.100', inputMode: 'decimal', maxLength: 15, ariaLabel: 'Printer IP manzili' });
  const portInput = el('input', { value: '9100', inputMode: 'numeric', maxLength: 5, className: 'port-input', ariaLabel: 'Port' });
  for (const i of [ipInput, portInput]) i.addEventListener('input', (e) => e.stopPropagation());
  const addIp = btn('Qo‘shish', (e) => busy(e.currentTarget, '…', async () => {
    try {
      await api('/printers', { method: 'POST', body: { ip: ipInput.value.trim(), port: Number(portInput.value) || 9100 } });
      ipInput.value = '';
      toast('Qo‘shildi. Dastur keyingi tekshiruvda ulanib ko‘radi.');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }), 'btn-ghost btn-small');

  /* ───────── 3. Tayyorlash joylari ───────── */
  const enabled = el('input', { type: 'checkbox', className: 'switch', checked: st.enabled });
  enabled.addEventListener('change', () => (st.enabled = enabled.checked));
  const stationList = el('div', { className: 'station-list' });
  const mapBox = el('div', { className: 'cat-map' });
  const itemBox = el('div', { className: 'item-map' });
  const otherSel = el('select', { ariaLabel: 'Boshqa taomlar' });
  otherSel.addEventListener('change', () => (st.otherStationId = otherSel.value));

  const printerOptions = (value) => {
    const s = el('select', { ariaLabel: 'Printer' }, el('option', { value: '', textContent: '— printer tanlanmagan —' }),
      ...data.printers.map((p) => el('option', { value: p.id, textContent: `${p.type === 'win' ? '🔌' : '📶'} ${p.name}${p.found ? '' : ' (topilmadi)'}` })));
    s.value = data.printers.some((p) => p.id === value) ? value : '';
    return s;
  };
  const stationOptions = (sel, value, { other = true } = {}) => {
    const otherName = st.stations.find((s) => s.id === st.otherStationId)?.name;
    sel.replaceChildren(
      ...(other ? [el('option', { value: '', textContent: otherName ? `↳ boshqa taomlar bilan (${otherName})` : '— chiqmaydi (joy tanlanmagan)' })] : []),
      ...st.stations.map((s) => el('option', { value: s.id, textContent: `${s.on === false ? '⏸ ' : ''}${s.name}` })),
      el('option', { value: SKIP, textContent: '✕ oshxonaga chiqmasin' }));
    sel.value = [...sel.options].some((o) => o.value === value) ? value : '';
  };

  function paintStations() {
    stationList.replaceChildren(...st.stations.map((s, i) => {
      const name = el('input', { value: s.name, maxLength: 30, ariaLabel: 'Joy nomi', className: 'station-name' });
      name.addEventListener('change', () => {
        s.name = name.value.trim() || `Bo‘lim ${i + 1}`;
        paintMap();
        paintPrinters();
      });
      const printer = printerOptions(s.printerId);
      printer.classList.add('st-printer');
      printer.addEventListener('change', () => {
        s.printerId = printer.value;
        paintPrinters();
      });
      const copies = el('select', { ariaLabel: 'Nusxa', className: 'st-copies' }, ...[1, 2, 3].map((n) => el('option', { value: String(n), textContent: `${n} nusxa` })));
      copies.value = String(s.copies || 1);
      copies.addEventListener('change', () => (s.copies = Number(copies.value)));
      const beep = el('input', { type: 'checkbox', checked: Boolean(s.beep) });
      beep.addEventListener('change', () => (s.beep = beep.checked));
      const on = el('input', { type: 'checkbox', className: 'switch', checked: s.on !== false, ariaLabel: 'Yoqilgan' });
      on.addEventListener('change', () => {
        s.on = on.checked;
        paintMap();
      });
      const count = cats.filter((c) => st.catMap[c] === s.id).length + Object.values(st.itemMap).filter((v) => v === s.id).length;
      const del = el('button', { type: 'button', className: 'icon-btn danger st-del', textContent: '×', ariaLabel: `${s.name} — o‘chirish`, onclick: () => {
        if (!confirm(`“${s.name}” o‘chirilsinmi? Unga bog‘langan taomlar “boshqa taomlar” joyiga o‘tadi.`)) return;
        st.stations.splice(i, 1);
        for (const c of cats) if (st.catMap[c] === s.id) st.catMap[c] = '';
        for (const id of Object.keys(st.itemMap)) if (st.itemMap[id] === s.id) delete st.itemMap[id];
        if (st.otherStationId === s.id) st.otherStationId = '';
        form.dispatchEvent(new Event('input', { bubbles: true }));
        paintStations();
        paintPrinters();
      } });
      return el('div', { className: `station-row${s.on === false ? ' is-off' : ''}` },
        el('label', { className: 'toggle station-on', title: 'Yoqilgan' }, on),
        name, printer, copies,
        el('label', { className: 'check small st-beep', title: 'Chek chiqqanda printer ovoz chiqaradi (qo‘llasa)' }, beep, ' 🔔'),
        el('span', { className: 'muted small station-count', textContent: count ? `${count} ta bog‘langan` : 'bo‘sh' }),
        del);
    }));
    paintMap();
  }

  function paintMap() {
    stationOptions(otherSel, st.otherStationId, { other: false });
    otherSel.prepend(el('option', { value: '', textContent: '— chiqmasin —' }));
    otherSel.querySelector(`option[value="${SKIP}"]`)?.remove();
    otherSel.value = st.stations.some((s) => s.id === st.otherStationId) ? st.otherStationId : '';
    const counts = Object.fromEntries(cats.map((c) => [c, menuItems.filter((i) => i.category === c).length]));
    mapBox.replaceChildren(...(cats.length ? cats.map((c) => {
      const sel = el('select', { ariaLabel: `${c} — qayerda tayyorlanadi` });
      stationOptions(sel, st.catMap[c]);
      sel.addEventListener('change', () => {
        st.catMap[c] = sel.value;
        paintStationCounts();
      });
      return el('div', { className: 'cat-row' }, el('span', { className: 'cat-name' }, c, el('small', { className: 'muted', textContent: ` · ${counts[c]} ta` })), sel);
    }) : [el('p', { className: 'notice warn', textContent: 'Menyu yuklanmadi — kategoriyalar ko‘rinmayapti. Saqlasangiz ham avvalgi bog‘lashlar o‘chmaydi.' })]));
    paintItems();
  }

  function paintStationCounts() {
    const rows = stationList.querySelectorAll('.station-count');
    st.stations.forEach((s, i) => {
      const n = cats.filter((c) => st.catMap[c] === s.id).length + Object.values(st.itemMap).filter((v) => v === s.id).length;
      if (rows[i]) rows[i].textContent = n ? `${n} ta bog‘langan` : 'bo‘sh';
    });
  }

  // Alohida taom: kategoriyasidan boshqa joyga (masalan, "Lag‘mon" kategoriyasi oshxonada, lekin "Qovurma lag‘mon" — boshqa)
  const search = el('input', { type: 'search', placeholder: 'Taom nomini yozing…', ariaLabel: 'Taom qidirish', className: 'item-search' });
  const found = el('ul', { className: 'item-found' });
  search.addEventListener('input', (e) => {
    e.stopPropagation();
    const q = search.value.trim().toLowerCase();
    found.replaceChildren(...(q.length < 2 ? [] : menuItems.filter((i) => i.name.toLowerCase().includes(q) && !(i.id in st.itemMap)).slice(0, 8).map((i) => el('li', {},
      el('button', { type: 'button', className: 'btn-link', onclick: () => {
        st.itemMap[i.id] = st.catMap[i.category] && st.catMap[i.category] !== SKIP ? st.catMap[i.category] : st.stations[0]?.id || SKIP;
        search.value = '';
        found.replaceChildren();
        form.dispatchEvent(new Event('input', { bubbles: true }));
        paintItems();
        paintStationCounts();
      } }, i.name, el('small', { className: 'muted', textContent: ` · ${i.category}` }))))));
  });
  function paintItems() {
    const ids = Object.keys(st.itemMap).filter((id) => knownItems.has(id));
    itemBox.replaceChildren(...ids.map((id) => {
      const it = menuItems.find((i) => i.id === id);
      const sel = el('select', { ariaLabel: `${it.name} — qayerda tayyorlanadi` });
      stationOptions(sel, st.itemMap[id], { other: false });
      sel.addEventListener('change', () => {
        st.itemMap[id] = sel.value;
        paintStationCounts();
      });
      return el('div', { className: 'cat-row' }, el('span', { className: 'cat-name' }, it.name, el('small', { className: 'muted', textContent: ` · ${it.category}` })), sel,
        el('button', { type: 'button', className: 'icon-btn danger', textContent: '×', ariaLabel: 'Olib tashlash', onclick: () => {
          delete st.itemMap[id];
          form.dispatchEvent(new Event('input', { bubbles: true }));
          paintItems();
          paintStationCounts();
        } }));
    }));
  }

  const addStation = btn('+ Tayyorlash joyi qo‘shish', () => {
    if (st.stations.length >= 12) return toast('Ko‘pi bilan 12 ta.', 'error');
    st.stations.push({ id: rid(), name: `Bo‘lim ${st.stations.length + 1}`, printerId: '', categories: [], items: [], copies: 1, beep: false, on: true });
    form.dispatchEvent(new Event('input', { bubbles: true }));
    paintStations();
    stationList.querySelector('.station-row:last-child .station-name')?.select();
  }, 'btn-ghost btn-small');

  const src = (key, label) => {
    const i = el('input', { type: 'checkbox', checked: st.sources[key] });
    i.addEventListener('change', () => (st.sources[key] = i.checked));
    return el('label', { className: 'check' }, i, ` ${label}`);
  };

  /* ───────── 4. Kassa printeri ───────── */
  const kassaBox = el('div', { className: 'kassa-printer' });
  function paintKassa() {
    const sel = printerOptions(st.kassaPrinterId);
    sel.firstChild.textContent = 'Brauzer orqali (“Qurilmalar” bo‘limidagi chek printeri)';
    sel.addEventListener('change', () => {
      st.kassaPrinterId = sel.value;
      paintPrinters();
      paintKassaNote();
    });
    kassaBox.replaceChildren(el('div', { className: 'field' }, el('label', { textContent: 'Hisob va to‘lov cheklari qaysi printerdan chiqsin' }), sel), kassaNote);
    paintKassaNote();
  }
  const kassaNote = el('p', { className: 'muted small' });
  function paintKassaNote() {
    kassaNote.textContent = st.kassaPrinterId
      ? 'Ofitsiant va kassir “🖨 Chek” bosganda va to‘lovdan keyin chek shu printerdan chiqadi. Kassa sahifasini ochiq qoldirish shart emas — dastur o‘zi chiqaradi.'
      : 'Hozir cheklar “Qurilmalar” bo‘limida tanlangan kassa kompyuteri brauzeri orqali chiqadi (kassa sahifasi ochiq turishi kerak).';
  }

  /* ───────── 5. Qo'ng'iroq ───────── */
  const ringBox = el('div', { className: 'printer-status' });
  const ringUrl = el('input', { type: 'url', placeholder: 'https://…firebaseio.com yoki …firebasedatabase.app', maxLength: 200 });
  ringUrl.addEventListener('input', (e) => e.stopPropagation());
  function paintRing() {
    const r = data.ring;
    const consoleUrl = data.projectId ? `https://console.firebase.google.com/project/${encodeURIComponent(data.projectId)}/database` : 'https://console.firebase.google.com/';
    const setup = btn(r.on ? 'Qayta tekshirish' : '⚡ Qo‘ng‘iroqni yoqish', (e) => busy(e.currentTarget, 'Tekshirilmoqda…', async () => {
      try {
        const x = await api('/ring/setup', { method: 'POST', body: { url: ringUrl.value.trim() } });
        toast(`Yoqildi: ${x.url.replace(/^https:\/\//, '')}. Printer dasturi 2 daqiqa ichida ulanadi.`);
        data.ring = await api('/ring');
        paintRing();
      } catch (err) {
        toast(err.message, 'error');
        data.ring = await api('/ring').catch(() => data.ring);
        paintRing();
      }
    }), r.on ? 'btn-ghost btn-small' : '');
    const off = r.on ? btn('O‘chirish', (e) => busy(e.currentTarget, '…', async () => {
      try {
        await api('/ring/off', { method: 'POST', body: {} });
        data.ring = await api('/ring');
        paintRing();
      } catch (err) {
        toast(err.message, 'error');
      }
    }), 'btn-text btn-small danger') : '';
    ringBox.replaceChildren(
      el('div', { className: `printer-card ${r.on ? 'is-on' : 'is-off'}` }, el('span', { className: 'printer-icon', textContent: '⚡' }),
        el('div', {},
          el('strong', { textContent: r.on ? 'Yoqilgan — cheklar darhol chiqadi' : 'Yoqilmagan — dastur saytni har 15 soniyada tekshiradi' }),
          el('p', { className: 'muted', textContent: r.on ? `${r.url.replace(/^https:\/\//, '')}${r.okAt ? ` · ${ago(r.okAt)} tekshirilgan` : ''}` : 'Chek 15 soniyagacha kechikadi va Netlify bepul tarifidan oyiga taxminan 50 kredit sarflanadi.' }),
          r.error && !r.on ? el('p', { className: 'small warn-text', textContent: `Oxirgi urinish: ${r.error}` }) : '')),
      r.on ? '' : el('ol', { className: 'steps' },
        el('li', {}, el('a', { href: consoleUrl, target: '_blank', rel: 'noopener', textContent: 'Firebase konsolida Realtime Database' }), ' sahifasini oching (loyihangiz: ', el('code', { textContent: data.projectId || '—' }), ').'),
        el('li', { textContent: '“Create Database” → mintaqa (istalgani) → “Start in locked mode” → “Enable”. Bepul tarif yetadi.' }),
        el('li', { textContent: 'Shu yerga qaytib, “Qo‘ng‘iroqni yoqish”ni bosing — sayt kerakli sozlamani o‘zi yozadi.' })),
      el('details', { className: 'small' }, el('summary', { textContent: 'Manzilni qo‘lda kiritish (odatda kerak emas)' }), el('div', { className: 'row' }, ringUrl)),
      el('div', { className: 'row wrap align-center' }, setup, off));
  }

  /* ───────── 6. Oxirgi cheklar ───────── */
  const jobsList = el('ul', { className: 'job-list' });
  function paintJobs() {
    const name = (id) => data.printers.find((p) => p.id === id)?.name || 'printer';
    jobsList.replaceChildren(...(data.jobs.length ? data.jobs.map((j) => el('li', { className: `job is-${j.status === 'retry' ? 'new' : j.status}` },
      el('span', { textContent: fmtDateTime(j.createdAt) }),
      el('span', { textContent: `${KIND[j.kind] || j.kind}${j.station && j.kind === 'kitchen' ? ` · ${j.station}` : ''} · ${j.title}` }),
      el('span', { className: 'muted', textContent: name(j.printerId) }),
      el('strong', { textContent: JOB[j.status] || j.status, title: j.error || '' }))) : [el('li', { className: 'empty', textContent: 'Hali chek chiqarilmagan.' })]));
  }

  /* ───────── saqlash ───────── */
  async function save() {
    const stations = st.stations.map((s) => ({
      id: s.id, name: s.name, printerId: s.printerId, copies: s.copies || 1, beep: Boolean(s.beep), on: s.on !== false,
      // menyuda hozir ko'rinmayotgan bog'lashlar saqlanib qoladi
      categories: [...(s.categories || []).filter((c) => !knownCats.has(c)), ...cats.filter((c) => st.catMap[c] === s.id)],
      items: [...(s.items || []).filter((i) => !knownItems.has(i)), ...Object.keys(st.itemMap).filter((i) => st.itemMap[i] === s.id)],
    }));
    const skip = {
      categories: [...(k.skip?.categories || []).filter((c) => !knownCats.has(c)), ...cats.filter((c) => st.catMap[c] === SKIP)],
      items: [...(k.skip?.items || []).filter((i) => !knownItems.has(i)), ...Object.keys(st.itemMap).filter((i) => st.itemMap[i] === SKIP)],
    };
    if (st.enabled && !stations.some((s) => s.on && s.printerId)) throw new Error('Kamida bitta tayyorlash joyiga printer tanlang (yoki oshxona cheklarini o‘chiring).');
    const r = await api('/kitchen', { method: 'PUT', body: { enabled: st.enabled, stations, otherStationId: st.otherStationId, kassaPrinterId: st.kassaPrinterId, sources: st.sources, skip } });
    st.stations = r.kitchen.stations.map((s) => ({ ...s }));
    k.skip = r.kitchen.skip;
  }

  const testAll = btn('🧾 Sinov: har bir joyga chek', (e) => {
    if (window.__adminDirty) return toast('Avval o‘zgarishlarni saqlang.', 'error');
    busy(e.currentTarget, 'Yuborilmoqda…', async () => {
      try {
        const r = await api('/kitchen/test', { method: 'POST', body: {} });
        toast(`Yuborildi: ${r.stations.join(', ')}${r.missing?.length ? ` · printer yo‘q: ${r.missing.join(', ')}` : ''}`);
        setTimeout(() => api('/kitchen').then((d) => { data = d; paintJobs(); }).catch(() => {}), 6000);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }, 'btn-ghost');

  paintAgent();
  paintPrinters();
  paintStations();
  paintKassa();
  paintRing();
  paintJobs();

  const misonWarn = data.misonOn && data.posMode !== 'own'
    ? el('p', { className: 'notice warn', textContent: 'Mison kassasi ham oshxonaga chek chiqarayotgan bo‘lsa, yoqsangiz cheklar ikki marta chiqadi. Bittasini qoldiring: yoki Mison’dagi oshxona printerlarini, yoki shu yerdagisini.' })
    : '';

  form.append(
    card('Tayyorlash joylari', 'Har bir joy (bo‘lim) o‘z printeriga ega. Buyurtma qabul qilinganda taomlar bo‘limlarga bo‘linib, har biri o‘z printeridan chiqadi.',
      el('label', { className: 'toggle big-toggle' }, enabled, el('span', {}, el('b', { textContent: 'Oshxona cheklari yoqilgan' }), ' — qabul qilingan buyurtma darhol tayyorlash joylariga chiqadi')),
      misonWarn,
      el('div', { className: 'station-head muted small' }, el('span', { textContent: 'Yoq.' }), el('span', { textContent: 'Nomi' }), el('span', { textContent: 'Printer' }), el('span', { textContent: 'Nusxa' }), el('span', { textContent: 'Signal' })),
      stationList, el('div', { className: 'row' }, addStation)),
    card('Qaysi taom qayerda tayyorlanadi', 'Menyu kategoriyasini tayyorlash joyiga bog‘lang. Menyuga yangi kategoriya qo‘shilsa — “boshqa taomlar” joyiga boradi.',
      el('div', { className: 'cat-row is-other' }, el('span', { className: 'cat-name' }, el('b', { textContent: 'Boshqa taomlar' }), el('small', { className: 'muted', textContent: ' · bog‘lanmagan va yangi kategoriyalar' })), otherSel),
      mapBox,
      el('h3', { className: 'sub-title', textContent: 'Alohida taomlar' }),
      el('p', { className: 'muted small', textContent: 'Taom o‘z kategoriyasidan boshqa joyda tayyorlansa (masalan, “Shashlik” kategoriyasida, lekin tandirda pishadi) — shu yerda alohida bog‘lang.' }),
      itemBox, el('div', { className: 'item-pick' }, search, found)),
    card('Qaysi buyurtmalar chiqsin', '',
      el('div', { className: 'checks' },
        src('qr', 'Mijoz QR orqali bergan buyurtma (ofitsiant qabul qilganda)'),
        src('staff', 'Ofitsiant yoki kassa o‘zi yozgan buyurtma'),
        src('delivery', 'Yetkazib berish (kassa qabul qilganda)'))),
    card('Kassa printeri', 'Stol hisobi (oldindan chek) va to‘lov cheki.', kassaBox),
    bar.node);

  root.append(
    pageHead('Tayyorlash joylari', 'Salat, issiq ovqat, somsa, shashlik — har bir joyning cheki o‘z printeridan chiqadi. Wi‑Fi’dagi chek printerlarini kassa kompyuteridagi dastur o‘zi topadi.',
      testAll, btn('Yangilash', (e) => busy(e.currentTarget, '…', reload), 'btn-ghost')),
    card('1. Printer dasturi (kassa kompyuteri)', 'Brauzer Wi‑Fi tarmoqdagi printerlarni ko‘ra olmaydi — shuning uchun kassa kompyuteriga kichik dastur qo‘yiladi. U hech narsa o‘rnatmaydi, faqat printerlarni topadi va cheklarni chiqaradi.',
      agentBox,
      el('ol', { className: 'steps' },
        el('li', { textContent: 'Kassa kompyuterida (Windows 10 yoki 11) shu sahifani oching va “Dasturni yuklab olish”ni bosing.' }),
        el('li', { textContent: 'Yuklangan oqtosh-printer.cmd faylini ikki marta bosing. “Windows защитил компьютер” chiqsa: “Подробнее” → “Выполнить в любом случае”.' }),
        el('li', { textContent: 'Qora oyna ochiladi va printerlarni qidiradi. Oynani yopmang (kichraytirish mumkin) — kompyuter har yoqilganda o‘zi ishga tushadi.' }),
        el('li', { textContent: 'Printerlar pastda paydo bo‘ladi. Qaysi biri qaysiligini bilish uchun “🖨 Sinov”ni bosing — printerdan uning nomi va manzili chiqadi.' }))),
    card('2. Printerlar', 'Wi‑Fi/LAN (📶) va kompyuterga ulangan USB (🔌) printerlar.',
      printerList,
      el('details', { className: 'add-ip' }, el('summary', { textContent: 'Printer topilmadimi? IP manzil bilan qo‘shish' }),
        el('p', { className: 'muted small', textContent: 'Printer IP manzilini bilish uchun: printerni o‘chiring, FEED tugmasini bosib turib yoqing — sinov varag‘ida IP yozilgan bo‘ladi.' }),
        el('div', { className: 'row' }, ipInput, portInput, addIp))),
    form,
    card('Tezkor “qo‘ng‘iroq” (tavsiya etiladi)', 'Yangi chek paydo bo‘lishi bilan printer dasturiga darhol xabar beradi. Firebase’ning bepul Realtime Database xizmatidan foydalanadi — Netlify kreditlari tejaladi.', ringBox),
    card('Oxirgi cheklar', '', jobsList));
}
