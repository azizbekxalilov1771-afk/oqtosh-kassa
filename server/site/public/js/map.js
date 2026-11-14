import { el } from './common.js';

// Xarita: Leaflet + OpenStreetMap (kalit kerak emas). Yuklanmasa ham sahifa ishlaydi —
// joylashuv "Mening joylashuvim" tugmasi (GPS) orqali olinadi.

const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
let loading = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  loading ||= new Promise((resolve) => {
    const css = el('link', { rel: 'stylesheet', href: `${LEAFLET}leaflet.css`, integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=', crossOrigin: '' });
    const js = el('script', { src: `${LEAFLET}leaflet.js`, integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=', crossOrigin: '' });
    const timer = setTimeout(() => resolve(null), 9000);
    js.onload = () => { clearTimeout(timer); resolve(window.L || null); };
    js.onerror = () => { clearTimeout(timer); resolve(null); };
    document.head.append(css, js);
  }).then((L) => {
    if (!L) loading = null; // keyingi safar yana urinib ko'radi
    return L;
  });
  return loading;
}

const tiles = (L) => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const pin = (L, cls, html = '') => L.divIcon({ className: `map-pin ${cls}`, html, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] });

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Bu qurilma joylashuvni aniqlay olmaydi.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Joylashuvga ruxsat berilmadi. Brauzer sozlamalarida ruxsat bering yoki xaritadan belgilang.' : 'Joylashuv aniqlanmadi. Xaritadan belgilang.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

// Mijoz manzilini belgilash: xaritani bosish yoki pinni surish; GPS tugmasi
export function locationPicker({ origin, value, onChange }) {
  const box = el('div', { className: 'map-box' });
  const status = el('p', { className: 'map-status muted small', ariaLive: 'polite' });
  const gps = el('button', { type: 'button', className: 'btn btn-ghost btn-small map-gps', textContent: '📍 Mening joylashuvim' });
  const wrap = el('div', { className: 'map-picker' }, box, el('div', { className: 'map-tools' }, gps, status));
  let L = null;
  let map = null;
  let marker = null;
  let current = value?.lat ? { lat: value.lat, lng: value.lng } : null;

  const paintStatus = () => {
    status.textContent = current ? `Belgilandi: ${current.lat.toFixed(5)}, ${current.lng.toFixed(5)}` : L ? 'Xaritani bosib uyingizni belgilang yoki GPS tugmasini bosing.' : 'GPS tugmasini bosing — joylashuvingiz aniqlanadi.';
    wrap.classList.toggle('is-set', Boolean(current));
  };
  const set = (p, { pan = true } = {}) => {
    current = { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 };
    if (map) {
      if (!marker) {
        marker = L.marker([current.lat, current.lng], { draggable: true, icon: pin(L, 'is-home', '🏠') }).addTo(map);
        marker.on('dragend', () => set(marker.getLatLng(), { pan: false }));
      } else marker.setLatLng([current.lat, current.lng]);
      if (pan) map.setView([current.lat, current.lng], Math.max(map.getZoom(), 16));
    }
    paintStatus();
    onChange?.(current);
  };

  gps.addEventListener('click', async () => {
    gps.disabled = true;
    gps.textContent = 'Aniqlanmoqda…';
    try {
      set(await getPosition());
    } catch (e) {
      status.textContent = e.message;
    } finally {
      gps.disabled = false;
      gps.textContent = '📍 Mening joylashuvim';
    }
  });

  loadLeaflet().then((lib) => {
    if (!lib) {
      box.classList.add('is-fallback');
      box.replaceChildren(el('p', { className: 'map-fallback', textContent: 'Xarita yuklanmadi. GPS tugmasini bosing — manzilingiz aniqlanadi.' }));
      return paintStatus();
    }
    L = lib;
    const center = current || origin || { lat: 41.31, lng: 69.28 };
    map = L.map(box, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], current ? 16 : 14);
    tiles(L).addTo(map);
    if (origin) L.marker([origin.lat, origin.lng], { icon: pin(L, 'is-shop', '🍽'), interactive: false }).addTo(map);
    map.on('click', (e) => set(e.latlng, { pan: false }));
    if (current) set(current);
    setTimeout(() => map.invalidateSize(), 60);
    paintStatus();
  });
  paintStatus();
  return { node: wrap, get value() { return current; }, set, refresh: () => setTimeout(() => map?.invalidateSize(), 60) };
}

// Kuryer: barcha manzillar bitta xaritada
export function pointsMap(points, { origin, onPick } = {}) {
  const box = el('div', { className: 'map-box is-tall' });
  loadLeaflet().then((L) => {
    if (!L) return box.classList.add('is-fallback'), box.replaceChildren(el('p', { className: 'map-fallback', textContent: 'Xarita yuklanmadi — pastdagi tugmalar orqali navigatorda oching.' }));
    const map = L.map(box);
    tiles(L).addTo(map);
    const all = [];
    if (origin) {
      L.marker([origin.lat, origin.lng], { icon: pin(L, 'is-shop', '🍽'), interactive: false }).addTo(map);
      all.push([origin.lat, origin.lng]);
    }
    for (const p of points) {
      const m = L.marker([p.lat, p.lng], { icon: pin(L, p.mine ? 'is-mine' : 'is-order', `<b>${p.label}</b>`) }).addTo(map);
      if (onPick) m.on('click', () => onPick(p));
      all.push([p.lat, p.lng]);
    }
    if (all.length > 1) map.fitBounds(all, { padding: [36, 36], maxZoom: 16 });
    else map.setView(all[0] || [41.31, 69.28], all.length ? 15 : 12);
    setTimeout(() => map.invalidateSize(), 60);
  });
  return box;
}

// Navigatorda ochish: Google Maps, Yandex Navigator, Yandex Xaritalar, telefondagi boshqa ilova
export function navLinks(lat, lng) {
  const ll = `${lat},${lng}`;
  return [
    ['Google Maps', `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`],
    ['Yandex Navigator', `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lng}`],
    ['Yandex Xarita', `https://yandex.uz/maps/?rtext=~${ll}&rtt=auto`],
    ['Boshqa ilova', `geo:${ll}?q=${ll}`],
  ];
}
