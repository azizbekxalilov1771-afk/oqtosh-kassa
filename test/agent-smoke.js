'use strict';
// Tez tekshiruv (Electron'siz): printer dasturi moduli yuklanadi, soxta printerga sinov cheki boradi.
const net = require('node:net');
const { sendNet, testTicket, findNetPrinters } = require('../agent/core');
(async () => {
  const got = [];
  const srv = net.createServer((s) => s.on('data', (d) => got.push(d))).listen(19133, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const found = await findNetPrinters({ subnets: [], hosts: [{ ip: '127.0.0.1', port: 19133 }], timeout: 500 });
  if (found.length !== 1) throw new Error('printer topilmadi');
  await sendNet('127.0.0.1', 19133, testTicket(['salom']));
  await new Promise((r) => setTimeout(r, 400));
  srv.close();
  if (!Buffer.concat(got).toString('latin1').includes('SINOV')) throw new Error('chek kelmadi');
  console.log('OK: printer moduli ishlayapti');
})().catch((e) => {
  console.error('XATO:', e.message);
  process.exit(1);
});
