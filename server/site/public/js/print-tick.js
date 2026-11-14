// Kassa kompyuteri oynasi orqada (Mison ustida) tursa ham brauzer taymerlarni sekinlashtirmasin:
// ishchi (worker) vaqti-vaqti bilan "tekshir" signalini beradi. Oraliq sahifadan keladi (soniya emas, ms).
let timer = setInterval(() => postMessage(1), 30000);
onmessage = (e) => {
  clearInterval(timer);
  timer = setInterval(() => postMessage(1), Math.max(5000, Number(e.data) || 30000));
};
