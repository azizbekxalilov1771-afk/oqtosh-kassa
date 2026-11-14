import { api } from '../auth.js';
import { el, btn, busy, toast, pageHead, card, textField, imageField, toggleField } from '../ui.js';

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])}-${MONTHS[Number(m[2]) - 1]}, ${m[1]}` : '';
};
const today = () => new Date().toISOString().slice(0, 10);

export async function render(root) {
  const area = el('div', { className: 'stack' });
  root.append(pageHead('Yangiliklar', 'Saytdagi "Yangiliklar" bo‘limi. AI yordamchi ham oxirgi yangiliklardan xabardor.', btn('Yangi yangilik', () => edit(null))), area);

  async function showList() {
    window.__adminDirty = false;
    const { items } = await api('/news');
    if (!items.length) {
      return area.replaceChildren(card('', '', el('p', { className: 'empty', textContent: 'Hali yangilik yo‘q. Birinchisini qo‘shing — u saytda darhol ko‘rinadi.' }), btn('Yangi yangilik', () => edit(null))));
    }
    area.replaceChildren(el('ul', { className: 'item-list' }, items.map((n) => el('li', { className: 'item' },
      n.image ? el('img', { className: 'item-thumb', src: n.image, alt: '' }) : el('div', { className: 'item-thumb is-empty' }),
      el('div', { className: 'item-main' },
        el('p', { className: 'item-meta' }, fmtDate(n.date), el('span', { className: `chip ${n.published ? 'is-ok' : 'is-muted'}`, textContent: n.published ? 'Saytda' : 'Yashirin' })),
        el('h3', { textContent: n.title }),
        el('p', { className: 'muted clamp-2', textContent: n.text })),
      el('div', { className: 'item-actions' },
        btn('Tahrirlash', () => edit(n), 'btn-ghost btn-small'),
        btn('O‘chirish', (e) => {
          if (!confirm(`"${n.title}" yangiligini o‘chirasizmi?`)) return;
          busy(e.currentTarget, '…', async () => {
            try {
              await api(`/news/${n.id}`, { method: 'DELETE' });
              toast('O‘chirildi.');
              showList();
            } catch (err) {
              toast(err.message, 'error');
            }
          });
        }, 'btn-text btn-small danger'))))));
  }

  function edit(n) {
    const f = {
      title: textField({ label: 'Sarlavha', value: n?.title, maxlength: 140 }),
      date: textField({ label: 'Sana', value: n?.date || today(), type: 'date' }),
      text: textField({ label: 'Matn', value: n?.text, rows: 8, maxlength: 4000 }),
      image: imageField({ label: 'Rasm', value: n?.image, hint: 'Ixtiyoriy. Rasm bo‘lsa, yangilik rasm bilan chiqadi.' }),
      published: toggleField({ label: 'Saytda ko‘rsatish', checked: n ? n.published : true }),
    };
    const form = card(n ? 'Yangilikni tahrirlash' : 'Yangi yangilik', '',
      el('div', { className: 'grid-2' }, f.title.node, f.date.node), f.text.node, f.image.node, f.published.node);
    form.addEventListener('input', () => (window.__adminDirty = true));
    const save = btn(n ? 'Saqlash' : 'E’lon qilish', (e) => busy(e.currentTarget, 'Saqlanmoqda…', async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.get()]));
      try {
        await api(n ? `/news/${n.id}` : '/news', { method: n ? 'PUT' : 'POST', body });
        toast(n ? 'Saqlandi.' : 'Yangilik qo‘shildi.');
        showList();
      } catch (err) {
        toast(err.message, 'error');
      }
    }));
    const cancel = btn('Bekor qilish', () => {
      if (window.__adminDirty && !confirm('O‘zgarishlar saqlanmaydi. Chiqasizmi?')) return;
      showList();
    }, 'btn-text');
    area.replaceChildren(form, el('div', { className: 'card-actions sticky-actions' }, save, cancel));
    f.title.input.focus();
  }

  await showList();
}
