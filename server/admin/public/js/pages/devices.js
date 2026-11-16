import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, selectField, textField, fmtDateTime } from '../ui.js';

// Qurilmalar: xodimlar kirgan telefon va kompyuterlar. Ulardan biri — asosiy kassa kompyuteri
// (chek printeri): telefondan bosilgan cheklar shu kompyuterga ulangan printerdan chiqadi.
const KIND = { phone: '📱', tablet: '📟', computer: '💻' };
const ROLE = { waiter: 'Ofitsiant', cashier: 'Kassir', courier: 'Kuryer' };
const JOB = { new: 'navbatda', done: '✓ chiqdi', error: 'xato', expired: 'chiqmadi (vaqti o‘tdi)' };

const ago = (iso) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'hozirgina';
  if (m < 60) return `${m} daq oldin`;
  if (m < 24 * 60) return `${Math.round(m / 60)} soat oldin`;
  return fmtDateTime(iso);
};

export async function render(root) {
  let data = await api('/devices');
  const me = await api('/me').catch(() => ({}));
  const site = (me.publicSiteUrl || '').replace(/\/+$/, '') || 'https://oqtoshrestoran.uz';

  const statusBox = el('div', { className: 'printer-status' });
  const list = el('ul', { className: 'item-list device-list' });
  const jobsList = el('ul', { className: 'job-list' });
  const paper = selectField({ label: 'Qog‘oz eni', value: String(data.printing.paper || 80), options: [['80', '80 mm (keng)'], ['58', '58 mm (tor)']] });
  const footer = textField({ label: 'Chek oxiridagi yozuv', value: data.printing.footer, maxlength: 160, placeholder: 'Rahmat! Yana kutib qolamiz.' });

  async function reload() {
    data = await api('/devices');
    paint();
  }

  const setStation = (id) => async (e) => busy(e.currentTarget, '…', async () => {
    try {
      await api('/printing', { method: 'PUT', body: { stationId: id } });
      toast(id ? 'Chek printeri tanlandi. Shu kompyuterda kassa sahifasini ochiq qoldiring.' : 'Chek printeri o‘chirildi.');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function paintStatus() {
    const s = data.station;
    if (!s) {
      statusBox.replaceChildren(el('p', { className: 'notice warn', textContent: 'Chek printeri tanlanmagan. Pastdagi ro‘yxatdan printer ulangan kassa kompyuterini topib, “Chek printeri qilish”ni bosing. Kompyuter ro‘yxatda bo‘lishi uchun unda kassa sahifasini oching va kassir bo‘lib kiring.' }));
      return;
    }
    statusBox.replaceChildren(
      el('div', { className: `printer-card ${s.online ? 'is-on' : 'is-off'}` },
        el('span', { className: 'printer-icon', textContent: '🖨' }),
        el('div', {},
          el('strong', { textContent: s.name }),
          el('p', { className: 'muted' }, el('span', { className: `dot ${s.online ? 'is-on' : ''}`, style: 'margin:0 6px 0 0' }), `${s.online ? 'Onlayn' : 'Oflayn'} · oxirgi aloqa: ${ago(s.lastSeenAt)}${s.lastPrintAt ? ` · oxirgi chek: ${ago(s.lastPrintAt)}` : ''}${data.queue ? ` · navbatda: ${data.queue}` : ''}`),
          !s.online ? el('p', { className: 'small warn-text', textContent: 'Kompyuter yoqilmagan yoki kassa sahifasi yopiq. Cheklar navbatda turadi va 30 daqiqa ichida yoqilsa chiqadi.' }) : '')),
      el('div', { className: 'row wrap align-center' },
        btn('Sinov cheki', (e) => busy(e.currentTarget, 'Yuborilmoqda…', async () => {
          try {
            const r = await api('/printing/test', { method: 'POST', body: {} });
            toast(r.station.online ? 'Sinov cheki yuborildi — printerdan chiqishi kerak.' : 'Yuborildi, lekin kompyuter oflayn.');
            setTimeout(reload, 5000);
          } catch (err) {
            toast(err.message, 'error');
          }
        })),
        btn('Printerni o‘chirish', setStation(''), 'btn-text btn-small danger')));
  }

  function paintDevices() {
    list.replaceChildren(...(data.items.length ? data.items.map((d) => {
      const actions = [];
      if (!d.station) actions.push(btn('Chek printeri qilish', setStation(d.id), d.kind === 'computer' ? 'btn-small' : 'btn-ghost btn-small'));
      actions.push(btn('Nomi', async (e) => {
        const name = prompt('Qurilma nomi (masalan: Kassa kompyuteri, Sardorning telefoni):', d.custom ? d.name : '');
        if (name === null) return;
        busy(e.currentTarget, '…', async () => {
          try {
            await api(`/devices/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { name } });
            await reload();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-ghost btn-small'));
      actions.push(btn('O‘chirish', (e) => {
        if (!confirm(`${d.name} ro‘yxatdan o‘chirilsinmi? Shu qurilmada xodim yana kirsa, qaytadan paydo bo‘ladi.`)) return;
        busy(e.currentTarget, '…', async () => {
          try {
            await api(`/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
            await reload();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-text btn-small danger'));
      return el('li', { className: `item device-item${d.station ? ' is-station' : ''}` },
        el('span', { className: 'device-kind', textContent: KIND[d.kind] || '💻', ariaHidden: 'true' }),
        el('div', { className: 'item-main' },
          el('h3', {}, d.name,
            d.station ? el('span', { className: 'role-badge is-cashier', textContent: '🖨 Chek printeri' }) : '',
            el('span', { className: `dot ${d.online ? 'is-on' : ''}`, title: d.online ? 'Onlayn' : 'Oflayn' })),
          el('p', { className: 'muted', textContent: [d.custom ? d.auto : '', d.staffName && `${d.staffName}${ROLE[d.role] ? ` (${ROLE[d.role]})` : ''}`, d.pageLabel && `${d.pageLabel} sahifasi`].filter(Boolean).join(' · ') }),
          el('p', { className: 'small muted', textContent: d.online ? '● hozir onlayn' : `oxirgi marta: ${ago(d.lastSeenAt)}` })),
        el('div', { className: 'item-actions' }, ...actions));
    }) : [el('li', { className: 'empty', textContent: 'Hali hech bir qurilma yo‘q. Xodim telefonida yoki kassa kompyuterida ofitsiant/kassa sahifasiga kirsa, shu yerda paydo bo‘ladi.' })]));
  }

  function paintJobs() {
    jobsList.replaceChildren(...(data.jobs.length ? data.jobs.map((j) => el('li', { className: `job is-${j.status}` },
      el('span', { textContent: fmtDateTime(j.createdAt) }),
      el('span', { textContent: `${j.kind}${j.title ? ` · ${j.title}` : ''}` }),
      el('span', { className: 'muted', textContent: j.byName }),
      el('strong', { textContent: JOB[j.status] || j.status, title: j.error || '' }))) : [el('li', { className: 'empty', textContent: 'Hali chek chiqarilmagan.' })]));
  }

  function paint() {
    paintStatus();
    paintDevices();
    paintJobs();
  }

  const save = btn('Saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
    try {
      await api('/printing', { method: 'PUT', body: { paper: Number(paper.get()), footer: footer.get() } });
      toast('Saqlandi.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  const shortcut = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding ${site}/kassa.html`;
  const copy = btn('Nusxa olish', async () => {
    try {
      await navigator.clipboard.writeText(shortcut);
      toast('Nusxa olindi.');
    } catch {
      toast('Nusxa olib bo‘lmadi — qo‘lda belgilab oling.', 'error');
    }
  }, 'btn-ghost btn-small');

  /* ── Oqtosh Kassa dasturi o'rnatilgan kompyuterlar: masofadan o'chirish / qayta yoqish ── */
  const pcList = el('ul', { className: 'item-list pc-list' });
  const pcHead = el('div', { className: 'row wrap align-center pc-head' });
  let pcs = [];
  // shu sahifa Oqtosh Kassa dasturi ichida ochilgan bo'lsa — o'z kompyuteri "hammasini o'chirish"ga kirmaydi
  const selfId = window.OqDesktop?.deviceId || '';
  const CMD = { shutdown: 'o‘chirish', restart: 'qayta yoqish', cancel: 'bekor qilish' };
  const RES = { started: 'boshlandi — 60 soniyada', cancelled: 'bekor qilindi', refused: 'rad etdi', error: 'xato' };
  async function pcReload() {
    try {
      pcs = (await api('/desktops')).items || [];
    } catch (err) {
      pcList.replaceChildren(el('li', { className: 'empty', textContent: err.message }));
      return;
    }
    pcPaint();
  }
  const pcSend = async (ids, action, label) => {
    try {
      const r = await api('/desktops/command', { method: 'POST', body: { ids, action } });
      const skip = r.skipped.length ? ` O‘tkazib yuborildi: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}.` : '';
      toast(r.sent.length ? `${label}: ${r.sent.map((x) => x.name).join(', ')} — buyruq yuborildi, 20 soniya ichida bajariladi.${skip}` : `Hech biriga yuborilmadi.${skip}`, r.sent.length ? '' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
    await pcReload();
  };
  function pcPaint() {
    const targets = pcs.filter((p) => p.online && !p.server && p.id !== selfId);
    pcHead.replaceChildren(
      el('p', { className: 'muted small grow', textContent: targets.length ? `${targets.length} ta kompyuter yoqilgan.` : 'Hozir boshqa yoqilgan kompyuter yo‘q.' }),
      targets.length ? btn(`⏻ Hammasini o‘chirish (${targets.length})`, (e) => {
        if (!confirm(`${targets.map((p) => p.name).join(', ')} — hammasi o‘chirilsinmi?\n\nHar birining ekranida 60 soniya ogohlantirish chiqadi, xodim “Bekor qilish”ni bosishi mumkin.${selfId ? '\nShu kompyuter o‘chirilmaydi.' : ''}`)) return;
        busy(e.currentTarget, '…', () => pcSend(targets.map((p) => p.id), 'shutdown', 'O‘chirish'));
      }, 'btn-ghost btn-small danger') : '');
    pcList.replaceChildren(...(pcs.length ? pcs.map((p) => {
      const c = p.command;
      const status = c ? (c.pending ? `⏳ ${CMD[c.action]} buyrug‘i yuborildi (${c.byName})` : c.expired ? `${CMD[c.action]} — kompyuter olmadi (vaqti o‘tdi)` : `${CMD[c.action]}: ${RES[c.result] || c.result}${c.error ? ` (${c.error})` : ''} · ${ago(c.at)}`) : '';
      const actions = [];
      const isSelf = p.id === selfId;
      if (p.online && !p.server) {
        const started = c && (c.pending || c.result === 'started') && c.action !== 'cancel' && Date.now() - new Date(c.at) < 5 * 60_000;
        if (started) actions.push(btn('Bekor qilish', (e) => busy(e.currentTarget, '…', () => pcSend([p.id], 'cancel', 'Bekor qilish')), 'btn-small'));
        actions.push(btn('⏻ O‘chirish', (e) => {
          if (!confirm(`${p.name} o‘chirilsinmi?${isSelf ? '\n\nDiqqat: bu — siz hozir ishlayotgan kompyuter.' : ''}\n\nEkranda 60 soniya ogohlantirish chiqadi.`)) return;
          busy(e.currentTarget, '…', () => pcSend([p.id], 'shutdown', 'O‘chirish'));
        }, 'btn-ghost btn-small'));
        actions.push(btn('↻ Qayta yoqish', (e) => {
          if (!confirm(`${p.name} qayta yoqilsinmi (restart)?`)) return;
          busy(e.currentTarget, '…', () => pcSend([p.id], 'restart', 'Qayta yoqish'));
        }, 'btn-ghost btn-small'));
      }
      if (!p.online) {
        actions.push(btn('Ro‘yxatdan o‘chirish', (e) => {
          if (!confirm(`${p.name} ro‘yxatdan olib tashlansinmi? Dastur yana yoqilsa, qaytadan paydo bo‘ladi.`)) return;
          busy(e.currentTarget, '…', async () => {
            try {
              await api(`/desktops/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
            } catch (err) {
              toast(err.message, 'error');
            }
            await pcReload();
          });
        }, 'btn-text btn-small danger'));
      }
      return el('li', { className: `item device-item${p.main ? ' is-station' : ''}` },
        el('span', { className: 'device-kind', textContent: '💻', ariaHidden: 'true' }),
        el('div', { className: 'item-main' },
          el('h3', {}, p.name,
            p.server ? el('span', { className: 'role-badge', textContent: 'server' }) : p.main ? el('span', { className: 'role-badge is-cashier', textContent: 'asosiy' }) : '',
            isSelf ? el('span', { className: 'role-badge', textContent: 'shu kompyuter' }) : '',
            el('span', { className: `dot ${p.online ? 'is-on' : ''}`, title: p.online ? 'Yoqilgan' : 'O‘chiq' })),
          el('p', { className: 'muted', textContent: [p.version && `Oqtosh Kassa ${p.version}`, p.os].filter(Boolean).join(' · ') }),
          el('p', { className: 'small muted', textContent: p.online ? '● yoqilgan' : `o‘chiq · oxirgi marta: ${ago(p.lastSeenAt)}` }),
          status ? el('p', { className: 'small', textContent: status }) : '',
          p.server ? el('p', { className: 'small muted', textContent: 'Server kompyuterini masofadan o‘chirib bo‘lmaydi — sayt to‘xtab qoladi.' }) : ''),
        el('div', { className: 'item-actions' }, ...actions));
    }) : [el('li', { className: 'empty', textContent: 'Hali hech bir kompyuter yo‘q. Oqtosh Kassa dasturi (Setup.exe) o‘rnatilgan kompyuter yoqilganda shu yerda o‘zi paydo bo‘ladi.' })]));
  }
  pcReload();
  // ochiq turganda holat yangilanib turadi (sahifadan chiqilsa — to'xtaydi)
  const pcTimer = setInterval(() => (root.isConnected ? pcReload() : clearInterval(pcTimer)), 10_000);

  paint();
  root.append(
    pageHead('Qurilmalar', 'Xodimlar kirgan telefon va kompyuterlar. Printer ulangan kassa kompyuterini “chek printeri” qilib tanlang — ofitsiant va kassir telefondan bosgan cheklar o‘sha printerdan chiqadi.',
      btn('Yangilash', (e) => busy(e.currentTarget, '…', reload), 'btn-ghost')),
    card('💻 Kompyuterlar (Oqtosh Kassa dasturi)', 'Dastur o‘rnatilgan kompyuterlarni shu yerdan o‘chirish yoki qayta yoqish mumkin. Kompyuter ekranida 60 soniya ogohlantirish chiqadi.', pcHead, pcList),
    card('Chek printeri', '', statusBox, el('div', { className: 'grid-2' }, paper.node, footer.node), el('div', { className: 'row' }, save)),
    card('Qurilmalar', '', list),
    card('Kassa kompyuterini sozlash (bir marta)', 'Chek oynasiz, darhol chiqishi uchun.',
      el('ol', { className: 'steps' },
        el('li', { textContent: 'Chek printerini kompyuterga ulang va Windows’da “Asosiy printer” (по умолчанию) qilib qo‘ying: Пуск → Параметры → Принтеры.' }),
        el('li', { textContent: 'Ish stolida Chrome yorlig‘ini (ярлык) yarating → o‘ng tugma → Свойства → “Объект” maydoniga quyidagini yozing:' }),
        el('li', { className: 'no-num' }, el('code', { className: 'shortcut', textContent: shortcut }), copy),
        el('li', { textContent: 'Barcha Chrome oynalarini yoping, keyin shu yorliq orqali oching va kassir bo‘lib kiring. Bu kompyuter “Qurilmalar” ro‘yxatida paydo bo‘ladi — “Chek printeri qilish”ni bosing.' }),
        el('li', { textContent: '“Sinov cheki”ni bosing. Chek oynasiz chiqsa — tayyor. Kassa sahifasini kun bo‘yi ochiq qoldiring (Mison oynasi ustida tursa ham ishlaydi).' })),
      el('p', { className: 'muted small', textContent: 'Yorliqsiz oddiy Chrome’da ham ishlaydi, faqat har chekda chop etish oynasi chiqadi va “Печать”ni bosish kerak bo‘ladi. Bu chek — to‘lov uchun hisob; fiskal chekni Mison kassasi beradi.' })),
    card('Oxirgi cheklar', '', jobsList));
}
