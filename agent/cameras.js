'use strict';
// Kameralar — restoran tarmog'idagi Hikvision / HiLook videoregistratorlari (NVR) va kameralari.
//   Topish:  SADP (Hikvision'ning o'z qidiruv protokoli, UDP 37020) + 8000-port bo'yicha qidiruv (zaxira) + qo'lda IP.
//   Ulash:   ISAPI (HTTP, Digest) — videoregistratorning ichki login/paroli (Hik-Connect / HiLook ilovasi paroli emas).
//   Rasm:    /ISAPI/Streaming/channels/<kanal>02/picture — kichik oqimdan bitta JPEG.
// Video internetga chiqmaydi: hammasi shu kompyuterda. Saytga faqat kamera nomlari va qaysi stolga qaragani yuboriladi.
// Parollar shu kompyuterda shifrlangan holda saqlanadi (Windows: safeStorage / DPAPI).

const http = require('node:http');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SADP_PORT = 37020;
const SADP_GROUP = '239.255.255.250';

function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !/^169\.254\./.test(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

const xmlUnescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (x, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(x);
  return m ? xmlUnescape(m[1].trim()) : '';
};
const blocks = (x, name) => [...String(x).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1]);
const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const cleanMac = (m) => String(m || '').toUpperCase().replace(/[^0-9A-F]/g, '');
const fail = (code, message) => Object.assign(new Error(message), { code });

/* ───────── topish ───────── */

function parseProbe(x) {
  return {
    ip: tag(x, 'IPv4Address'),
    model: tag(x, 'DeviceDescription'),
    serial: tag(x, 'DeviceSN'),
    mac: cleanMac(tag(x, 'MAC')),
    httpPort: Number(tag(x, 'HttpPort')) || 80,
    activated: tag(x, 'Activated') !== 'false',
    channels: (Number(tag(x, 'DigitalChannelNum')) || 0) + (Number(tag(x, 'AnalogChannelNum')) || 0),
    firmware: tag(x, 'SoftwareVersion'),
    via: 'sadp',
  };
}

// SADP: so'rov multicast/broadcast'ga yuboriladi, qurilmalar 37020-portga (yoki so'ragan manzilga) javob beradi
function sadp({ timeout = 2500, targets = [SADP_GROUP, '255.255.255.255'], port = SADP_PORT, bindPort = port } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock?.close();
      } catch {}
      resolve([...found.values()]);
    };
    const onMessage = (buf) => {
      const x = buf.toString('utf8');
      if (!/<ProbeMatch/i.test(x)) return;
      const d = parseProbe(x);
      if (IP_RE.test(d.ip)) found.set(d.ip, d);
    };
    const probe = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${crypto.randomUUID().toUpperCase()}</Uuid><Types>inquiry</Types></Probe>`);
    const start = (listenPort) => {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', onMessage);
      sock.once('error', () => {
        // 37020 band (masalan, SADP Tool ochiq) — tasodifiy portdan so'raymiz, javob shu portga keladi
        if (listenPort !== 0) {
          try {
            sock.close();
          } catch {}
          start(0);
        } else finish();
      });
      sock.bind(listenPort, () => {
        try {
          sock.setBroadcast(true);
        } catch {}
        const ifaces = localIPv4();
        for (const ip of ifaces) {
          try {
            sock.addMembership(SADP_GROUP, ip);
          } catch {}
        }
        for (const t of targets) {
          if (t === SADP_GROUP && ifaces.length) {
            for (const ip of ifaces) {
              try {
                sock.setMulticastInterface(ip);
              } catch {}
              sock.send(probe, port, t, () => {});
            }
          } else sock.send(probe, port, t, () => {});
        }
        setTimeout(finish, timeout);
      });
    };
    start(bindPort);
  });
}

function probePort(ip, port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    let done = false;
    const end = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n]);
    }
  }));
  return out;
}

// Zaxira: SADP javob bermasa (boshqa VLAN, o'chirilgan) — 8000 (Hikvision SDK) porti ochiq qurilmalar
async function portScan({ hosts, port = 8000 } = {}) {
  const list = hosts || localIPv4().flatMap((me) => {
    const net3 = me.split('.').slice(0, 3).join('.');
    return Array.from({ length: 254 }, (_, i) => `${net3}.${i + 1}`).filter((x) => x !== me);
  });
  const open = (await pool(list, 64, async (ip) => ((await probePort(ip, port)) ? ip : null))).filter(Boolean);
  return open.map((ip) => ({ ip, model: '', serial: '', mac: '', httpPort: 80, activated: true, channels: 0, via: 'port' }));
}

async function discover(opts = {}) {
  const [a, b] = await Promise.all([sadp(opts.sadp), opts.portScan === false ? [] : portScan(opts.scan).catch(() => [])]);
  const out = new Map(a.map((d) => [d.ip, d]));
  for (const d of b) if (!out.has(d.ip)) out.set(d.ip, d);
  return [...out.values()].sort((x, y) => x.ip.localeCompare(y.ip, 'en', { numeric: true }));
}

/* ───────── ISAPI (HTTP Digest) ───────── */

function rawRequest({ ip, port, timeout }, pathname, method, auth) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port, path: pathname, method, timeout, headers: { ...(auth ? { Authorization: auth } : {}), Accept: '*/*' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 15 * 1024 * 1024) req.destroy(fail('big', 'Javob juda katta'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fail('net', 'Videoregistrator javob bermadi')));
    req.on('error', (e) => reject(e.code === 'net' || e.code === 'big' ? e : fail('net', `Videoregistratorga ulanib bo‘lmadi (${e.code || e.message}). IP manzil to‘g‘rimi va kompyuter shu tarmoqdami?`)));
    req.end();
  });
}

function parseChallenges(rawHeaders) {
  const list = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== 'www-authenticate') continue;
    const v = rawHeaders[i + 1];
    const scheme = v.split(/\s+/)[0].toLowerCase();
    const params = {};
    for (const m of v.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) params[m[1].toLowerCase()] = m[2] ?? m[3];
    list.push({ scheme, ...params });
  }
  // eng mos keladigani: Digest MD5 → Digest SHA-256 → Basic
  const digest = list.filter((c) => c.scheme === 'digest' && c.nonce);
  return digest.find((c) => !c.algorithm || /^md5/i.test(c.algorithm)) || digest.find((c) => /^sha-256/i.test(c.algorithm)) || list.find((c) => c.scheme === 'basic') || null;
}

class Isapi {
  constructor({ ip, port = 80, user, pass, timeout = 8000 }) {
    Object.assign(this, { ip, port: Number(port) || 80, user: String(user || ''), pass: String(pass || ''), timeout });
    this.ch = null;
    this.nc = 0;
  }

  auth(method, uri) {
    const c = this.ch;
    if (!c) return null;
    if (c.scheme === 'basic') return `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}`;
    const algo = /^sha-256/i.test(c.algorithm || '') ? 'sha256' : 'md5';
    const H = (s) => crypto.createHash(algo).update(s).digest('hex');
    const qop = c.qop ? (c.qop.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null) : null;
    const nc = (++this.nc).toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = H(`${this.user}:${c.realm}:${this.pass}`);
    const ha2 = H(`${method}:${uri}`);
    const response = qop ? H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`);
    const q = (s) => String(s).replace(/["\\]/g, '\\$&');
    let h = `Digest username="${q(this.user)}", realm="${q(c.realm)}", nonce="${q(c.nonce)}", uri="${uri}", response="${response}"`;
    if (c.algorithm) h += `, algorithm=${c.algorithm}`;
    if (c.opaque) h += `, opaque="${q(c.opaque)}"`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    return h;
  }

  // Noto'g'ri parol bilan qayta-qayta urinilmaydi: videoregistrator 5–7 xatodan keyin 30 daqiqaga bloklaydi
  async request(uri, { binary = false, method = 'GET' } = {}) {
    let r = await rawRequest(this, uri, method, this.auth(method, uri));
    if (r.status === 401) {
      const ch = parseChallenges(r.rawHeaders);
      if (!ch) throw fail('auth', 'Videoregistrator kirish usulini aytmadi (ISAPI o‘chirilgan bo‘lishi mumkin)');
      // birinchi so'rov parolsiz yoki eskirgan nonce bilan edi — yangi nonce bilan faqat bir marta
      this.ch = ch;
      this.nc = 0;
      r = await rawRequest(this, uri, method, this.auth(method, uri));
      if (r.status === 401) {
        this.ch = null;
        const body = r.body.toString('utf8');
        if (/lock/i.test(body)) throw fail('locked', 'Videoregistrator bu foydalanuvchini vaqtincha blokladi (ko‘p noto‘g‘ri parol). 30 daqiqadan keyin urinib ko‘ring.');
        throw fail('login', 'Login yoki parol noto‘g‘ri. Bu Hik-Connect/HiLook ilovasi paroli emas — videoregistratorning o‘z foydalanuvchisi kerak.');
      }
    }
    if (r.status === 403) throw fail('forbidden', 'Bu foydalanuvchiga ruxsat yo‘q — videoregistratorda “Remote Live View” ruxsatini bering.');
    if (r.status === 404) throw fail('notfound', `Topilmadi: ${uri}`);
    if (r.status !== 200) throw fail('http', `Videoregistrator xatosi: HTTP ${r.status}`);
    return binary ? r.body : r.body.toString('utf8');
  }
}

async function deviceInfo(api) {
  const x = await api.request('/ISAPI/System/deviceInfo');
  return { name: tag(x, 'deviceName'), model: tag(x, 'model'), serial: tag(x, 'serialNumber'), firmware: tag(x, 'firmwareVersion'), type: tag(x, 'deviceType'), mac: cleanMac(tag(x, 'macAddress')) };
}

// NVR — IP kanallar (InputProxy); DVR/gibrid — analog kirishlar; bitta IP kamera — 1 kanal
async function listChannels(api) {
  const out = new Map();
  const soft = (e) => {
    if (['login', 'locked', 'net', 'forbidden'].includes(e.code)) throw e;
  };
  try {
    const x = await api.request('/ISAPI/ContentMgmt/InputProxy/channels');
    for (const b of blocks(x, 'InputProxyChannel')) {
      const id = Number(tag(b, 'id'));
      if (id > 0) out.set(id, { ch: id, name: tag(b, 'name') || `Kamera ${id}`, camIp: tag(b, 'ipAddress'), kind: 'ip', online: null });
    }
  } catch (e) {
    soft(e);
  }
  if (out.size) {
    try {
      const x = await api.request('/ISAPI/ContentMgmt/InputProxy/channels/status');
      for (const b of blocks(x, 'InputProxyChannelStatus')) {
        const c = out.get(Number(tag(b, 'id')));
        if (c) c.online = tag(b, 'online') === 'true';
      }
    } catch (e) {
      soft(e);
    }
  }
  try {
    const x = await api.request('/ISAPI/System/Video/inputs/channels');
    for (const b of blocks(x, 'VideoInputChannel')) {
      const id = Number(tag(b, 'id'));
      if (id > 0 && !out.has(id) && tag(b, 'videoInputEnabled') !== 'false') out.set(id, { ch: id, name: tag(b, 'name') || `Kamera ${id}`, camIp: '', kind: 'analog', online: true });
    }
  } catch (e) {
    soft(e);
  }
  return [...out.values()].sort((a, b) => a.ch - b.ch);
}

async function snapshot(api, ch) {
  let last = null;
  api.streams ||= new Map(); // qaysi oqim rasm bergani eslab qolinadi — keyingi safar bitta so'rov
  const known = api.streams.get(ch);
  for (const stream of known ? [known] : [`${ch}02`, `${ch}01`]) {
    try {
      const b = await api.request(`/ISAPI/Streaming/channels/${stream}/picture`, { binary: true });
      if (b.length > 200 && b[0] === 0xff && b[1] === 0xd8) {
        api.streams.set(ch, stream);
        return b;
      }
    } catch (e) {
      if (['login', 'locked', 'net'].includes(e.code)) throw e;
      last = e;
    }
  }
  api.streams.delete(ch);
  throw fail('snapshot', last?.code === 'forbidden' ? last.message : 'Rasm olinmadi — kamera o‘chiq yoki videoregistratorga ulanmagan.');
}

/* ───────── saqlash: videoregistratorlar, kanallar, kabina = stol ───────── */

const PLACES = ['table', 'kassa', 'zal', ''];

class CameraStore {
  /** @param {{ file: string, encrypt: (s: string) => string, decrypt: (s: string) => string, onChange?: () => void }} o */
  constructor(o) {
    this.o = o;
    this.data = { nvrs: [], places: {} };
    this.apis = new Map();
    try {
      const d = JSON.parse(fs.readFileSync(o.file, 'utf8'));
      if (Array.isArray(d.nvrs)) this.data.nvrs = d.nvrs;
      if (d.places && typeof d.places === 'object') this.data.places = d.places;
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
    fs.writeFileSync(this.o.file, JSON.stringify(this.data, null, 2));
    this.o.onChange?.();
  }

  nvr(id) {
    const n = this.data.nvrs.find((x) => x.id === id);
    if (!n) throw fail('notfound', 'Videoregistrator topilmadi');
    return n;
  }

  api(n) {
    let a = this.apis.get(n.id);
    if (!a || a.ip !== n.ip || a.port !== n.port) {
      a = new Isapi({ ip: n.ip, port: n.port, user: n.user, pass: this.o.decrypt(n.pass) });
      this.apis.set(n.id, a);
    }
    return a;
  }

  /** Oynaga — parollarsiz */
  state() {
    return {
      nvrs: this.data.nvrs.map(({ pass, ...n }) => ({ ...n, channels: (n.channels || []).map((c) => ({ ...c, ...(this.data.places[`${n.id}:${c.ch}`] || { place: '' }) })) })),
    };
  }

  async connect({ ip, port = 80, user, pass }) {
    ip = String(ip || '').trim();
    if (!IP_RE.test(ip)) throw fail('input', 'IP manzilni to‘g‘ri yozing (masalan 192.168.1.64)');
    if (!String(user || '').trim() || !String(pass || '')) throw fail('input', 'Login va parolni yozing');
    const api = new Isapi({ ip, port, user: String(user).trim(), pass });
    const info = await deviceInfo(api);
    const channels = await listChannels(api);
    const id = info.serial || info.mac || ip;
    const prev = this.data.nvrs.find((x) => x.id === id || x.ip === ip);
    const n = {
      id, ip, port: api.port, user: api.user, pass: this.o.encrypt(String(pass)),
      name: info.name || prev?.name || '', model: info.model || prev?.model || '', serial: info.serial, mac: info.mac, firmware: info.firmware, type: info.type,
      channels, connectedAtMs: Date.now(), error: '',
    };
    this.data.nvrs = [...this.data.nvrs.filter((x) => x !== prev), n];
    this.apis.set(id, api);
    this.save();
    return this.state().nvrs.find((x) => x.id === id);
  }

  async refresh(id) {
    const n = this.nvr(id);
    try {
      n.channels = await listChannels(await this.reach(n));
      n.error = '';
    } catch (e) {
      n.error = e.message;
      throw e;
    } finally {
      this.save();
    }
    return this.state().nvrs.find((x) => x.id === id);
  }

  // DHCP bilan IP o'zgarib qolsa — seriya raqami/MAC bo'yicha qayta topiladi
  async reach(n) {
    const api = this.api(n);
    try {
      await api.request('/ISAPI/System/time');
      return api;
    } catch (e) {
      if (e.code !== 'net') throw e;
      const found = (await sadp().catch(() => [])).find((d) => (n.serial && d.serial === n.serial) || (n.mac && d.mac === n.mac));
      if (!found || found.ip === n.ip) throw e;
      n.ip = found.ip;
      n.port = found.httpPort || n.port;
      this.save();
      return this.api(n);
    }
  }

  async snapshot(id, ch) {
    const n = this.nvr(id);
    try {
      return await snapshot(this.api(n), Number(ch));
    } catch (e) {
      if (e.code !== 'net') throw e;
      return snapshot(await this.reach(n), Number(ch));
    }
  }

  setPlace(id, ch, { place = '', tableId = '', label = '' } = {}) {
    const n = this.nvr(id);
    if (!(n.channels || []).some((c) => c.ch === Number(ch))) throw fail('notfound', 'Kanal topilmadi');
    if (!PLACES.includes(place)) throw fail('input', 'Joy noto‘g‘ri');
    if (place === 'table' && !String(tableId)) throw fail('input', 'Stolni tanlang');
    const key = `${id}:${Number(ch)}`;
    if (!place) delete this.data.places[key];
    else this.data.places[key] = { place, tableId: place === 'table' ? String(tableId).slice(0, 80) : '', label: String(label || '').slice(0, 80) };
    this.save();
    return this.data.places[key] || { place: '' };
  }

  remove(id) {
    this.data.nvrs = this.data.nvrs.filter((x) => x.id !== id);
    for (const k of Object.keys(this.data.places)) if (k.startsWith(`${id}:`)) delete this.data.places[k];
    this.apis.delete(id);
    this.save();
  }

  /** Saytga (owner hisobotlari uchun): parol, IP va rasm yo'q — faqat nomlar va joylar */
  summary() {
    return this.data.nvrs.flatMap((n) => (n.channels || []).map((c) => {
      const p = this.data.places[`${n.id}:${c.ch}`] || {};
      return { key: `${n.id}:${c.ch}`, nvr: n.name || n.model || 'NVR', model: n.model || '', ch: c.ch, name: c.name, online: c.online !== false, place: p.place || '', tableId: p.tableId || '', label: p.label || '' };
    }));
  }
}

module.exports = { discover, sadp, portScan, parseProbe, Isapi, deviceInfo, listChannels, snapshot, CameraStore, localIPv4 };
