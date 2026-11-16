import { el } from '../ui.js';
import { mountOwnerReport } from '../owner-report.js';

// Hisobotlar (egasi uchun bosh sahifa; admin uchun — bosh paneldagi bilan bir xil)
export async function render(root) {
  const box = el('div', { className: 'owner-main owner-embed' });
  root.append(box);
  mountOwnerReport(box, { onAuth: (e) => box.replaceChildren(el('p', { className: 'notice warn', textContent: e.message })) });
}
