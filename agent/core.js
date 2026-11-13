'use strict';
// Oqtosh Kassa ichidagi printer dasturi (Node). Sayt bilan aynan .cmd dasturi kabi gaplashadi:
//   POST /api/print-agent/hello  — kompyuter va topilgan printerlar
//   GET  /api/print-agent/jobs   — navbatdagi cheklar (ESC/POS, base64)
//   POST /api/print-agent/jobs/:id — chiqdi / qayta urinish
// Tarmoqdagi printerlar 9100-port bo'yicha topiladi; USB (Windows) printerlarga RAW yoziladi (rawPrint orqali).
// "Qo'ng'iroq" (Firebase Realtime Database, SSE) bo'lsa — chek darhol, bo'lmasa har 15/60 soniyada tekshiriladi.

const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const VERSION = '2.0.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── tarmoq ───────── */

function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !/^169\.254\./.test(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

const subnetOf = (ip) => ip.split('.').slice(0, 3).join('.');

function probePort(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Butun /24 tarmoqni 9100-port bo'yicha tekshirish (+ qo'lda qo'shilgan manzillar)
async function findNetPrinters({ subnets, probe = [], own = [], port = 9100, timeout = 1500, hosts }) {
  const targets = new Map();
  for (const s of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${s}.${i}`;
      if (!own.includes(ip)) targets.set(`${ip}:${port}`, { ip, port });
    }
  }
  for (const p of hosts || []) targets.set(`${p.ip}:${p.port}`, p);
  for (const p of probe) if (p && p.ip) targets.set(`${p.ip}:${p.port || 9100}`, { ip: p.ip, port: Number(p.port) || 9100 });
  const list = [...targets.values()];
  const hits = await pool(list, 160, async (t) => ((await probePort(t.ip, t.port, timeout)) ? t : null));
  return hits.filter(Boolean);
}

// ARP jadvali: IP → MAC (Windows "arp -a": 192.168.1.50  00-11-22-33-44-55  dynamic)
function arpTable() {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const map = new Map();
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const ip = /(\d+\.\d+\.\d+\.\d+)/.exec(line);
        const mac = /([0-9a-f]{2}[-:]){5}[0-9a-f]{2}/i.exec(line);
        if (ip && mac) {
          const m = mac[0].replace(/[^0-9a-f]/gi, '').toUpperCase();
          if (m !== '000000000000' && m !== 'FFFFFFFFFFFF') map.set(ip[1], m);
        }
      }
      resolve(map);
    });
  });
}

// SNMP v1 GET sysDescr.0 — faqat o'qish; printer modelini bilish uchun (9100-portga hech narsa yuborilmaydi)
const SNMP_GET = Buffer.from([0x30, 0x29, 0x02, 0x01, 0x00, 0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0xa0, 0x1c, 0x02, 0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0e, 0x30, 0x0c, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00, 0x05, 0x00]);
const SYS_DESCR = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]);
function snmpName(ip, timeout = 700) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v) => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {}
      resolve(v);
    };
    const t = setTimeout(() => done(''), timeout);
    sock.on('error', () => done(''));
    sock.on('message', (r) => {
      const i = r.indexOf(SYS_DESCR);
      if (i < 0 || r[i + SYS_DESCR.length] !== 0x04) return done('');
      let k = i + SYS_DESCR.length + 1;
      let len = r[k];
      let start = k + 1;
      if (len === 0x81) {
        len = r[k + 1];
        start = k + 2;
      } else if (len === 0x82) {
        len = r[k + 1] * 256 + r[k + 2];
        start = k + 3;
      }
      const s = r.subarray(start, Math.min(r.length, start + len)).toString('latin1').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
      done(s.slice(0, 100));
    });
    sock.send(SNMP_GET, 161, ip, (err) => err && done(''));
  });
}

function sendNet(ip, port, data, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port: port || 9100 });
    let ok = false;
    s.setTimeout(timeout, () => {
      s.destroy();
      reject(new Error(`printer javob bermadi (${ip})`));
    });
    s.once('error', (e) => reject(new Error(`${e.code === 'ECONNREFUSED' ? 'printer ulanmadi' : e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT' ? 'printer topilmadi' : e.message} (${ip})`)));
    s.once('connect', () => {
      s.write(data, () => {
        ok = true;
        setTimeout(() => s.end(), 250);
      });
    });
    s.once('close', () => (ok ? resolve() : null));
  });
}

/* ───────── kichik ESC/POS (mahalliy sinov cheki) ───────── */
function testTicket(lines) {
  const ESC = 0x1b;
  const GS = 0x1d;
  const parts = [Buffer.from([ESC, 0x40, ESC, 0x61, 1, GS, 0x21, 0x11]), Buffer.from('SINOV\n', 'latin1'), Buffer.from([GS, 0x21, 0x00])];
  for (const l of lines) parts.push(Buffer.from(`${String(l).replace(/[^\x20-\x7e]/g, '?')}\n`, 'latin1'));
  parts.push(Buffer.from([ESC, 0x64, 4, GS, 0x56, 0x42, 0x00]));
  return Buffer.concat(parts);
}

/* ───────── dastur ───────── */

class Agent extends EventEmitter {
  // opts: { site, key, host, listWinPrinters(): Promise<[{name, port?, driver?}]>, rawPrint(name, Buffer, title), log(text, kind) }
  constructor(opts) {
    super();
    this.o = { hostName: os.hostname(), user: os.userInfo().username, ...opts };
    this.site = String(opts.site || '').replace(/\/+$/, '');
    this.key = opts.key || '';
    this.state = { running: false, online: false, error: '', keyBad: false, ring: false, printed: 0, lastJobAt: 0, lastScanAt: 0, scanning: false, printers: [], jobs: [] };
    this.poll = 15;
    this.idlePoll = 60;
    this.probe = [];
    this.ringUrl = '';
    this.ringAbort = null;
    this.wake = null;
    this.done = new Map();
    this.needScan = true;
    this.retrySoon = false;
  }

  log(text, kind = 'info') {
    this.o.log?.(text, kind);
    this.emit('log', { at: Date.now(), text, kind });
  }

  status() {
    return { ...this.state, paired: Boolean(this.key), site: this.site, version: VERSION };
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.emit('status', this.status());
  }

  async api(method, path, body) {
    const res = await fetch(this.site + path, {
      method,
      headers: { 'X-Oq-Agent': this.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  apply(r) {
    if (!r) return;
    if (typeof r.ring === 'string' && r.ring !== this.ringUrl) {
      this.ringUrl = r.ring;
      this.listenRing();
    }
    if (r.poll) this.poll = Math.max(5, Number(r.poll));
    if (r.idlePoll) this.idlePoll = Math.max(5, Number(r.idlePoll));
    if (Array.isArray(r.probe)) this.probe = r.probe;
    if (r.scan) this.needScan = true;
    if (typeof r.site === 'string' && /^https:\/\//.test(r.site) && r.site.replace(/\/+$/, '') !== this.site) {
      this.site = r.site.replace(/\/+$/, '');
      this.emit('site', this.site);
      this.log(`Sayt manzili yangilandi: ${this.site}`);
    }
  }

  async scan() {
    this.setState({ scanning: true });
    try {
      const ips = localIPv4();
      const subnets = [...new Set(ips.map(subnetOf))].slice(0, 4);
      this.log(`Printerlar qidirilmoqda: ${subnets.map((s) => `${s}.*`).join(', ') || '—'}`);
      const found = await findNetPrinters({ subnets, probe: this.probe, own: ips, timeout: this.o.scanTimeout || 1500, hosts: this.o.extraHosts });
      const arp = found.length ? await arpTable() : new Map();
      const net = [];
      for (const f of found) {
        const model = await snmpName(f.ip).catch(() => '');
        net.push({ type: 'net', ip: f.ip, port: f.port, mac: arp.get(f.ip) || '', model });
        this.log(`  Wi‑Fi/LAN printer: ${f.ip}:${f.port}${model ? `  ${model}` : ''}`, 'ok');
      }
      let win = [];
      try {
        win = ((await this.o.listWinPrinters?.()) || []).filter((p) => p?.name && !/PDF|XPS|OneNote|Fax|Send To|AnyDesk|Microsoft/i.test(p.name)).map((p) => ({ type: 'win', name: p.name, port: p.port || '', driver: p.driver || '', host: '', offline: false }));
      } catch {}
      for (const w of win) this.log(`  Windows printer: ${w.name}`, 'ok');
      if (!net.length && !win.length) this.log('  Printer topilmadi. Printer yoqilganini va shu Wi‑Fi tarmoqqa ulanganini tekshiring.', 'warn');
      this.setState({ printers: [...net, ...win], lastScanAt: Date.now() });
      return { ips, subnets, printers: [...net, ...win] };
    } finally {
      this.setState({ scanning: false });
    }
  }

  async hello(withScan) {
    const s = withScan ? await this.scan() : { ips: localIPv4(), subnets: [...new Set(localIPv4().map(subnetOf))], printers: [] };
    const r = await this.api('POST', '/api/print-agent/hello', {
      host: this.o.hostName, user: this.o.user, version: `desktop ${VERSION}`, ips: s.ips, subnets: s.subnets,
      scanned: Boolean(withScan), printers: s.printers, winRaw: Boolean(this.o.rawPrint),
    });
    this.apply(r);
    if (withScan) this.needScan = false;
    return r;
  }

  async printJob(j) {
    const where = j.printer.type === 'win' ? j.printer.name : j.printer.ip;
    if (!this.done.has(j.id)) {
      try {
        const data = Buffer.from(String(j.data || ''), 'base64');
        for (let n = 0; n < Math.max(1, Number(j.copies) || 1); n++) {
          if (j.printer.type === 'win') {
            if (!this.o.rawPrint) throw new Error('USB printerga yozib bo‘lmaydi');
            await this.o.rawPrint(j.printer.name, data, j.title || 'Oqtosh');
          } else await sendNet(j.printer.ip, Number(j.printer.port) || 9100, data);
        }
      } catch (e) {
        this.log(`XATO: ${j.title} → ${where}: ${e.message}`, 'error');
        if (j.printer.type !== 'win') this.needScan = true;
        this.retrySoon = true;
        await this.api('POST', `/api/print-agent/jobs/${encodeURIComponent(j.id)}`, { status: 'retry', error: e.message }).catch(() => {});
        return;
      }
      this.done.set(j.id, Date.now());
      this.setState({ printed: this.state.printed + 1, lastJobAt: Date.now() });
      this.log(`Chiqdi: ${j.title} → ${where}`, 'ok');
    }
    await this.api('POST', `/api/print-agent/jobs/${encodeURIComponent(j.id)}`, { status: 'done' }).catch((e) => this.log(`Saytga yozilmadi (keyin qayta): ${e.message}`, 'warn'));
  }

  async tick() {
    if (this.needScan || Date.now() - this.state.lastScanAt > 30 * 60_000) await this.hello(true);
    const r = await this.api('GET', '/api/print-agent/jobs');
    this.apply(r);
    this.retrySoon = false;
    for (const j of r.jobs || []) await this.printJob(j);
    if (this.done.size > 400) for (const [k, t] of this.done) if (Date.now() - t > 12 * 3_600_000) this.done.delete(k);
    if (this.needScan) await this.hello(true);
  }

  // Qo'ng'iroq: SSE oqimi; "put"/"patch" kelsa — kutishni uzib, darhol cheklarni olamiz
  listenRing() {
    this.ringAbort?.abort();
    this.ringAbort = null;
    this.setState({ ring: false });
    if (!this.ringUrl || !this.state.running) return;
    const ac = new AbortController();
    this.ringAbort = ac;
    (async () => {
      let fails = 0;
      while (!ac.signal.aborted && this.state.running) {
        try {
          const res = await fetch(this.ringUrl, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          this.setState({ ring: true });
          if (!fails) this.log("Qo'ng'iroq ulandi — cheklar darhol chiqadi.", 'ok');
          fails = 0;
          const dec = new TextDecoder();
          let buf = '';
          let evt = '';
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, '');
              buf = buf.slice(nl + 1);
              if (line.startsWith('event:')) evt = line.slice(6).trim();
              else if (line.startsWith('data:')) {
                if (evt === 'put' || evt === 'patch') this.kick();
                if (evt === 'cancel' || evt === 'auth_revoked') throw new Error(`ruxsat yo'q (${evt})`);
              }
            }
          }
          throw new Error('ulanish yopildi');
        } catch (e) {
          if (ac.signal.aborted) return;
          this.setState({ ring: false });
          fails++;
          if (fails === 1 || fails % 10 === 0) this.log(`Qo'ng'iroq uzildi: ${e.message} — qayta ulanadi.`, 'warn');
          this.kick();
          await sleep(Math.min(60_000, 3000 * fails));
        }
      }
    })();
  }

  kick() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  wait(sec) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, sec * 1000);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  async start() {
    if (this.state.running || !this.key) return;
    this.startedAt = Date.now();
    this.setState({ running: true, keyBad: false });
    this.log(`Printer dasturi ishga tushdi · ${this.site}`);
    let fails = 0;
    while (this.state.running) {
      try {
        await this.tick();
        if (fails) this.log('Sayt bilan aloqa tiklandi.', 'ok');
        fails = 0;
        this.setState({ online: true, error: '' });
      } catch (e) {
        fails++;
        if (e.status === 401) {
          this.setState({ online: false, keyBad: true, error: 'Kalit eskirgan — dasturni qayta ulang (admin panel → Tayyorlash joylari).' });
          this.log(this.state.error, 'error');
          this.stop();
          this.emit('unpaired');
          return;
        }
        this.setState({ online: false, error: e.message });
        if (fails <= 3 || fails % 20 === 0) this.log(`Sayt bilan aloqa yo'q: ${e.message}`, 'warn');
      }
      if (!this.state.running) break;
      const idle = Date.now() - (this.state.lastJobAt || this.startedAt || Date.now()) > 15 * 60_000;
      const sec = fails ? Math.min(60, 5 * fails) : this.retrySoon ? 20 : this.state.ring ? this.poll : idle ? this.idlePoll : this.poll;
      await this.wait(sec);
    }
  }

  stop() {
    if (!this.state.running) return;
    this.setState({ running: false, ring: false });
    this.ringAbort?.abort();
    this.ringAbort = null;
    this.kick();
  }

  async scanNow() {
    this.needScan = true;
    this.kick();
  }

  // Sayt orqali emas — to'g'ridan shu kompyuterdan sinov (printer qaysi ekanini bilish uchun)
  async testLocal(p) {
    const lines = ['', p.type === 'win' ? p.name : `${p.ip}:${p.port || 9100}`, p.model || '', new Date().toLocaleString('ru-RU'), 'Oqtosh Kassa'].filter((x) => x !== undefined);
    const data = testTicket(lines);
    if (p.type === 'win') return this.o.rawPrint(p.name, data, 'Sinov');
    return sendNet(p.ip, Number(p.port) || 9100, data);
  }
}

// Ulash: admin paneldagi 8 belgili kod → doimiy kalit
async function pair(site, code) {
  const res = await fetch(`${String(site).replace(/\/+$/, '')}/api/print-agent/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

module.exports = { Agent, pair, findNetPrinters, sendNet, snmpName, arpTable, localIPv4, testTicket, VERSION };
