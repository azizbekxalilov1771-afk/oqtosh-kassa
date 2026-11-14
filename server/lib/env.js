// .env qiymatlarini har safar chaqirilganda o'qiydi (lokal serverda .env importlardan keyin yuklanadi)
export function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || String(v).trim() === '' ? fallback : String(v).trim();
}

export function envNum(name, fallback) {
  const n = Number(env(name, ''));
  return Number.isFinite(n) && env(name, '') !== '' ? n : fallback;
}

export function envBool(name, fallback = false) {
  const v = env(name, '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'ha', 'on'].includes(v);
}

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true; // foydalanuvchiga ko'rsatsa bo'ladigan xabar
  }
}
