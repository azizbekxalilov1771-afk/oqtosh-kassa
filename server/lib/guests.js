import { AppError } from './env.js';
import { getDb } from './firebase.js';

// Admin → "Mehmonlar": saytdan foydalanganlar soni, har birining buyurtmalari va tarixni tozalash.
// O'chirish faqat saytdagi yozuvlarga taalluqli — Mison kassasidagi cheklar o'zgarmaydi.

async function needDb() {
  const db = await getDb();
  if (!db) throw new AppError(503, 'Firebase ulanmagan.');
  return db;
}

const toIso = (v) => {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return typeof v === 'string' ? v : '';
};

async function deleteDocs(docs) {
  for (let i = 0; i < docs.length; i += 40) await Promise.all(docs.slice(i, i + 40).map((d) => d.ref.delete()));
  return docs.length;
}

// Kolleksiyani to'liq tozalash (bo'laklab)
async function wipe(db, name, filter = () => true) {
  let total = 0;
  for (let round = 0; round < 200; round++) {
    const snap = await db.collection(name).limit(300).get();
    const docs = snap.docs.filter((d) => filter(d.data()));
    if (!docs.length) break;
    total += await deleteDocs(docs);
    if (docs.length < snap.docs.length) break; // qolganlari filtrdan o'tmaydi
  }
  return total;
}

export async function listGuests() {
  const db = await needDb();
  const [cs, os] = await Promise.all([
    db.collection('customers').limit(3000).get(),
    db.collection('orders').orderBy('createdAtMs', 'desc').limit(5000).get(),
  ]);
  const agg = new Map();
  for (const d of os.docs) {
    const o = d.data();
    const a = agg.get(o.customerId) || { orders: 0, spent: 0, lastMs: 0 };
    a.orders++;
    if (o.status === 'qabul') a.spent += o.total || 0;
    a.lastMs = Math.max(a.lastMs, o.createdAtMs || 0);
    agg.set(o.customerId, a);
  }
  const items = cs.docs.map((d) => {
    const c = d.data();
    const a = agg.get(d.id) || { orders: 0, spent: 0, lastMs: 0 };
    return {
      id: d.id, name: c.name || c.firstName || '', phone: c.phone || '', username: c.username || '',
      role: c.role || 'customer', since: toIso(c.createdAt), orders: a.orders, spent: a.spent, lastOrderAt: a.lastMs ? new Date(a.lastMs).toISOString() : '',
    };
  }).sort((x, y) => (y.lastOrderAt || y.since).localeCompare(x.lastOrderAt || x.since));
  return {
    items,
    totals: { people: items.length, guests: items.filter((g) => g.role === 'customer').length, withOrders: items.filter((g) => g.orders).length, orders: os.docs.length },
  };
}

// Bitta mehmonning tarixi: buyurtmalari, stol hisoblari, band stoli
export async function clearGuestHistory(id) {
  const db = await needDb();
  const key = String(id || '');
  if (!/^\d{1,20}$/.test(key)) throw new AppError(404, 'Mehmon topilmadi.');
  const [os, ts, ss] = await Promise.all([
    db.collection('orders').where('customerId', '==', key).limit(2000).get(),
    db.collection('tabs').where('customerId', '==', key).limit(2000).get(),
    db.collection('table_state').where('customerId', '==', key).limit(50).get(),
  ]);
  const orders = await deleteDocs(os.docs);
  const tabs = await deleteDocs(ts.docs);
  await deleteDocs(ss.docs);
  return { orders, tabs };
}

// Mehmonni butunlay o'chirish (xodim bo'lsa — avval xodimlikdan chiqarish kerak)
export async function deleteGuest(id) {
  const db = await needDb();
  const ref = db.collection('customers').doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new AppError(404, 'Mehmon topilmadi.');
  if (snap.data().role && snap.data().role !== 'customer') throw new AppError(409, 'Bu xodim. Avval “Xodimlar” bo‘limida xodimlikdan chiqaring.');
  const r = await clearGuestHistory(snap.id);
  await ref.delete();
  return r;
}

// Hammasini tozalash: barcha buyurtmalar, stol hisoblari, band stollar, raqam hisoblagichi.
// guests: true bo'lsa — mehmon hisoblari ham (xodimlar qoladi)
export async function clearAllHistory({ guests = false } = {}) {
  const db = await needDb();
  const orders = await wipe(db, 'orders');
  const tabs = await wipe(db, 'tabs');
  await wipe(db, 'table_state');
  await wipe(db, 'print_jobs');
  await wipe(db, 'agent_jobs');
  await db.collection('counters').doc('orders').delete().catch(() => {});
  const people = guests ? await wipe(db, 'customers', (c) => !c.role || c.role === 'customer') : 0;
  return { orders, tabs, guests: people };
}

// Mijoz o'z hisobini o'chiradi (Google Play talabi): hisob, Telegram ma'lumoti va buyurtmalardagi shaxsiy
// ma'lumotlar (ism, telefon, manzil) o'chadi. Buyurtma summalari hisob-kitob uchun nomsiz holda qoladi.
export async function deleteOwnAccount(customer) {
  const db = await needDb();
  const id = String(customer.id);
  const seated = await db.collection('table_state').where('customerId', '==', id).limit(1).get();
  if (!seated.empty) throw new AppError(409, 'Stol hisobingiz hali ochiq. Avval hisob yopilsin (kassaga ayting), keyin hisobni o‘chiring.');
  if (customer.role && customer.role !== 'customer') throw new AppError(409, 'Siz xodimsiz. Hisobni o‘chirish uchun administratorga ayting.');
  const os = await db.collection('orders').where('customerId', '==', id).limit(3000).get();
  for (let i = 0; i < os.docs.length; i += 40) {
    await Promise.all(os.docs.slice(i, i + 40).map((d) => {
      const o = d.data();
      if (o.status === 'yangi') return d.ref.delete(); // tasdiqlanmagan — butunlay
      return d.ref.update({ customerId: 'deleted', customerName: '', customerPhone: '', deliveryPhone: '', address: o.address ? { text: '', lat: null, lng: null } : null, customerDeleted: true, comment: '' });
    }));
  }
  const tabs = await db.collection('tabs').where('customerId', '==', id).limit(2000).get();
  await deleteDocs(tabs.docs.filter((d) => d.data().status !== 'open'));
  await db.collection('telegram_chats').doc(id).delete().catch(() => {});
  await db.collection('customers').doc(id).delete();
  return { orders: os.docs.length };
}
