'use strict';
/* global OqDesktop */
const q = new URLSearchParams(location.search);
const target = q.get('u') || '';
document.getElementById('why').textContent = q.get('e') ? `Sabab: ${q.get('e')}` : '';
document.getElementById('retry').addEventListener('click', () => {
  if (/^https?:\/\//.test(target)) location.href = target;
});
document.getElementById('home').addEventListener('click', () => OqDesktop.open('home'));
// internet qaytsa o'zi qayta ochadi
window.addEventListener('online', () => /^https?:\/\//.test(target) && (location.href = target));
setInterval(() => navigator.onLine && /^https?:\/\//.test(target) && fetch(target, { method: 'HEAD', mode: 'no-cors' }).then(() => (location.href = target)).catch(() => {}), 15000);
