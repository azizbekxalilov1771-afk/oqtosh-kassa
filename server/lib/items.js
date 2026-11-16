// Buyurtma qatorlari: kassada olib tashlangan (void) miqdor hisobga, chekka va hisobotlarga kirmaydi.
//   item.voidQty  — jami olib tashlangan miqdor
//   item.voids    — [{ qty, sum, reason, byName, atMs }]
const round3 = (n) => Math.round(n * 1000) / 1000;
const share = (i, qty) => (i.qty ? Math.round((i.sum * qty) / i.qty) : 0);

// idx — asl qatorning tartib raqami (kassa "olib tashlash"da shu raqam bilan yuboradi)
//   item.movedQty — hisob bo'linganda boshqa chekka o'tkazilgan miqdor (item.moves: [{ qty, sum, toTabId, toOrderId, byName, atMs }])
export function liveItems(items) {
  return (items || []).flatMap((i, idx) => {
    const v = (Number(i.voidQty) || 0) + (Number(i.movedQty) || 0);
    if (!v) return [{ ...i, idx }];
    const left = round3(i.qty - v);
    if (left <= 0) return [];
    const { voidQty, voids, movedQty, moves, ...rest } = i;
    return [{ ...rest, qty: left, sum: share(i, left), idx }];
  });
}

// Qolgan (olib tashlanmagan va boshqa chekka o'tmagan) miqdor
export const leftQty = (i) => round3(i.qty - (Number(i.voidQty) || 0) - (Number(i.movedQty) || 0));

// Ko'rsatish uchun: boshqa chekka o'tkazilganlar
export function movedItems(items) {
  return (items || []).flatMap((i, idx) => (i.moves || []).map((m) => ({ idx, name: i.name, unit: i.unit || '', qty: m.qty, sum: m.sum, toTabId: m.toTabId || '', splitNo: m.splitNo || 0 })));
}

// Ko'rsatish uchun: olib tashlanganlar ro'yxati (qaysi taom, qancha, kim, nega)
export function voidedItems(items) {
  return (items || []).flatMap((i, idx) => (i.voids || []).map((v) => ({ idx, name: i.name, unit: i.unit || '', qty: v.qty, sum: v.sum, reason: v.reason || '', byName: v.byName || '', at: v.atMs ? new Date(v.atMs).toISOString() : '' })));
}

export const voidShare = share;
export const roundQty = round3;
