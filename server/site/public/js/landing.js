import { $, $$, el, api, phoneHref, handle, fmtDate, applyInfo, wireOrderLinks, drawLagan, setYear, safeHref } from './common.js';

// Landing: logo (birinchi qism) doim tepada, qolgan bo'limlar admin paneldagi tartibda.
setYear();
drawLagan($('#lagan'));

const ANCHOR = { news: 'yangiliklar', about: 'biz-haqimizda', contact: 'boglanish', locations: 'manzillar' };
const linkProps = (href) => (/^https?:\/\//.test(href) ? { href, target: '_blank', rel: 'noopener' } : { href });

function heading(title, id) {
  return el('h2', { id, textContent: title });
}

/* ───────── Tayyor bo'limlar ───────── */
function newsItem(n) {
  const text = el('p', { className: 'news-text', textContent: n.text });
  const article = el('article', { className: `news-item${n.image ? ' has-image' : ''}` });
  if (n.image) {
    const img = el('img', { src: n.image, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => { img.remove(); article.classList.remove('has-image'); });
    article.append(img);
  }
  article.append(n.date ? el('time', { dateTime: n.date, textContent: fmtDate(n.date) }) : '', el('h3', { textContent: n.title }), text);
  if (n.text.length > 220) {
    text.classList.add('is-clamped');
    const more = el('button', { type: 'button', className: 'news-more', textContent: 'Davomini o‘qish' });
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      const open = !text.classList.toggle('is-clamped');
      more.textContent = open ? 'Yig‘ish' : 'Davomini o‘qish';
      more.setAttribute('aria-expanded', String(open));
    });
    article.append(more);
  }
  return article;
}

function newsSection(s, { news }) {
  if (!news.length) return null;
  return el('section', { className: 'block news', id: ANCHOR.news },
    heading(s.title, 'news-title'), el('div', { className: 'news-list' }, news.map(newsItem)));
}

function aboutSection(s, { info }) {
  const facts = [];
  const add = (dt, dd) => dd && facts.push(el('div', {}, el('dt', { textContent: dt }), el('dd', { textContent: dd })));
  if (info.hours?.length) add('Ish vaqti', info.hours.map((h) => `${h.days}: ${h.time}`).join('\n'));
  add('Yetkazib berish', info.delivery);
  add('To‘lov', info.payment);
  add('Banket va to‘ylar', info.banquet);
  if (!info.about && !info.features?.length && !facts.length) return null;
  return el('section', { className: 'block about', id: ANCHOR.about },
    heading(s.title),
    el('div', { className: 'about-body' },
      info.about && el('p', { className: 'about-text', textContent: info.about }),
      info.features?.length ? el('ul', { className: 'features' }, info.features.map((f) => el('li', { textContent: f }))) : '',
      facts.length ? el('dl', { className: 'facts' }, facts) : ''));
}

function contactSection(s, { info }) {
  const rows = [];
  const row = (label, value, href, external) =>
    rows.push(el('li', {}, el('a', { href, ...(external ? { target: '_blank', rel: 'noopener' } : {}) },
      el('span', { className: 'contact-label', textContent: label }),
      el('span', { className: 'contact-value', textContent: value }))));
  if (info.phone) row('Telefon', info.phone, phoneHref(info.phone));
  if (info.phone2) row('Qo‘shimcha telefon', info.phone2, phoneHref(info.phone2));
  if (info.telegram) { const h = handle(info.telegram, 't\\.me'); row('Telegram', `@${h}`, `https://t.me/${h}`, true); }
  if (info.instagram) { const h = handle(info.instagram, 'instagram\\.com'); row('Instagram', `@${h}`, `https://instagram.com/${h}`, true); }
  if (!rows.length) return null;
  return el('section', { className: 'block contact', id: ANCHOR.contact }, heading(s.title), el('ul', { className: 'contact-rows' }, rows));
}

function locationCard(loc) {
  const hasCoords = loc.lat !== '' && loc.lng !== '' && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng)) && loc.lat !== undefined;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  const q = encodeURIComponent(loc.address || '');
  const yandex = hasCoords ? `https://yandex.uz/maps/?pt=${lng},${lat}&z=17&l=map` : q && `https://yandex.uz/maps/?text=${q}`;
  const google = hasCoords ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : q && `https://www.google.com/maps/search/?api=1&query=${q}`;
  const card = el('article', { className: `location${hasCoords ? '' : ' no-map'}` },
    el('div', { className: 'location-info' },
      el('h3', { textContent: loc.name || 'Manzil' }),
      loc.address && el('p', { className: 'location-address', textContent: loc.address }),
      loc.landmark && el('p', { className: 'location-meta', textContent: `Mo‘ljal: ${loc.landmark}` }),
      loc.hours && el('p', { className: 'location-meta', textContent: `Ish vaqti: ${loc.hours}` }),
      loc.phone && el('p', { className: 'location-meta' }, 'Telefon: ', el('a', { href: phoneHref(loc.phone), textContent: loc.phone })),
      el('div', { className: 'location-actions' },
        yandex && el('a', { className: 'btn btn-small', href: yandex, target: '_blank', rel: 'noopener', textContent: 'Yandex xaritada' }),
        google && el('a', { className: 'btn btn-small btn-ghost', href: google, target: '_blank', rel: 'noopener', textContent: 'Google xaritada' }))));
  if (hasCoords) {
    card.append(el('div', { className: 'location-map' }, el('iframe', {
      src: `https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`,
      title: `${loc.name || 'Manzil'} xaritada`, loading: 'lazy', referrerPolicy: 'no-referrer-when-downgrade',
    })));
  }
  return card;
}

function locationsSection(s, { info }) {
  let locations = (info.locations || []).filter((l) => l && (l.address || (l.lat !== '' && l.lng !== '')));
  if (!locations.length && info.address) locations = [{ name: info.name, address: info.address, landmark: info.landmark, phone: info.phone }];
  if (!locations.length) return null;
  return el('section', { className: 'block locations', id: ANCHOR.locations },
    heading(s.title), el('div', { className: 'location-list' }, locations.map(locationCard)));
}

/* ───────── Admin ochgan yangi bo'limlar ───────── */
function button(s, className) {
  const href = safeHref(s.buttonUrl);
  return s.buttonLabel && href ? el('a', { className, textContent: s.buttonLabel, ...linkProps(href) }) : '';
}

function textSection(s) {
  const img = s.image && el('img', { className: 'custom-image', src: s.image, alt: '', loading: 'lazy', decoding: 'async' });
  return el('section', { className: `block custom-text${img ? ` has-image image-${s.imageSide}` : ''}`, id: `b-${s.id}` },
    el('div', { className: 'custom-body' }, heading(s.title), s.text && el('p', { className: 'custom-p', textContent: s.text }), button(s, 'btn')),
    img || '');
}

function gallerySection(s) {
  if (!s.images?.length) return null;
  return el('section', { className: 'block gallery', id: `b-${s.id}` },
    heading(s.title), s.text && el('p', { className: 'gallery-text', textContent: s.text }),
    el('ul', { className: 'gallery-grid' }, s.images.map((src) => el('li', {},
      el('a', { href: src, target: '_blank', rel: 'noopener' }, el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }))))));
}

function bannerSection(s) {
  return el('section', { className: 'banner', id: `b-${s.id}` },
    el('div', { className: 'banner-inner' }, heading(s.title), s.text && el('p', { textContent: s.text }), button(s, 'btn btn-on-banner')));
}

const RENDER = {
  news: newsSection, about: aboutSection, contact: contactSection, locations: locationsSection,
  text: textSection, gallery: gallerySection, banner: bannerSection,
};

function renderHero(info) {
  if (info.phone) Object.assign($('#hero-call'), { href: phoneHref(info.phone), hidden: false });
  if (info.hours?.length) Object.assign($('#hero-hours'), { textContent: info.hours.map((h) => `${h.days}: ${h.time}`).join('\n'), hidden: false });
  document.title = info.tagline ? `${info.name} — ${info.tagline}` : info.name;
}

// Bo'limlar ekranga kirganda yumshoq paydo bo'ladi
function revealOnScroll() {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in-view');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const n of $('#sections').children) {
    n.classList.add('will-reveal');
    io.observe(n);
  }
}

// "Buyurtma berish" → tanlov: Restoranda yoki Yetkazib berish
function orderChooser(info) {
  if (/^https?:\/\//.test(info.orderUrl || '')) return; // buyurtma tashqi saytda
  let delivery = null;
  const load = () => (delivery ||= api('/api/delivery').catch(() => ({ enabled: false })));
  load();
  const option = (href, icon, title, sub, off) => el(off ? 'div' : 'a', { className: `choose-opt${off ? ' is-off' : ''}`, ...(off ? { ariaDisabled: 'true' } : { href }) },
    el('span', { className: 'choose-icon', textContent: icon, ariaHidden: 'true' }),
    el('span', { className: 'choose-main' }, el('strong', { textContent: title }), el('small', { textContent: sub })),
    el('span', { className: 'choose-go', textContent: off ? '' : '→', ariaHidden: 'true' }));
  async function open(e) {
    e.preventDefault();
    const d = await load();
    const dialog = el('dialog', { className: 'choose-sheet', ariaLabel: 'Buyurtma turi' });
    const close = el('button', { type: 'button', className: 'choose-close', textContent: '×', ariaLabel: 'Yopish', onclick: () => dialog.close() });
    dialog.append(
      el('div', { className: 'choose-head' }, el('h2', { textContent: 'Qanday buyurtma berasiz?' }), close),
      option('/buyurtma.html?restoranda', '🍽', 'Restoranda', 'Stolda o‘tirib — ofitsiant tasdiqlaydi'),
      option('/buyurtma.html?yetkazish', '🛵', 'Yetkazib berish', d.enabled ? (d.note || 'Uyingizga olib boramiz') : 'Hozircha mavjud emas', !d.enabled));
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
  }
  for (const a of $$('[data-order]')) a.addEventListener('click', open);
}

function renderSections(data) {
  const nav = [];
  const nodes = [];
  for (const s of data.sections) {
    const fn = RENDER[s.type === 'builtin' ? s.key : s.type];
    const node = fn?.(s, data);
    if (!node) continue;
    nodes.push(node);
    if (s.nav) nav.push(el('a', { href: `#${node.id}`, textContent: s.title }));
  }
  $('#sections').replaceChildren(...nodes);
  $('#nav').replaceChildren(...nav);
}

try {
  const data = await api('/api/site');
  applyInfo(data.info);
  wireOrderLinks(data.info);
  renderHero(data.info);
  renderSections(data);
  revealOnScroll();
  orderChooser(data.info);
  const info = data.info;
  const ld = { '@context': 'https://schema.org', '@type': 'Restaurant', name: info.name, url: location.origin };
  if (info.phone) ld.telephone = info.phone;
  if (info.about) ld.description = info.about;
  if (info.locations?.[0]?.address) ld.address = info.locations[0].address;
  document.head.append(el('script', { type: 'application/ld+json', textContent: JSON.stringify(ld) }));
  if (location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
} catch {
  $('#sections').replaceChildren(el('p', { className: 'block muted', textContent: 'Ma’lumotni yuklab bo‘lmadi. Sahifani yangilang.' }));
}
