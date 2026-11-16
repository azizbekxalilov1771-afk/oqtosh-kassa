# Oqtosh Kassa — kompyuter dasturi (Windows)

Bitta dasturda: **Kassa**, **Ofitsiant**, **Ombor**, **Admin panel**, **Owner** (savdo hisobotlari), **printer dasturi**
(oshxona va kassa cheklari Wi‑Fi/USB printerlardan oynasiz chiqadi) va **server** — sayt, admin panel va barcha
ma'lumotlar restoranning o'z kompyuteridan ishlaydi (Firebase va Netlify limitlarisiz, oyiga to'lovsiz).

Ichida kalit yoki parol yo‘q (faqat saytingiz manzili, `config.json`). Printer dasturi kaliti kompyuterda
Windows himoyasi bilan shifrlangan holda saqlanadi.

## 0. Server kompyuteri (sayt shu kompyuterdan)

Kassa kompyuteri server bo'ladi: `oqtoshrestoran.uz` (mijozlar sayti), `admin.oqtoshrestoran.uz` (admin panel,
xodim sahifalari), Telegram bot va Mison webhook'lari — hammasi shu kompyuterga keladi. Ma'lumotlar kompyuter
diskida, internetga **Cloudflare Tunnel** (bepul) orqali chiqadi: oq IP, router sozlash kerak emas.
Kompyuter o'chiq paytda sayt “hozir yopiq” deb ko'rsatadi (pastdagi 6-qadam).

1. **Yangi dastur.** Shu zipni GitHub'ga yuklang (pastda 1-bo'lim) — kassa kompyuteridagi dastur o'zi yangilanadi.
2. **Kalitlar.** Bosh oyna → **Server kompyuteri** → “Kompyuterdan topish” (oldin ochilgan `oqtosh-restoran`
   papkasidagi `.env` / `netlify-kalitlar.env` topiladi) yoki “Faylni tanlash…”. Kalitlar Windows himoyasi bilan shifrlanadi.
3. **“Bu kompyuterni server qilish”** → server ishga tushadi. Firebase'dagi ma'lumotlar o'zi ko'chiriladi
   (Firebase kunlik limiti tugagan bo'lsa — limit yangilanganda, Toshkent vaqti 13:00 da, o'zi davom etadi).
   Ko'chirish tugaguncha sayt “texnik ishlar” sahifasini ko'rsatadi.
4. **Cloudflare (bir marta):**
   - `dash.cloudflare.com` → ro'yxatdan o'ting (bepul) → **Add a domain** → `oqtoshrestoran.uz` → **Free** → davom eting.
   - Cloudflare ko'rsatgan 2 ta **nameserver**ni domen sotib olingan joyning kabinetida (DNS / NS) yozing.
   - Cloudflare'da domen holati **Active** bo'lgach (10 daqiqa – bir necha soat): dasturda **“Cloudflare’ga ulash”** →
     brauzer ochiladi → domenni tanlang → **Authorize**. Qolganini dastur qiladi (tunnel, DNS yozuvlari).
5. **Eski Netlify saytlarini yopish** (yangi manzillar ishlay boshlagach, Termux'da bir marta):
   `cd ~/oqtosh-restoran && npm run deploy kochish` — eski manzillar yangisiga yo'naltiriladi, Firestore'ga so'rov ketmaydi.
6. **“Hozir yopiq” sahifasi (ixtiyoriy):** `cloudflare/yopiq-worker.js` faylidagi yo'riqnoma (Cloudflare Worker, bepul).

Telegram bot va Mison webhook manzillari o'zgarmaydi (domen o'sha). Admin panelga Google bilan kirish uchun
`admin.oqtoshrestoran.uz` Firebase'da avtomatik ruxsat oladi (bo'lmasa: Firebase → Authentication → Settings →
Authorized domains → Add domain).

**Zaxira:** har 3 soatda `Hujjatlar\Oqtosh zaxira` papkasiga (oxirgi 40 tasi) va kuniga bir marta admin Telegram
chatiga (shifrlangan `.oqz` fayl). Tiklash: Server kompyuteri → “Zaxiradan tiklash”. Fayl faqat shu kalitlar bilan ochiladi.

**Maslahat:** server ishlab turganda dastur kompyuterni uyqu rejimiga o'tkazmaydi. Tok o'chib turadigan bo'lsa — UPS
(uzluksiz quvvat bloki) qo'ying. Windows qayta yuklanganda dastur hisobga kirilgach o'zi ishga tushadi.

Boshqa kompyuterlar (ofitsiant terminallari) yangi admin manzili ishlay boshlaganini o'zi sezadi va unga o'tadi.
Server kodi `server/` papkasida (sayt loyihasidan `scripts/desktop-sync.sh` bilan ko'chiriladi).

## 1. Setup.exe yig‘ish (Termux, bir marta)

```bash
cd ~ && unzip -o "$(ls -t /sdcard/Download/oqtosh-desktop*.zip | head -1)" -d ~
cd ~/oqtosh-desktop
bash scripts/github-setup.sh      # GitHub'da repozitoriy ochadi va kodni yuklaydi
bash scripts/yuklash.sh           # yig'ish tugashini kutadi (6–10 daqiqa) va havolani beradi
```

GitHub'ga kirishda kod chiqmasa yoki brauzer ochilmasa — token bilan kiring: telefon brauzerida
`https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=termux` → **Generate token** → nusxa oling →
Termux'da `gh auth login --with-token` → tokenni qo'ying → Enter → **Ctrl+D** → `gh auth setup-git` → skriptni qayta ishga tushiring.

GitHub Actions Windows kompyuterida `Oqtosh-Kassa-Setup.exe` ni yig‘adi va **Releases**ga qo‘yadi.
Doimiy havola (har doim eng oxirgi versiya):
`https://github.com/<github-login>/oqtosh-kassa/releases/latest/download/Oqtosh-Kassa-Setup.exe`

Keyinroq o‘zgartirish kiritilsa: fayllarni almashtiring, `git add -A && git commit -m yangilash && git push` — yangi Setup.exe o‘zi yig‘iladi.

**Telefon/Termux'siz (faqat brauzer):** GitHub'da repozitoriyni oching → **Add file → Upload files** → yangi
`oqtosh-desktop.zip`ning **o‘zini** tashlang → **Commit changes**. Yig‘ish zipni o‘zi ochadi, repodagi fayllarni
yangilaydi, zipni o‘chiradi va yangi Setup.exe chiqaradi (barcha kompyuterlarda “Yangilash” chiqadi).

## 2. Kassa kompyuteriga o‘rnatish

1. Havolani kompyuterda oching → `Oqtosh-Kassa-Setup.exe` yuklanadi → ikki marta bosing.
2. “Windows protected your PC / Windows защитил компьютер” chiqsa: **More info / Подробнее → Run anyway / Выполнить в любом случае**
   (dastur raqamli imzosiz; imzo sertifikati pullik).
3. O‘rnatilgach ish stolida **Oqtosh Kassa** belgisi paydo bo‘ladi.

## 3. Printerlarni ulash

1. Dasturda **Admin panel (F3)** → Google bilan kiring → **Tayyorlash joylari** → “🖥 Oqtosh Kassa dasturini ulash”.
2. Chiqqan 8 belgili kodni dasturning bosh oynasidagi **Printer dasturi** qismiga yozing → **Ulash**.
3. Dastur Wi‑Fi tarmoqdagi chek printerlarini (9100-port) va kompyuterga ulangan USB printerlarni o‘zi topadi.
   “Sinov” tugmasi — printerdan qaysi printer ekani chiqadi.
4. Admin panel → Tayyorlash joylari: Salat, Issiq ovqat, Somsa, Shashlik, Bar va **Kassa printeri**ni tanlang.

Dastur yopilsa ham soat yonida (tray) ishlab turadi va kompyuter yoqilganda o‘zi ishga tushadi — cheklar
kassa oynasi ochiq bo‘lmasa ham chiqadi. Butunlay chiqish: tray → **Chiqish**.

“Qurilmalar va printer” bo‘limidagi oddiy (HTML) cheklar uchun printer: bosh oyna → **Sozlamalar** → “Brauzer cheklari uchun printer”.

## Asosiy kompyuter va ofitsiant terminallari

- **Asosiy kompyuter** — admin bergan 8 belgili kod bilan ulangan (printer dasturi ishlaydi): Kassa, Admin, Owner, printerlar.
- **Boshqa kompyuterlar** (kod bilan ulanmagan) — faqat **Ofitsiant** oynasi, to‘liq ekranda. Omborchi ham shu oynadan PIN bilan kiradi va ombor sahifasiga o‘tadi.

## Yangilanish

GitHub'ga yangi kod yuklansa (`git push`), Actions yangi versiyani (2.1.N) yig‘adi. Hamma kompyuterdagi dastur uni
30 daqiqa ichida o‘zi topadi, yuklab oladi va “Hozir yangilash / Keyinroq” deb so‘raydi. “Keyinroq” — kompyuter
o‘chirilganda o‘zi o‘rnatiladi. Qo‘lda: menyu → Oqtosh → “Yangilanishni tekshirish”. Sayt sahifalari esa har doim
saytdan yuklanadi (saytni yangilasangiz — darhol).

**Internet uzilsa:** kassa, ofitsiant, kuryer va ombor sahifalarining nusxasi kompyuterda saqlanadi — dastur
brauzer xatosi o‘rniga o‘z oynasini ochadi, tepada qizil “Internet yo‘q” yo‘lagi chiqadi. Buyurtma va to‘lov faqat
server orqali saqlanadi (ikki xil hisob bo‘lmasin), shuning uchun internetsiz yangi buyurtma yozilmaydi; ulanish
qaytishi bilan sahifa o‘zi yangilanadi.

## 4. Kirish

- **Kassa / Ofitsiant / Kuryer / Ombor** — faqat **4 xonali PIN** (PIN'ni admin “Xodimlar” bo‘limida beradi).
  Sahifalar admin saytida: `https://admin.oqtoshrestoran.uz/xodim/kassa.html`, `…/xodim/ofitsiant.html`.
- **Admin panel** — Google yoki email + parol (ADMIN_EMAILS).
- **Owner** — admin “Owner kirishi” bo‘limida ochgan email + parol.

Klaviatura: F1 Kassa · F2 Ofitsiant · F3 Admin · F4 Owner · Ctrl+H bosh oyna · F5 yangilash · F11 to‘liq ekrandan chiqish/qaytish · Alt+← orqaga.

**Sensorli POS monoblok (klaviaturasiz):** har bir oynaning chap chetidagi sariq tutqich (⋮) — Bosh oyna, bo‘limlar, to‘liq ekran, sahifani yangilash va tayyor yangilanish. Yangilanish tayyor bo‘lsa, tepada “Yangilash” tugmasi chiqadi; bosilmasa — tunda (03:00–06:00) o‘zi o‘rnatiladi.

**Ekran klaviaturasi:** matn yoki raqam maydoniga barmoq bilan bosilganda pastda dasturning o‘z klaviaturasi chiqadi — lotin (o‘, g‘ tugmalari bilan), kirill (ў қ ғ ҳ bilan), belgilar va pul uchun raqam paneli (“000”, “C”). Modal oynalar ichida ham ishlaydi, oyna klaviatura ustiga ko‘tariladi; ⇅ — klaviaturani tepaga/pastga. Rejim: Sozlamalar → “Ekran klaviaturasi” yoki chetdagi menyu (⋮ → Klaviatura): barmoq bosganda / doim / o‘chiq. Sensorli ekran sichqoncha deb ko‘rinsa — “doim” rejimini tanlang.

## 5. Tuzilma

| Fayl | Nima |
|---|---|
| `main.js` | oynalar, menyu, tray, avto-ishga tushish, xavfsizlik (faqat o‘z saytlarimiz), oynasiz chop etish |
| `preload.js` | sahifalarga `window.OqDesktop` (chop etish, bo‘lim ochish); printer, server va sozlamalar — faqat bosh oynaga |
| `server-host.js` | server kompyuteri: server jarayoni, kalitlar (DPAPI), Cloudflare Tunnel, zaxira |
| `server/` | sayt kodi (Node): `pc/server.mjs` — sayt 127.0.0.1:8780, admin 127.0.0.1:8781, `lib/localdb.js` — lokal baza |
| `cloudflare/yopiq-worker.js` | kompyuter o‘chiq paytdagi “hozir yopiq” sahifasi (Cloudflare Worker) |
| `agent/core.js` | printer dasturi: tarmoqni skanerlash, MAC, SNMP model, ESC/POS yuborish, qo‘ng‘iroq (SSE), navbat |
| `agent/raw-win.js` | Windows (USB) printerlariga RAW yozish (winspool) |
| `app/` | bosh oyna (Kassa, Ofitsiant, Admin, Owner, printerlar, jurnal, sozlamalar) |
| `config.json` | sayt va admin manzillari (dastur sozlamalarida o‘zgartiriladi) |
| `.github/workflows/windows.yml` | Setup.exe yig‘ish va Releases |

Sinov (Electron'siz): `npm test` — printer moduli soxta printerga chek yuboradi; `node test/server-smoke.js` — server
ishga tushadi, sahifa beradi, ma'lumotni diskka yozib, qayta ishga tushganda o'qiydi (GitHub Actions'da Windows'da ham).
