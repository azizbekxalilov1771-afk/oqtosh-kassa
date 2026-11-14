import { el, formatPrice, modsLine } from './common.js';

// Mijoz, ofitsiant va kassa uchun umumiy: stol hisobi kartasi va miqdor yozuvi.

export const STATUS_CLASS = { yangi: 'is-wait', qabul: 'is-ok', rad: 'is-bad', bekor: 'is-muted' };
export const ROUND_LABEL = { yangi: 'Tasdiqlanmagan', qabul: 'Qabul qilingan', rad: 'Rad etilgan', bekor: 'Bekor' };
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
export const fmtKg = (q) => `${String(Math.round(q * 1000) / 1000).replace('.', ',')} kg`;
export const qtyText = (i) => (i.unit === 'kg' ? `${fmtKg(i.qty)}${i.byAmount ? ` (${formatPrice(i.byAmount)}lik)` : ''}` : `${i.qty} ×`);
export const pctText = (p) => `${String(p).replace('.', ',')}%`;

// tab: { rounds, subtotal, pending, servicePct, service, total }
export function billCard(tab, { onRound, compact = false } = {}) {
  return el('section', { className: `bill reveal${compact ? ' is-compact' : ''}` },
    el('ul', { className: 'bill-rounds' }, tab.rounds.map((o) => el('li', { className: `bill-round is-${o.status}` },
      el(onRound ? 'button' : 'div', { type: onRound ? 'button' : undefined, className: 'bill-round-head', onclick: onRound ? () => onRound(o) : undefined },
        el('strong', { textContent: `#${o.number}` }),
        el('span', { className: 'muted small', textContent: fmtTime(o.createdAt) }),
        el('span', { className: `status-chip ${STATUS_CLASS[o.status] || ''}`, textContent: ROUND_LABEL[o.status] || o.status }),
        o.takeaway && tab.kind !== 'saboy' ? el('span', { className: 'status-chip is-saboy', textContent: '🥡 saboy' }) : '',
        el('span', { className: 'bill-round-sum', textContent: formatPrice(o.total) })),
      el('ul', { className: 'bill-items' }, o.items.map((i) => el('li', {},
        el('span', { textContent: `${qtyText(i)} ${i.name}${i.mods?.length ? ` (${modsLine(i.mods)})` : ''}` }),
        el('span', { textContent: formatPrice(i.sum) }))),
      // olib tashlangan taomlar — chizilgan holda (jamiga kirmaydi)
      ...(o.voided || []).map((v) => el('li', { className: 'is-void' },
        el('span', { textContent: `${v.unit === 'kg' ? `${String(v.qty).replace('.', ',')} kg` : `${v.qty} ×`} ${v.name}${v.reason ? ` — ${v.reason}` : ''}` }),
        el('span', { textContent: formatPrice(v.sum) }))))))),
    el('dl', { className: 'bill-sum' },
      el('div', {}, el('dt', { textContent: 'Taomlar' }), el('dd', { textContent: formatPrice(tab.subtotal) })),
      tab.discountAmt ? el('div', {}, el('dt', { textContent: `Chegirma${tab.discount?.type === 'pct' ? ` ${pctText(tab.discount.value)}` : ''}` }), el('dd', { textContent: `−${formatPrice(tab.discountAmt)}` })) : '',
      tab.pending ? el('div', { className: 'muted' }, el('dt', { textContent: 'Tasdiqlanmagan' }), el('dd', { textContent: formatPrice(tab.pending) })) : '',
      tab.servicePct && tab.kind !== 'saboy' ? el('div', {}, el('dt', { textContent: `Xizmat haqi ${pctText(tab.servicePct)}${tab.takeaway ? ' (saboydan tashqari)' : ''}` }), el('dd', { textContent: formatPrice(tab.service) })) : '',
      el('div', { className: 'bill-total' }, el('dt', { textContent: 'Jami to‘lov' }), el('dd', { textContent: formatPrice(tab.total) }))));
}
