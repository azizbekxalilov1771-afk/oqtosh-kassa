import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, selectField, fmtDateTime } from '../ui.js';

const ROLES = [['waiter', 'Ofitsiant'], ['cashier', 'Kassir'], ['courier', 'Kuryer'], ['storekeeper', 'Omborchi']];
const ROLE_NAME = Object.fromEntries(ROLES);
// Xodim sahifalari shu (admin) saytda: /xodim/...
const PAGE = { waiter: '/xodim/ofitsiant.html', cashier: '/xodim/kassa.html', courier: '/xodim/kuryer.html', storekeeper: '/xodim/ombor.html' };

// Ruxsatlar: uch holat — lavozimdagidek / ruxsat / taqiq
function permsDialog(s, groups, roleMap, onSaved) {
  const own = { ...(s.perms || {}) };
  const rows = groups.map((g) => el('fieldset', { className: 'perm-group' }, el('legend', { textContent: g.group }),
    ...g.items.map(([k, label]) => {
      const base = roleMap?.[k];
      const sel = el('select', { ariaLabel: label },
        el('option', { value: '', textContent: `lavozimdagidek (${base ? 'ha' : 'yo‘q'})` }),
        el('option', { value: 'on', textContent: '✓ ruxsat' }),
        el('option', { value: 'off', textContent: '✕ taqiq' }));
      sel.value = own[k] === true ? 'on' : own[k] === false ? 'off' : '';
      sel.addEventListener('change', () => {
        own[k] = sel.value === 'on' ? true : sel.value === 'off' ? false : null;
        row.classList.toggle('is-custom', sel.value !== '');
      });
      const row = el('div', { className: `perm-row${sel.value ? ' is-custom' : ''}` }, el('span', { textContent: label }), sel);
      return row;
    })));
  const dlg = el('dialog', { className: 'pw-dialog perm-dialog' },
    el('h2', { textContent: `Ruxsatlar · ${s.name || s.phone}` }),
    el('p', { className: 'muted small', textContent: `Lavozimi: ${ROLE_NAME[s.role]}. Faqat shu xodim uchun farq qiladigan joylarni o‘zgartiring — qolganlari lavozim jadvalidan olinadi.` }),
    el('div', { className: 'perm-scroll' }, rows),
    el('div', { className: 'row' },
      btn('Saqlash', (e) => busy(e.currentTarget, '…', async () => {
        try {
          const r = await api(`/staff/${s.id}/perms`, { method: 'PUT', body: { perms: own } });
          s.perms = r.perms;
          toast('Ruxsatlar saqlandi. Xodim sahifasi 15 soniyada yangilanadi.');
          dlg.close();
          onSaved?.();
        } catch (err) {
          toast(err.message, 'error');
        }
      })),
      btn('Yopish', () => dlg.close(), 'btn-ghost')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// PIN'ni bir marta ko'rsatish (keyin hech qayerda ko'rinmaydi)
function showPassword(name, phone, password) {
  const dlg = el('dialog', { className: 'pw-dialog' },
    el('h2', { textContent: 'Xodim PIN’i' }),
    el('p', { className: 'muted', textContent: `${name}${phone ? ` · ${phone}` : ''}` }),
    el('p', { className: 'pw-big', textContent: password }),
    el('p', { className: 'muted small', textContent: 'Xodimga ayting. Bu PIN boshqa ko‘rsatilmaydi — unutsa, yangisini berasiz. Kirish: o‘z sahifasida faqat shu 4 xonali PIN (telefon raqami shart emas). Har bir xodimning PIN’i boshqalarnikidan farq qiladi.' }),
    el('div', { className: 'row' },
      btn('Nusxa olish', async () => {
        try {
          await navigator.clipboard.writeText(password);
          toast('Nusxa olindi.');
        } catch {
          toast('Nusxa olib bo‘lmadi.', 'error');
        }
      }, 'btn-ghost'),
      btn('Yopish', () => dlg.close())));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

export async function render(root) {
  let { items, customers } = await api('/staff');
  let wp = await api('/workplace').catch(() => null);
  let perm = await api('/permissions').catch(() => null);
  const list = el('div', { className: 'stack' });
  const wpBox = el('div', { className: 'stack' });

  const refreshStaff = async () => {
    ({ items } = await api('/staff'));
    paint();
  };

  function staffRow(s) {
    const own = Object.keys(s.perms || {}).length;
    const actions = [
      btn(s.hasPassword ? 'Yangi PIN' : '🔑 PIN berish', (e) => {
        const custom = prompt(`${s.name || s.phone} uchun 4 xonali PIN.\nBo‘sh qoldirsangiz — o‘zi yaratiladi.${s.hasPassword ? '\nEski PIN ishlamay qoladi.' : ''}`, '');
        if (custom === null) return;
        busy(e.currentTarget, '…', async () => {
          try {
            const r = await api(`/staff/${s.id}/password`, { method: 'POST', body: { password: custom.trim() } });
            showPassword(r.name, s.phone, r.password);
            await refreshStaff();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-ghost btn-small'),
    ];
    actions.push(btn(own ? `Ruxsatlar · ${own}` : 'Ruxsatlar', () => permsDialog(s, perm?.groups || [], perm?.roles?.[s.role], paint), 'btn-ghost btn-small'));
    actions.push(btn('Ismi', async (e) => {
      const name = prompt('Xodim ismi (sahifalarda va cheklarda shunday ko‘rinadi):', s.name || '');
      if (!name || name.trim() === s.name) return;
      busy(e.currentTarget, '…', async () => {
        try {
          const r = await api(`/staff/${s.id}/name`, { method: 'PUT', body: { name } });
          s.name = r.name;
          paint();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }, 'btn-text btn-small'));
    const roleSel = el('select', { className: 'role-select', ariaLabel: 'Lavozim' }, ROLES.map(([v, l]) => el('option', { value: v, textContent: l, selected: v === s.role })));
    roleSel.addEventListener('change', async () => {
      try {
        const r = await api(`/staff/${s.id}/role`, { method: 'PUT', body: { role: roleSel.value } });
        s.role = r.item.role;
        toast(`${s.name || s.phone} endi ${ROLE_NAME[s.role].toLowerCase()}.`);
        paint();
      } catch (err) {
        toast(err.message, 'error');
        roleSel.value = s.role;
      }
    });
    actions.push(roleSel);
    if (s.hasPassword && !s.noTelegram && false) {
      actions.push(btn('Parolni o‘chirish', (e) => {
        if (!confirm(`${s.name || s.phone}: parol bilan kirish o‘chirilsinmi? (Telegram orqali kirish qoladi)`)) return;
        busy(e.currentTarget, '…', async () => {
          try {
            await api(`/staff/${s.id}/password`, { method: 'DELETE' });
            await refreshStaff();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }, 'btn-text btn-small'));
    }
    actions.push(btn('Olib tashlash', (e) => {
      if (!confirm(`${s.name || s.phone} xodimlar ro‘yxatidan olib tashlansinmi?`)) return;
      busy(e.currentTarget, '…', async () => {
        try {
          await api(`/staff/${s.id}`, { method: 'DELETE' });
          items = items.filter((x) => x.id !== s.id);
          toast('Olib tashlandi.');
          paint();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }, 'btn-text btn-small danger'));
    return el('li', { className: 'item staff-item' },
      el('div', { className: 'item-main' },
        el('h3', {}, s.name || 'Ismsiz', ' ', el('span', { className: `role-badge is-${s.role}`, textContent: ROLE_NAME[s.role] }),
          s.hasPassword ? el('span', { className: 'role-badge is-pw', textContent: '🔑 PIN' }) : el('span', { className: 'role-badge is-nopw', textContent: 'PIN yo‘q' })),
        el('p', { className: 'muted', textContent: [s.phone, s.username && `@${s.username}`, s.noTelegram ? 'Telegram’siz' : ''].filter(Boolean).join(' · ') })),
      el('div', { className: 'item-actions' }, ...actions));
  }

  function paint() {
    list.replaceChildren(...ROLES.map(([role, title]) => {
      const mine = items.filter((s) => s.role === role);
      return card(`${title}lar · ${mine.length}`, `Sahifasi: ${PAGE[role]}`,
        el('ul', { className: 'item-list' }, mine.length ? mine.map(staffRow) : [el('li', { className: 'empty', textContent: `Hali ${title.toLowerCase()} yo‘q.` })]));
    }));
  }

  /* — ishxona tarmog'i — */
  const wpAct = (fn) => async (e) => busy(e.currentTarget, '…', async () => {
    try {
      wp = await fn();
      paintWp();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function paintWp() {
    if (!wp) {
      wpBox.replaceChildren(el('p', { className: 'notice warn', textContent: 'Ishxona tarmog‘i ma’lumotini olib bo‘lmadi.' }));
      return;
    }
    const enabled = el('input', { type: 'checkbox', className: 'switch', checked: wp.enabled });
    enabled.addEventListener('change', () => {
      const want = enabled.checked;
      api('/workplace', { method: 'PUT', body: { enabled: want } })
        .then((r) => {
          wp = r;
          toast(want ? 'Endi faqat restoran Wi‑Fi’sidan kirish mumkin.' : 'Endi istalgan internetdan PIN bilan kirish mumkin.');
          paintWp();
        })
        .catch((err) => {
          enabled.checked = !want;
          toast(err.message, 'error');
        });
    });
    const here = el('div', { className: `wp-here ${wp.currentAllowed ? 'is-ok' : ''}` },
      el('span', { textContent: wp.currentAllowed ? '✓' : '📶', ariaHidden: 'true' }),
      el('div', {},
        el('strong', { textContent: wp.currentAllowed ? 'Siz hozir ishxona tarmog‘idasiz' : 'Siz turgan tarmoq hali ishxona deb belgilanmagan' }),
        el('p', { className: 'muted small', textContent: `Internet manzili: ${wp.currentIp || '—'}` })),
      wp.currentAllowed ? '' : btn('Shu tarmoqni qo‘shish', wpAct(() => api('/workplace/networks', { method: 'POST', body: { label: 'Restoran Wi‑Fi' } }))));
    const nets = el('ul', { className: 'wp-nets' }, wp.networks.length ? wp.networks.map((n) => el('li', {},
      el('span', { className: 'wp-ip', textContent: n.ip }),
      el('span', { className: 'muted small', textContent: n.auto ? `Kassa kompyuteri — o‘zi yangilanadi · ${fmtDateTime(n.lastSeenAt)}` : `${n.label || 'Qo‘lda'} · qo‘shilgan ${fmtDateTime(n.addedAt)}` }),
      btn('O‘chirish', wpAct(() => api(`/workplace/networks/${encodeURIComponent(n.ip)}`, { method: 'DELETE' })), 'btn-text btn-small danger'))) : [el('li', { className: 'empty', textContent: 'Hali tarmoq qo‘shilmagan.' })]);
    wpBox.replaceChildren(
      el('label', { className: 'toggle' }, enabled, el('span', { textContent: 'Ofitsiant, kassir va omborchi faqat restoran Wi‑Fi’sidan kira olsin (kuryer — istalgan joydan)' })),
      here,
      el('div', {}, el('h3', { className: 'wp-head', textContent: 'Ishxona tarmoqlari' }), nets),
      el('p', { className: 'muted small', textContent: 'Qanday ishlaydi: restoran Wi‑Fi’siga ulangan hamma qurilma internetga bitta umumiy manzil bilan chiqadi. Yoqilsa — ofitsiant, kassir va omborchi faqat shu manzildan PIN bilan kira oladi (uydan yoki mobil internetdan — yo‘q). Asosiy kassa kompyuterining manzili o‘zi qo‘shiladi va provayder almashtirsa ham o‘zi yangilanadi. Ikkita internet (ikki router) bo‘lsa — har biriga ulanib “Shu tarmoqni qo‘shish”ni bosing. PIN bilan ochilgan sessiya 16 soat (bir smena) davom etadi.' }));
  }

  /* — xodim qo'shish: ism + telefon + lavozim → 4 xonali PIN — */
  const name = textField({ label: 'Ismi', placeholder: 'Masalan: Dilshod', maxlength: 80 });
  const phone = textField({ label: 'Telefon (ixtiyoriy)', type: 'tel', placeholder: '+998 90 123 45 67', maxlength: 25 });
  const role = selectField({ label: 'Lavozimi', value: 'waiter', options: ROLES });
  const pin = textField({ label: 'PIN (ixtiyoriy)', placeholder: 'o‘zi yaratiladi', maxlength: 4, inputmode: 'numeric' });
  const add = btn('Xodim qilish', (e) => busy(e.currentTarget, 'Qo‘shilmoqda…', async () => {
    try {
      const r = await api('/staff', { method: 'POST', body: { phone: phone.get(), name: name.get(), role: role.get(), pin: pin.get() } });
      items = [...items.filter((x) => x.id !== r.item.id), { perms: {}, ...r.item }];
      phone.set('');
      name.set('');
      pin.set('');
      paint();
      showPassword(r.item.name, r.item.phone, r.password);
    } catch (err) {
      toast(err.message, 'error');
    }
  }));

  /* — lavozim ruxsatlari jadvali — */
  const matrix = el('div', { className: 'perm-matrix-wrap' });
  function paintMatrix() {
    if (!perm) return matrix.replaceChildren(el('p', { className: 'notice warn', textContent: 'Ruxsatlarni olib bo‘lmadi.' }));
    const draft = JSON.parse(JSON.stringify(perm.roles));
    const table = el('table', { className: 'perm-matrix' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Ruxsat' }), ...ROLES.map(([, l]) => el('th', { textContent: l })))),
      el('tbody', {}, perm.groups.flatMap((g) => [
        el('tr', { className: 'perm-group-row' }, el('td', { colSpan: ROLES.length + 1, textContent: g.group })),
        ...g.items.map(([k, label]) => el('tr', {}, el('td', { textContent: label }),
          ...ROLES.map(([r]) => {
            const cb = el('input', { type: 'checkbox', checked: Boolean(draft[r]?.[k]), ariaLabel: `${ROLE_NAME[r]}: ${label}` });
            cb.addEventListener('change', () => { draft[r][k] = cb.checked; });
            return el('td', { className: 'perm-cell' }, cb);
          }))),
      ])));
    matrix.replaceChildren(el('div', { className: 'perm-scroll-x' }, table),
      el('div', { className: 'row' }, btn('Ruxsatlarni saqlash', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
        try {
          const r = await api('/permissions', { method: 'PUT', body: { roles: draft } });
          perm = { ...perm, roles: r.roles };
          toast('Saqlandi. Xodimlar sahifasi 15 soniyada yangilanadi.');
          paintMatrix();
        } catch (err) {
          toast(err.message, 'error');
        }
      })), btn('Bekor qilish', () => paintMatrix(), 'btn-ghost')));
  }
  paintMatrix();
  paint();
  paintWp();

  root.append(
    pageHead('Xodimlar', `Ofitsiant, kassir, kuryer va omborchilar. Har biri faqat o‘zining 4 xonali PIN’i bilan kiradi — telefon raqami ham, Telegram ham shart emas. Sahifalari shu admin saytida: ${location.origin}/xodim/`),
    card('Xodim qo‘shish', 'Ism — sahifalarda va cheklarda shunday ko‘rinadi. PIN’ni bo‘sh qoldirsangiz — o‘zi yaratiladi va bir marta ko‘rsatiladi.',
      el('div', { className: 'row align-end wrap' }, name.node, phone.node, role.node, pin.node, add),
      el('p', { className: 'muted small' }, 'Sahifalar: ', ...ROLES.flatMap(([r, t], i) => [i ? ' · ' : '', el('a', { href: PAGE[r], target: '_blank', rel: 'noopener', textContent: `${t} — ${PAGE[r]}` })]))),
    list,
    card('Lavozim ruxsatlari', 'Har bir lavozim nimalar qila oladi. Bitta xodimga alohida qo‘shish yoki olib tashlash — ro‘yxatdagi “Ruxsatlar” tugmasi.', matrix),
    card('Faqat restoran Wi‑Fi’sidan kirish', 'Yoqilsa: ofitsiant, kassir va omborchi uydan yoki mobil internetdan kira olmaydi.', wpBox));
}
