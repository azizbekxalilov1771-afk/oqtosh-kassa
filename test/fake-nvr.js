'use strict';
// Sinov uchun soxta Hikvision/HiLook videoregistratori: ISAPI (Digest MD5), kanallar, JPEG rasm, SADP javobi, bloklash.
//   node test/fake-nvr.js [httpPort] [sadpPort]
const http = require('node:http');
const crypto = require('node:crypto');
const dgram = require('node:dgram');

const USER = 'oqtosh';
const PASS = 'Kamera123';
const REALM = 'DS-7608NI-K2';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// 1×1 dan kattaroq oddiy JPEG (bosh baytlari FFD8 … FFD9)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x11), Buffer.from([0xff, 0xd9])]);

function makeNvr({ model = 'DS-7608NI-K2', serial = 'DS-7608NI-K20820230101CCWRJ12345678', name = 'Zal NVR', channels = [[1, 'Kabina 1', true], [2, 'Kabina 2', true], [3, 'Kassa', false]] } = {}) {
  const nonces = new Set();
  let fails = 0;
  let lockedUntil = 0;
  const stats = { auth401: 0, ok: 0, bad: 0 };
  const challenge = () => {
    const n = crypto.randomBytes(16).toString('hex');
    nonces.add(n);
    return `Digest qop="auth", realm="${REALM}", nonce="${n}", stale="FALSE"`;
  };
  const check = (req) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) return 'none';
    const p = {};
    for (const m of h.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]] = m[2] ?? m[3];
    if (!nonces.has(p.nonce)) return 'stale';
    const ha1 = md5(`${p.username}:${REALM}:${PASS}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const want = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return p.username === USER && p.response === want;
  };
  const xml = (s) => `<?xml version="1.0" encoding="UTF-8"?>\n${s}`;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (Date.now() < lockedUntil) {
      stats.auth401++;
      res.writeHead(401, { 'WWW-Authenticate': challenge(), 'Content-Type': 'application/xml' });
      return res.end(xml('<userCheck><statusValue>401</statusValue><statusString>Unauthorized</statusString><lockStatus>lock</lockStatus><unlockTime>1800</unlockTime></userCheck>'));
    }
    const ok = check(req);
    if (ok !== true) {
      if (ok === false) { // parolsiz so'rov xato urinish hisoblanmaydi
        stats.bad++;
        if (++fails >= 5) lockedUntil = Date.now() + 30 * 60_000;
      }
      stats.auth401++;
      res.writeHead(401, { 'WWW-Authenticate': challenge() });
      return res.end();
    }
    fails = 0;
    stats.ok++;
    const send = (body, type = 'application/xml') => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    };
    if (url === '/ISAPI/System/deviceInfo') return send(xml(`<DeviceInfo version="2.0"><deviceName>${name}</deviceName><model>${model}</model><serialNumber>${serial}</serialNumber><macAddress>c0:56:e3:aa:bb:cc</macAddress><firmwareVersion>V4.61.010</firmwareVersion><deviceType>NVR</deviceType></DeviceInfo>`));
    if (url === '/ISAPI/System/time') return send(xml('<Time><localTime>2026-11-16T23:40:00+05:00</localTime></Time>'));
    if (url === '/ISAPI/ContentMgmt/InputProxy/channels') {
      return send(xml(`<InputProxyChannelList>${channels.map(([id, n]) => `<InputProxyChannel><id>${id}</id><name>${n}</name><sourceInputPortDescriptor><ipAddress>192.168.254.${id + 1}</ipAddress></sourceInputPortDescriptor></InputProxyChannel>`).join('')}</InputProxyChannelList>`));
    }
    if (url === '/ISAPI/ContentMgmt/InputProxy/channels/status') {
      return send(xml(`<InputProxyChannelStatusList>${channels.map(([id, , on]) => `<InputProxyChannelStatus><id>${id}</id><online>${on}</online></InputProxyChannelStatus>`).join('')}</InputProxyChannelStatusList>`));
    }
    const pic = /^\/ISAPI\/Streaming\/channels\/(\d+)0([12])\/picture$/.exec(url);
    if (pic) {
      const ch = channels.find(([id]) => id === Number(pic[1]));
      // kichik oqim rasmini bermaydigan model — katta oqimdan olinadi
      if (!ch || !ch[2] || pic[2] === '2') {
        res.writeHead(404);
        return res.end();
      }
      return send(JPEG, 'image/jpeg');
    }
    res.writeHead(404);
    res.end();
  });

  // SADP: so'rovga ProbeMatch bilan javob (haqiqiysi multicast'ga, bu yerda — so'raganga)
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (buf, rinfo) => {
    const x = buf.toString('utf8');
    if (!/<Probe>/.test(x)) return;
    const uuid = /<Uuid>([^<]*)<\/Uuid>/.exec(x)?.[1] || '';
    const port = server.address()?.port || 80;
    const reply = `<?xml version="1.0" encoding="UTF-8"?><ProbeMatch><Uuid>${uuid}</Uuid><Types>inquiry</Types><DeviceType>139</DeviceType><DeviceDescription>${model}</DeviceDescription><DeviceSN>${serial}</DeviceSN><CommandPort>8000</CommandPort><HttpPort>${port}</HttpPort><MAC>c0-56-e3-aa-bb-cc</MAC><IPv4Address>127.0.0.1</IPv4Address><IPv4SubnetMask>255.255.255.0</IPv4SubnetMask><DHCP>false</DHCP><AnalogChannelNum>0</AnalogChannelNum><DigitalChannelNum>8</DigitalChannelNum><SoftwareVersion>V4.61.010</SoftwareVersion><Activated>true</Activated></ProbeMatch>`;
    udp.send(Buffer.from(reply), rinfo.port, rinfo.address);
  });
  return { server, udp, stats, USER, PASS, reset: () => { fails = 0; lockedUntil = 0; } };
}

module.exports = { makeNvr, JPEG, USER, PASS };

if (require.main === module) {
  const nvr = makeNvr();
  nvr.server.listen(Number(process.argv[2]) || 8099, () => console.log('ISAPI', nvr.server.address().port));
  nvr.udp.bind(Number(process.argv[3]) || 47020, () => console.log('SADP', nvr.udp.address().port));
}
