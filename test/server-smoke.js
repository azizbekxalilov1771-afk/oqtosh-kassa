'use strict';
// Server kompyuteri tekshiruvi (Electron'siz): server ishga tushadi, sahifa beradi, ma'lumotni diskka yozadi,
// to'xtatib qayta ishga tushirilganda ma'lumot joyida. GitHub Actions'da Windows'da ishlaydi.
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const entry = path.join(__dirname, '..', 'server', 'pc', 'server.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-smoke-'));
const env = { ...process.env, OQ_DATA_DIR: path.join(base, 'data'), OQ_BACKUP_DIR: path.join(base, 'zaxira'), OQ_SITE_PORT: '18780', OQ_ADMIN_PORT: '18781', FIREBASE_PROJECT_ID: '', FIREBASE_PRIVATE_KEY: '', SECRETS_KEY: 'smoke-test-secret' };
const S = 'http://127.0.0.1:18780';
const A = 'http://127.0.0.1:18781';

function start() {
  return new Promise((resolve, reject) => {
    const c = fork(entry, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => reject(new Error(`ishga tushmadi:\n${out}`)), 30_000);
    c.on('message', (m) => {
      if (m.type === 'started') {
        clearTimeout(t);
        resolve(c);
      }
    });
    c.on('exit', (code) => reject(new Error(`chiqdi (${code}):\n${out}`)));
  });
}
const ask = (c, type) => new Promise((resolve) => {
  const id = Math.random();
  const on = (m) => {
    if (m.type === 'reply' && m.id === id) {
      c.off('message', on);
      resolve(m);
    }
  };
  c.on('message', on);
  c.send({ type, id });
});
const stop = (c) => new Promise((resolve) => {
  c.removeAllListeners('exit');
  c.once('exit', resolve);
  c.send({ type: 'stop' });
});
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
  console.log(`OK: ${msg}`);
};

(async () => {
  let c = await start();
  let r = await fetch(`${S}/api/pc/ping`);
  must((await r.json()).ready === false, 'yangi baza — texnik ishlar rejimi');
  r = await fetch(`${S}/`);
  must(r.status === 503, 'texnik ishlar sahifasi (503)');
  must((await ask(c, 'fresh')).ok, 'bo‘sh baza bilan boshlash');
  r = await fetch(`${S}/`);
  must(r.status === 200 && (await r.text()).includes('<html'), 'sayt bosh sahifasi');
  r = await fetch(`${A}/xodim/kassa.html`);
  must(r.status === 200, 'admin: kassa sahifasi');
  const b = await ask(c, 'backup');
  must(b.ok && fs.existsSync(b.result.file), 'zaxira fayli yozildi');
  must((await stop(c)) === 0, 'toza to‘xtadi');
  c = await start();
  r = await fetch(`${S}/api/pc/ping`);
  must((await r.json()).ready === true, 'qayta ishga tushganda holat saqlangan (diskdan)');
  await stop(c);
  fs.rmSync(base, { recursive: true, force: true });
  console.log('OK: server tekshiruvi o‘tdi');
  process.exit(0);
})().catch((e) => {
  console.error('XATO:', e.message);
  process.exit(1);
});
