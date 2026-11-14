// Firebase (Firestore) → server kompyuteri: bir martalik ko'chirish.
// Firestore bepul limiti (kuniga 50 000 o'qish) tugashi mumkin — shuning uchun:
//   1-bosqich (zarur): sozlamalar, menyu, xodimlar, mijozlar, stollar, printerlar, hisoblagichlar, rasmlar,
//                      ochiq stol hisoblari va bugungi buyurtmalar → shundan keyin server ishga tushadi;
//   2-bosqich (tarix): eski buyurtmalar va hisoblar — eng yangisidan boshlab, to'xtab qolsa keyingi kuni davom etadi.
// Har bir sahifadan keyin holat saqlanadi (_pc/migration) — kompyuter o'chib qolsa ham davom ettiriladi.

import { getRemoteFirestore } from './firebase.js';
import { env } from './env.js';

// vaqtinchalik (ko'chirish shart emas): PIN urinishlari, kirish so'rovlari, chop etish navbatlari
const SKIP = new Set(['pin_guard', 'login_requests', 'print_jobs', 'agent_jobs', '_pc']);
// katta tarix — eng yangisidan, server ishga tushgandan keyin
const TIMED = { orders: 'createdAtMs', tabs: 'openedAtMs' };
const LATER = new Set(['admin_log', 'mison_backup_raw', 'mison_cheques', 'owner_cache']);
const PAGE = 400;

export const STATE = ['_pc', 'migration'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: env('TIMEZONE', 'Asia/Tashkent'), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export async function migrationState(db) {
  const s = await db.collection(STATE[0]).doc(STATE[1]).get();
  return s.exists ? s.data() : { phase: 'none', done: [], docs: 0 };
}
const save = (db, st) => db.collection(STATE[0]).doc(STATE[1]).set(st);

const quotaError = (e) => e?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e?.message || e));

// db — lokal baza. onProgress({phase, col, docs}) — holatni ko'rsatish uchun.
export async function migrateFromFirestore(db, { onProgress = () => {}, remote: given } = {}) {
  const st = { phase: 'essential', done: [], docs: 0, reads: 0, startedAtMs: Date.now(), ...(await migrationState(db)) };
  if (st.phase === 'none') st.phase = 'essential';
  if (st.phase === 'done' || st.phase === 'fresh') return st;
  let remote = given;
  let FieldPath = { documentId: () => '__name__' };
  try {
    remote ||= await getRemoteFirestore();
    if (!given) ({ FieldPath } = await import('firebase-admin/firestore'));
  } catch (e) {
    remote = null;
    st.lastError = `Firebase'ga ulanib bo‘lmadi: ${String(e?.message || e).slice(0, 200)}`;
  }
  if (!remote) {
    st.lastError ||= 'Firebase kalitlari yo‘q — ko‘chirib bo‘lmaydi (FIREBASE_* kalitlarini kiriting).';
    st.paused = 'error';
    st.lastErrorAtMs = Date.now();
    await save(db, { ...st, phase: (await migrationState(db)).phase });
    return { ...st, phase: (await migrationState(db)).phase };
  }
  st.lastError = '';
  st.paused = '';
  const progress = (col) => onProgress({ phase: st.phase, col, docs: st.docs });

  const put = (col, d, { keep = false } = {}) => {
    if (keep && db.store.get(col)?.has(d.id)) return false;
    db.putRaw(col, d.id, d.data());
    st.docs++;
    return true;
  };

  // Hujjat ID bo'yicha sahifalab, to'liq kolleksiya
  async function copyAll(col, { keep = false } = {}) {
    let after = st.cur?.col === col ? st.cur.after || '' : '';
    for (;;) {
      let q = remote.collection(col).orderBy(FieldPath.documentId()).limit(PAGE);
      if (after) q = q.startAfter(after);
      const snap = await q.get();
      st.reads += Math.max(1, snap.size);
      for (const d of snap.docs) put(col, d, { keep });
      if (snap.size) after = snap.docs.at(-1).id;
      st.cur = { col, after };
      await save(db, st);
      progress(col);
      if (snap.size < PAGE) break;
    }
    st.cur = null;
    st.done = [...new Set([...st.done, col])];
    await save(db, st);
  }

  try {
    if (st.phase === 'essential') {
      const names = (await remote.listCollections()).map((c) => c.id);
      st.reads++;
      st.all = names;
      const first = names.filter((n) => !SKIP.has(n) && !TIMED[n] && !LATER.has(n) && !n.startsWith('_'));
      // rasmlar oxirida (eng ko'p o'qish) — avval ish uchun zarurlari
      first.sort((a, b) => Number(/^media/.test(a)) - Number(/^media/.test(b)));
      for (const col of first) if (!st.done.includes(col)) await copyAll(col);
      // ochiq stol hisoblari va ularning buyurtmalari, bugungi buyurtmalar
      if (!st.done.includes('#open')) {
        const tabs = await remote.collection('tabs').where('status', '==', 'open').get();
        st.reads += Math.max(1, tabs.size);
        for (const t of tabs.docs) {
          put('tabs', t);
          const o = await remote.collection('orders').where('tabId', '==', t.id).limit(200).get();
          st.reads += Math.max(1, o.size);
          for (const d of o.docs) put('orders', d);
        }
        for (const day of [today()]) {
          const o = await remote.collection('orders').where('day', '==', day).get();
          st.reads += Math.max(1, o.size);
          for (const d of o.docs) put('orders', d);
        }
        st.done = [...st.done, '#open'];
        await save(db, st);
        progress('tabs');
      }
      st.phase = 'history';
      st.essentialAtMs = Date.now();
      st.cur = null;
      await save(db, st);
      db.compact?.();
      progress('');
    }

    if (st.phase === 'history') {
      for (const [col, field] of Object.entries(TIMED)) {
        if (st.done.includes(col)) continue;
        let before = st.cur?.col === col ? st.cur.before : null;
        for (;;) {
          let q = remote.collection(col).orderBy(field, 'desc').limit(PAGE);
          if (before !== null && before !== undefined) q = q.where(field, '<=', before);
          const snap = await q.get();
          st.reads += Math.max(1, snap.size);
          let fresh = 0;
          for (const d of snap.docs) if (put(col, d, { keep: true })) fresh++;
          const last = snap.size ? snap.docs.at(-1).get(field) : null;
          // bir xil vaqtli hujjatlar sahifa chegarasida qolmasin: "<=" bilan, siljish bo'lmasa — "<"
          const next = snap.size === PAGE && !fresh && last === before ? last - 1 : last;
          st.cur = { col, before: next };
          await save(db, st);
          progress(col);
          if (snap.size < PAGE) break;
          before = next;
        }
        st.cur = null;
        st.done = [...st.done, col];
        await save(db, st);
      }
      for (const col of (st.all || []).filter((n) => LATER.has(n))) if (!st.done.includes(col)) await copyAll(col, { keep: true });
      st.phase = 'done';
      st.doneAtMs = Date.now();
      st.cur = null;
      await save(db, st);
      db.compact?.();
      progress('');
    }
  } catch (e) {
    st.lastError = quotaError(e) ? 'Firebase kunlik limiti tugagan — limit yangilanganda (Toshkent vaqti 13:00) o‘zi davom etadi.' : String(e?.message || e).slice(0, 300);
    st.paused = quotaError(e) ? 'quota' : 'error';
    st.lastErrorAtMs = Date.now();
    await save(db, st);
    progress(st.cur?.col || '');
  }
  return st;
}

// Server ishga tushishi mumkinmi (zarur ma'lumotlar ko'chirilgan yoki yangi boshlangan)
export async function essentialReady(db) {
  const st = await migrationState(db);
  return st.phase === 'history' || st.phase === 'done' || st.phase === 'fresh';
}

// Ko'chirishsiz boshlash (yangi restoran / sinov): bo'sh baza bilan ishlaydi
export async function startFresh(db) {
  const st = await migrationState(db);
  if (st.phase !== 'none') return st;
  const next = { phase: 'fresh', done: [], docs: 0, startedAtMs: Date.now() };
  await save(db, next);
  return next;
}
