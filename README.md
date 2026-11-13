# Oqtosh Kassa — kompyuter dasturi (Windows)

Bitta dasturda: **Kassa**, **Ofitsiant**, **Admin panel**, **Owner** (savdo hisobotlari) va **printer dasturi**
(oshxona va kassa cheklari Wi‑Fi/USB printerlardan oynasiz chiqadi). Sahifalar saytdan yuklanadi: saytni
yangilasangiz, dastur ham o‘zi yangilanadi — qayta o‘rnatish shart emas.

Ichida kalit yoki parol yo‘q (faqat saytingiz manzili, `config.json`). Printer dasturi kaliti kompyuterda
Windows himoyasi bilan shifrlangan holda saqlanadi.

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

## 4. Kirish

- **Kassa / Ofitsiant / Kuryer** — Telegram orqali yoki **parol bilan** (restoran Wi‑Fi’sida; parolni admin
  “Xodimlar” bo‘limida beradi).
- **Admin panel** — Google yoki email + parol (ADMIN_EMAILS).
- **Owner** — admin “Owner kirishi” bo‘limida ochgan email + parol.

Klaviatura: F1 Kassa · F2 Ofitsiant · F3 Admin · F4 Owner · Ctrl+H bosh oyna · F5 yangilash · F11 to‘liq ekran · Alt+← orqaga.

## 5. Tuzilma

| Fayl | Nima |
|---|---|
| `main.js` | oynalar, menyu, tray, avto-ishga tushish, xavfsizlik (faqat o‘z saytlarimiz), oynasiz chop etish |
| `preload.js` | sahifalarga `window.OqDesktop` (chop etish, bo‘lim ochish); printer va sozlamalar — faqat bosh oynaga |
| `agent/core.js` | printer dasturi: tarmoqni skanerlash, MAC, SNMP model, ESC/POS yuborish, qo‘ng‘iroq (SSE), navbat |
| `agent/raw-win.js` | Windows (USB) printerlariga RAW yozish (winspool) |
| `app/` | bosh oyna (Kassa, Ofitsiant, Admin, Owner, printerlar, jurnal, sozlamalar) |
| `config.json` | sayt va admin manzillari (dastur sozlamalarida o‘zgartiriladi) |
| `.github/workflows/windows.yml` | Setup.exe yig‘ish va Releases |

Sinov (Electron'siz): `npm test` — printer moduli soxta printerga chek yuboradi.
