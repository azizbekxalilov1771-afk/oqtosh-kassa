import { el } from './common.js';

// Kamera orqali QR skanerlash (Chrome/Android: BarcodeDetector). Topilgan matnni onResult'ga beradi.
export const scannerSupported = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

export async function openScanner(onResult) {
  const video = el('video', { playsInline: true, muted: true, autoplay: true, className: 'scan-video' });
  const hint = el('p', { className: 'scan-hint', textContent: 'QR kodni ramkaga to‘g‘rilang' });
  const close = el('button', { type: 'button', className: 'btn btn-ghost scan-close', textContent: 'Yopish' });
  const box = el('div', { className: 'scan-overlay', role: 'dialog', ariaLabel: 'QR skaner' },
    video, el('div', { className: 'scan-frame', ariaHidden: 'true' }), hint, close);
  document.body.append(box);
  let stream = null;
  let stop = false;
  const end = () => {
    stop = true;
    stream?.getTracks().forEach((t) => t.stop());
    box.remove();
  };
  close.addEventListener('click', end);
  if (!scannerSupported()) {
    hint.textContent = 'Bu brauzer skanerni qo‘llamaydi. Telefon kamerasi bilan skanerlang yoki buyurtmani ro‘yxatdan oching.';
    return end;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    hint.textContent = 'Kameraga ruxsat berilmadi. Brauzer sozlamalarida kamerani yoqing.';
    return end;
  }
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const tick = async () => {
    if (stop) return;
    try {
      const codes = await detector.detect(video);
      if (codes[0]?.rawValue) {
        navigator.vibrate?.(80);
        const v = codes[0].rawValue;
        end();
        return onResult(v);
      }
    } catch {}
    setTimeout(tick, 180);
  };
  tick();
  return end;
}
