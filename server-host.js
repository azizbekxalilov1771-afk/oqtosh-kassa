'use strict';
// Server kompyuteri: Oqtosh sayti, admin paneli va xodim sahifalari shu kompyuterdan ishlaydi.
// Ma'lumotlar shu kompyuter diskida (Firebase/Netlify limitlari yo'q). Internetga Cloudflare Tunnel orqali chiqadi:
//   https://<domen>        → 127.0.0.1:8780 (mijozlar sayti)
//   https://admin.<domen>  → 127.0.0.1:8781 (admin panel, /xodim/ sahifalari)
// Kalitlar (Firebase, Telegram…) Windows himoyasi (DPAPI) bilan shifrlangan holda saqlanadi.

const { app, safeStorage, shell } = require('electron');
const { fork, spawn } = require('node:child_process');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SITE_PORT = 8780;
const ADMIN_PORT = 8781;
const DENY_ENV = /^(NETLIFY_|OQ_|NODE_|ELECTRON_|NPM_)|^(PATH|TELEGRAM_POLLING|TELEGRAM_API_URL|GROQ_API_URL|RTDB_TEST_URL|PUBLIC_SITE_URL|STAFF_SITE_URL|ADMIN_SITE_URL)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// .env matni → { KEY: value }
function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,60})\s*=\s*(.*)$/.exec(raw);
    if (!m || DENY_ENV.test(m[1])) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) && m[1] !== 'FIREBASE_PRIVATE_KEY') v = v.slice(1, -1);
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (!/^"/.test(v)) v = v.replace(/\s+#.*$/, '');
    if (v !== '') out[m[1]] = v;
  }
  return out;
}

class ServerHost extends EventEmitter {
  constructor({ userDir, getSettings, save }) {
    super();
    this.getSettings = getSettings; // umumiy sozlamalar (main.js) — har safar joriy obyekt
    this.saveSettings = save;
    this.dir = path.join(userDir, 'server');
    this.dataDir = path.join(this.dir, 'data');
    this.backupDir = path.join(app.getPath('documents'), 'Oqtosh zaxira');
    this.tunnelDir = path.join(this.dir, 'cloudflared');
    this.envFile = path.join(this.dir, 'kalitlar.bin');
    this.logFile = path.join(this.dir, 'server.log');
    this.serverDir = app.isPackaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, 'server');
    this.cloudflared = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'cloudflared.exe') : process.platform === 'win32' ? path.join(__dirname, 'bin', 'cloudflared.exe') : 'cloudflared';
    this.child = null;
    this.tunnel = null;
    this.stopping = false;
    this.fails = 0;
    this.pending = new Map();
    this.seq = 0;
    this.lines = [];
    this.state = { running: false, starting: false, error: '', status: null, migration: null, tunnel: { state: 'off', connections: 0, error: '', login: '' } };
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get settings() {
    return this.getSettings();
  }
  get enabled() {
    return Boolean(this.settings.server?.enabled);
  }
  get domain() {
    return String(this.settings.server?.domain || 'oqtoshrestoran.uz').toLowerCase();
  }
  urls() {
    return { site: `https://${this.domain}`, admin: `https://admin.${this.domain}`, localSite: `http://127.0.0.1:${SITE_PORT}`, localAdmin: `http://localhost:${ADMIN_PORT}` };
  }

  /* ── jurnal ── */
  log(text, kind = 'info') {
    const line = { at: Date.now(), text: String(text).slice(0, 2000), kind };
    this.lines.push(line);
    if (this.lines.length > 300) this.lines.shift();
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 5 * 1024 * 1024) fs.renameSync(this.logFile, `${this.logFile}.1`);
      fs.appendFileSync(this.logFile, `${new Date(line.at).toISOString()} ${kind.toUpperCase()} ${line.text}\n`);
    } catch {}
    this.emit('log', line);
  }
  set(patch) {
    Object.assign(this.state, patch);
    this.emit('state', this.publicState());
  }
  publicState() {
    return { ...this.state, enabled: this.enabled, domain: this.domain, urls: this.urls(), keys: this.keysInfo(), tunnelReady: this.tunnelReady(), backupDir: this.backupDir, dataDir: this.dataDir, logs: this.lines.slice(-80) };
  }

  /* ── kalitlar ── */
  loadEnv() {
    try {
      const b = fs.readFileSync(this.envFile);
      return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8'));
    } catch {
      return {};
    }
  }
  saveEnv(env) {
    const text = JSON.stringify(env);
    fs.writeFileSync(this.envFile, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8'));
  }
  keysInfo() {
    const e = this.loadEnv();
    return { ok: Boolean(e.FIREBASE_PROJECT_ID && e.FIREBASE_CLIENT_EMAIL && e.FIREBASE_PRIVATE_KEY), project: e.FIREBASE_PROJECT_ID || '', count: Object.keys(e).length, names: Object.keys(e).sort() };
  }
  // Kompyuterda oldin ochilgan oqtosh-restoran papkasidagi .env / netlify-kalitlar.env fayllarini qidirish
  findEnvFiles() {
    const home = os.homedir();
    const roots = [home, path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', 'Documents')];
    const found = [];
    for (const r of roots) {
      let list = [];
      try {
        list = fs.readdirSync(r, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of list) {
        if (!d.isDirectory() || !/^oqtosh/i.test(d.name)) continue;
        const dirs = [path.join(r, d.name)];
        try {
          for (const s of fs.readdirSync(dirs[0], { withFileTypes: true })) if (s.isDirectory() && /^oqtosh/i.test(s.name)) dirs.push(path.join(dirs[0], s.name));
        } catch {}
        for (const dir of dirs) for (const f of ['.env', 'netlify-kalitlar.env']) if (fs.existsSync(path.join(dir, f))) found.push(path.join(dir, f));
      }
    }
    return [...new Set(found)];
  }
  importEnvFiles(files) {
    const merged = { ...this.loadEnv() };
    let n = 0;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const [k, v] of Object.entries(parseEnv(text))) {
        merged[k] = v;
        n++;
      }
    }
    const info = { ok: Boolean(merged.FIREBASE_PROJECT_ID && merged.FIREBASE_CLIENT_EMAIL && merged.FIREBASE_PRIVATE_KEY) };
    if (!info.ok) throw new Error('Faylda FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL va FIREBASE_PRIVATE_KEY topilmadi. oqtosh-restoran papkasidagi .env yoki netlify-kalitlar.env faylini tanlang.');
    this.saveEnv(merged);
    this.log(`Kalitlar yuklandi: ${n} ta qiymat (${files.map((f) => path.basename(f)).join(', ')}).`, 'ok');
    this.emit('state', this.publicState());
    return this.keysInfo();
  }

  /* ── server jarayoni ── */
  async enable(on) {
    this.settings.server = { ...(this.settings.server || {}), enabled: Boolean(on) };
    this.saveSettings();
    if (on) {
      this.start();
      if (this.tunnelReady()) this.startTunnel();
    } else {
      await this.stopAll();
    }
    this.emit('mode');
    return this.publicState();
  }

  start() {
    if (this.child || !this.enabled) return;
    if (!this.keysInfo().ok) {
      this.set({ error: 'Kalitlar yuklanmagan — “Kalitlarni yuklash” tugmasini bosing.' });
      return;
    }
    const entry = path.join(this.serverDir, 'pc', 'server.mjs');
    if (!fs.existsSync(entry)) {
      this.set({ error: `Server fayllari topilmadi: ${entry}` });
      return;
    }
    // Electron bitta nusxada ishlaydi — eski (to'satdan o'chgan) qulf qolgan bo'lsa olib tashlanadi
    fs.rmSync(path.join(this.dataDir, 'LOCK'), { force: true });
    const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'PATH', 'Path', 'HOME', 'LANG'];
    const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const u = this.urls();
    Object.assign(env, this.loadEnv(), {
      ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', TZ: 'Asia/Tashkent',
      OQ_DATA_DIR: this.dataDir, OQ_BACKUP_DIR: this.backupDir, OQ_SITE_PORT: String(SITE_PORT), OQ_ADMIN_PORT: String(ADMIN_PORT),
      PUBLIC_SITE_URL: u.site, STAFF_SITE_URL: u.admin,
    });
    this.stopping = false;
    this.set({ starting: true, error: '' });
    this.log(`Server ishga tushirilmoqda (${this.serverDir})…`);
    const child = fork(entry, [], { cwd: this.serverDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true });
    this.child = child;
    const pipe = (s, kind) => {
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/^\S+Z /, '').trim();
          buf = buf.slice(i + 1);
          if (line) this.log(line, kind === 'err' || /xato|error/i.test(line) ? 'warn' : 'info');
        }
      });
    };
    pipe(child.stdout, 'out');
    pipe(child.stderr, 'err');
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'started') {
        this.fails = 0;
        this.set({ running: true, starting: false, error: '' });
        this.log('Server ishlayapti.', 'ok');
        this.emit('started');
        this.refresh();
      } else if (m.type === 'status') {
        this.set({ status: m, migration: m.migration });
      } else if (m.type === 'migration') {
        this.set({ migration: { ...(this.state.migration || {}), phase: m.phase, docs: m.docs, col: m.col } });
      } else if (m.type === 'fatal') {
        this.set({ error: m.error });
      } else if (m.type === 'reply') {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.result);
          else p.reject(new Error(m.error));
        }
      }
    });
    child.on('exit', (code) => {
      this.child = null;
      for (const p of this.pending.values()) p.reject(new Error('Server to‘xtadi'));
      this.pending.clear();
      this.set({ running: false, starting: false });
      if (this.stopping || !this.enabled) return this.log('Server to‘xtatildi.');
      this.fails++;
      const wait = code === 2 ? 30_000 : Math.min(60_000, 2000 * this.fails);
      this.log(`Server kutilmaganda to‘xtadi (kod ${code}) — ${Math.round(wait / 1000)} soniyada qayta ishga tushadi.`, 'error');
      setTimeout(() => this.start(), wait);
    });
  }

  request(type, extra = {}, timeoutMs = 120_000) {
    if (!this.child) return Promise.reject(new Error('Server ishlamayapti.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Server javob bermadi.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ type, id, ...extra });
    });
  }

  // Serverdan joriy holatni olib, oynaga yuborish (ko'chirish, zaxira, tiklashdan keyin)
  async refresh() {
    try {
      const st = await this.request('status', {}, 15_000);
      this.set({ status: st, migration: st.migration });
    } catch {}
    return this.publicState();
  }

  async stop() {
    const c = this.child;
    if (!c) return;
    this.stopping = true;
    const done = new Promise((r) => c.once('exit', r));
    try {
      c.send({ type: 'stop' });
    } catch {}
    const t = await Promise.race([done.then(() => 'ok'), sleep(20_000).then(() => 'timeout')]);
    if (t === 'timeout') {
      this.log('Server 20 soniyada to‘xtamadi — majburan yopildi.', 'warn');
      c.kill();
    }
  }

  async stopAll() {
    this.stopTunnel();
    await this.stop();
  }

  /* ── Cloudflare Tunnel ── */
  tunnelInfo() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.tunnelDir, 'tunnel.json'), 'utf8'));
    } catch {
      return null;
    }
  }
  tunnelReady() {
    const t = this.tunnelInfo();
    return Boolean(t?.id && fs.existsSync(path.join(this.tunnelDir, 'config.yml')) && fs.existsSync(t.credentials || ''));
  }

  run(args, { timeoutMs = 120_000, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.cloudflared, args, { windowsHide: true, cwd: this.tunnelDir });
      let out = '';
      const on = (d) => {
        const s = d.toString();
        out += s;
        for (const l of s.split(/\r?\n/)) if (l.trim()) onLine?.(l.trim());
      };
      p.stdout.on('data', on);
      p.stderr.on('data', on);
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error('cloudflared javob bermadi (vaqt tugadi).'));
      }, timeoutMs);
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared ishga tushmadi: ${e.message}`));
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(Object.assign(new Error(out.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || `cloudflared xato (${code})`), { out }));
      });
    });
  }

  // 1) Cloudflare'ga kirish (brauzer ochiladi, domenni tanlab "Authorize") 2) tunnel 3) DNS yozuvlari 4) sozlama
  async setupTunnel(domain) {
    const d = String(domain || this.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error('Domen noto‘g‘ri (masalan: oqtoshrestoran.uz).');
    this.settings.server = { ...(this.settings.server || {}), domain: d };
    this.saveSettings();
    fs.mkdirSync(this.tunnelDir, { recursive: true });
    const cert = path.join(this.tunnelDir, 'cert.pem');
    const defCert = path.join(os.homedir(), '.cloudflared', 'cert.pem');
    this.set({ tunnel: { ...this.state.tunnel, state: 'login', error: '', login: '' } });
    try {
      if (!fs.existsSync(cert)) {
        if (!fs.existsSync(defCert)) {
          this.log('Cloudflare: brauzerda kirish oynasi ochiladi — domenni tanlang va “Authorize” ni bosing.');
          await this.run(['tunnel', 'login'], {
            timeoutMs: 15 * 60_000,
            onLine: (l) => {
              const m = /https:\/\/dash\.cloudflare\.com\/\S+/.exec(l);
              if (m) this.set({ tunnel: { ...this.state.tunnel, login: m[0] } });
            },
          });
        }
        fs.copyFileSync(defCert, cert);
      }
      this.set({ tunnel: { ...this.state.tunnel, state: 'creating', login: '' } });
      const name = `oqtosh-${d.replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;
      const creds = path.join(this.tunnelDir, 'tunnel-creds.json');
      const out = await this.run(['tunnel', '--origincert', cert, 'create', '--credentials-file', creds, name]);
      const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1];
      if (!id) throw new Error(`Tunnel yaratilmadi: ${out.slice(-200)}`);
      const hosts = [d, `www.${d}`, `admin.${d}`];
      for (const h of hosts) {
        await this.run(['tunnel', '--origincert', cert, 'route', 'dns', '--overwrite-dns', id, h]);
        this.log(`Cloudflare DNS: ${h} → shu kompyuter`, 'ok');
      }
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const rule = (h, port) => `  - hostname: ${h}\n    service: http://127.0.0.1:${port}\n    originRequest:\n      httpHostHeader: ${h}\n`;
      const yml = `tunnel: ${id}\ncredentials-file: ${q(creds)}\nno-autoupdate: true\noriginRequest:\n  connectTimeout: 10s\ningress:\n${rule(d, SITE_PORT)}${rule(`www.${d}`, SITE_PORT)}${rule(`admin.${d}`, ADMIN_PORT)}  - service: http_status:404\n`;
      fs.writeFileSync(path.join(this.tunnelDir, 'config.yml'), yml);
      fs.writeFileSync(path.join(this.tunnelDir, 'tunnel.json'), JSON.stringify({ id, name, domain: d, hosts, credentials: creds, createdAt: new Date().toISOString() }, null, 2));
      this.log(`Cloudflare Tunnel tayyor: ${name}`, 'ok');
      this.set({ tunnel: { ...this.state.tunnel, state: 'starting', error: '' } });
      this.startTunnel();
      return this.publicState();
    } catch (e) {
      this.set({ tunnel: { ...this.state.tunnel, state: 'error', error: String(e.message).slice(0, 300), login: '' } });
      this.log(`Cloudflare: ${e.message}`, 'error');
      throw e;
    }
  }

  startTunnel() {
    if (this.tunnel || !this.enabled || !this.tunnelReady()) return;
    const p = spawn(this.cloudflared, ['tunnel', '--no-autoupdate', '--config', path.join(this.tunnelDir, 'config.yml'), 'run'], { windowsHide: true, cwd: this.tunnelDir });
    this.tunnel = p;
    let conns = 0;
    this.set({ tunnel: { ...this.state.tunnel, state: 'starting', connections: 0, error: '' } });
    const on = (d) => {
      for (const l of d.toString().split(/\r?\n/)) {
        if (!l.trim()) continue;
        if (/Registered tunnel connection/i.test(l)) conns++;
        else if (/Unregistered tunnel connection|Connection terminated|lost connection/i.test(l)) conns = Math.max(0, conns - 1);
        if (/ERR|error/i.test(l) && !/Registered/.test(l)) this.log(`cloudflared: ${l.replace(/^\S+\s+/, '')}`, 'warn');
        this.set({ tunnel: { ...this.state.tunnel, state: conns > 0 ? 'on' : 'starting', connections: conns } });
      }
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    p.on('error', (e) => this.set({ tunnel: { ...this.state.tunnel, state: 'error', error: e.message } }));
    p.on('exit', (code) => {
      this.tunnel = null;
      this.set({ tunnel: { ...this.state.tunnel, state: 'off', connections: 0 } });
      if (!this.enabled || this.stopping) return;
      this.log(`Cloudflare Tunnel to‘xtadi (kod ${code}) — 10 soniyada qayta ulanadi.`, 'warn');
      setTimeout(() => this.startTunnel(), 10_000);
    });
  }

  stopTunnel() {
    const p = this.tunnel;
    this.tunnel = null;
    if (p) {
      p.removeAllListeners('exit');
      p.kill();
    }
    this.set({ tunnel: { ...this.state.tunnel, state: 'off', connections: 0 } });
  }

  openBackups() {
    fs.mkdirSync(this.backupDir, { recursive: true });
    return shell.openPath(this.backupDir);
  }
  openLog() {
    return shell.openPath(this.logFile);
  }
}

module.exports = { ServerHost, parseEnv, SITE_PORT, ADMIN_PORT };
