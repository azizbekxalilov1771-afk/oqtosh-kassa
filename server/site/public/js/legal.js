import { $, api, applyInfo, phoneHref } from './common.js';

// Maxfiylik sahifasi: restoran nomi va telefoni
try {
  const info = await api('/api/info');
  applyInfo(info);
  if (info.phone) {
    const a = $('[data-phone-link]');
    a.href = phoneHref(info.phone);
    a.textContent = info.phone;
    $('.legal-phone').hidden = false;
  }
} catch {}
