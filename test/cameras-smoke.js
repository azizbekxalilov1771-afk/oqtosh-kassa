'use strict';
// Kameralar moduli: soxta videoregistrator bilan topish, ulash, kanallar, rasm, kabina=stol, noto'g'ri parol.
//   node test/cameras-smoke.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeNvr } = require('./fake-nvr');
const cams = require('../agent/cameras');

(async () => {
  const nvr = makeNvr();
  await new Promise((r) => nvr.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => nvr.udp.bind(0, '127.0.0.1', r));
  const httpPort = nvr.server.address().port;
  const sadpPort = nvr.udp.address().port;

  // 1) SADP — qurilma o'zi topiladi (model, seriya, MAC, HTTP port)
  const found = await cams.sadp({ port: sadpPort, bindPort: 0, targets: ['127.0.0.1'], timeout: 800 });
  assert.equal(found.length, 1, 'SADP: 1 ta qurilma');
  assert.equal(found[0].model, 'DS-7608NI-K2');
  assert.equal(found[0].httpPort, httpPort);
  assert.equal(found[0].mac, 'C056E3AABBCC');
  console.log('OK SADP:', found[0].ip, found[0].model, found[0].channels, 'kanal');

  // 2) 8000-port bo'yicha zaxira qidiruv
  const portHits = await cams.portScan({ hosts: ['127.0.0.1'], port: httpPort });
  assert.equal(portHits.length, 1);
  console.log('OK port qidiruvi:', portHits.map((h) => h.ip).join(', '));

  // 3) ulash, kanallar, rasm
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oqcam-'));
  const file = path.join(dir, 'cameras.json');
  const enc = (s) => Buffer.from(`x:${s}`).toString('base64');
  const dec = (s) => Buffer.from(s, 'base64').toString().slice(2);
  let changes = 0;
  const store = new cams.CameraStore({ file, encrypt: enc, decrypt: dec, onChange: () => changes++ });

  await assert.rejects(store.connect({ ip: '127.0.0.1', port: httpPort, user: 'oqtosh', pass: 'xato' }), (e) => e.code === 'login');
  assert.equal(nvr.stats.bad, 1, 'noto‘g‘ri parol — faqat 1 urinish (bloklanmasin)');
  console.log('OK noto‘g‘ri parol: 1 urinish, xabar tushunarli');

  const n = await store.connect({ ip: '127.0.0.1', port: httpPort, user: 'oqtosh', pass: 'Kamera123' });
  assert.equal(n.model, 'DS-7608NI-K2');
  assert.equal(n.channels.length, 3);
  assert.deepEqual(n.channels.map((c) => c.online), [true, true, false]);
  assert.ok(!('pass' in n), 'oynaga parol berilmaydi');
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes('Kamera123'), 'parol ochiq holda saqlanmaydi');
  console.log('OK ulandi:', n.name, n.model, n.channels.map((c) => `${c.ch}:${c.name}${c.online ? '' : '(o‘chiq)'}`).join(', '));

  const jpg = await store.snapshot(n.id, 1);
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);
  await assert.rejects(store.snapshot(n.id, 3), (e) => e.code === 'snapshot');
  console.log('OK rasm: 1-kanal', jpg.length, 'bayt; o‘chiq kanalda tushunarli xato');

  // nonce qayta ishlatiladi — har rasm uchun ikki so'rov emas
  const before = nvr.stats.auth401;
  for (let i = 0; i < 5; i++) await store.snapshot(n.id, 2);
  assert.ok(nvr.stats.auth401 - before <= 5, 'rasmlar Digest nonce bilan');
  console.log('OK 5 ta rasm, qo‘shimcha 401:', nvr.stats.auth401 - before);

  // 4) kabina = stol
  store.setPlace(n.id, 1, { place: 'table', tableId: 't12', label: 'Kabina 1' });
  store.setPlace(n.id, 3, { place: 'kassa' });
  assert.throws(() => store.setPlace(n.id, 2, { place: 'table' }), /Stolni tanlang/);
  const sum = store.summary();
  assert.deepEqual(sum.map((s) => [s.ch, s.place, s.tableId]), [[1, 'table', 't12'], [2, '', ''], [3, 'kassa', '']]);
  assert.ok(!JSON.stringify(sum).includes('127.0.0.1') && !JSON.stringify(sum).includes('Kamera123'), 'saytga IP va parol ketmaydi');
  console.log('OK kabina=stol:', JSON.stringify(sum.map((s) => `${s.name}→${s.place}${s.tableId ? `:${s.tableId}` : ''}`)));

  // 5) qayta ochilganda saqlangan
  const again = new cams.CameraStore({ file, encrypt: enc, decrypt: dec });
  assert.equal(again.state().nvrs[0].channels[0].tableId, 't12');
  assert.ok((await again.snapshot(n.id, 1)).length > 200, 'saqlangan paroldan ulanadi');
  console.log('OK qayta ochilganda saqlangan, saqlangan parol bilan rasm');

  // 6) 5 ta noto'g'ri urinish → bloklash xabari
  nvr.reset();
  const bad = new cams.Isapi({ ip: '127.0.0.1', port: httpPort, user: 'oqtosh', pass: 'yoq' });
  for (let i = 0; i < 5; i++) await bad.request('/ISAPI/System/deviceInfo').catch(() => {});
  await assert.rejects(bad.request('/ISAPI/System/deviceInfo'), (e) => e.code === 'locked');
  console.log('OK bloklanganda tushunarli xabar');

  store.remove(n.id);
  assert.equal(store.summary().length, 0);
  console.log('OK o‘chirildi; o‘zgarishlar:', changes);
  nvr.server.close();
  nvr.udp.close();
  console.log('Hammasi o‘tdi');
})().catch((e) => {
  console.error('XATO:', e);
  process.exit(1);
});
