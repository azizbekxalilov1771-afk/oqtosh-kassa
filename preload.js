'use strict';
// Sahifalarga beriladigan kichik ko'prik (window.OqDesktop). Sayt sahifalari faqat chek chop etish va
// bo'lim ochishni oladi; printer dasturi va sozlamalar faqat dasturning o'z bosh oynasiga (file://) ochiq.
const { contextBridge, ipcRenderer } = require('electron');

const local = location.protocol === 'file:';
const api = {
  isDesktop: true,
  version: ipcRenderer.sendSync('oq:version'),
  printHtml: (html) => ipcRenderer.invoke('oq:print-html', String(html)),
  open: (section, hash = '') => ipcRenderer.invoke('oq:open', String(section), String(hash)),
};
if (local) {
  Object.assign(api, {
    state: () => ipcRenderer.invoke('oq:home:state'),
    setSettings: (patch) => ipcRenderer.invoke('oq:settings:set', patch),
    pair: (code) => ipcRenderer.invoke('oq:pair', String(code)),
    unpair: () => ipcRenderer.invoke('oq:unpair'),
    scan: () => ipcRenderer.invoke('oq:scan'),
    testLocal: (printer) => ipcRenderer.invoke('oq:test-local', printer),
    testHtml: () => ipcRenderer.invoke('oq:test-html'),
    onStatus: (cb) => ipcRenderer.on('oq:agent-status', (_e, s) => cb(s)),
    onLog: (cb) => ipcRenderer.on('oq:agent-log', (_e, l) => cb(l)),
    onMode: (cb) => ipcRenderer.on('oq:mode', (_e, m) => cb(m)),
    onUpdate: (cb) => ipcRenderer.on('oq:update', (_e, u) => cb(u)),
    installUpdate: () => ipcRenderer.invoke('oq:update:install'),
    checkUpdates: () => ipcRenderer.invoke('oq:update:check'),
  });
}
contextBridge.exposeInMainWorld('OqDesktop', api);
