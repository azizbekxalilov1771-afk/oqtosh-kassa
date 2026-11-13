#!/usr/bin/env bash
# Bir marta ishga tushiriladi (Termux): GitHub'da repozitoriy ochadi va kodni yuklaydi.
# Shundan keyin GitHub Windows dasturini (Oqtosh-Kassa-Setup.exe) o'zi yig'adi — 6–10 daqiqa.
#   bash scripts/github-setup.sh              (repozitoriy nomi: oqtosh-kassa)
#   bash scripts/github-setup.sh boshqa-nom
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_NAME="${1:-oqtosh-kassa}"

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }

if ! command -v git >/dev/null || ! command -v gh >/dev/null; then
  say "git va gh o'rnatilmoqda"
  pkg install -y git gh
fi
if ! gh auth status >/dev/null 2>&1; then
  say "GitHub'ga kirish: brauzer ochiladi, ekrandagi kodni kiriting"
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git >/dev/null
OWNER="$(gh api user -q .login)"
REPO="$OWNER/$REPO_NAME"

# Bu loyihada kalit yoki parol YO'Q (faqat saytingiz manzili). Ochiq repozitoriy bo'lsa, kassa kompyuterida
# Setup.exe'ni GitHub'ga kirmasdan bitta havola bilan yuklab olasiz.
VIS="--public"
read -r -p "Repozitoriy ochiq (public) bo'lsinmi? Kompyuterga yuklab olish oson bo'ladi. [H/y]: " ans || true
case "${ans,,}" in y|yo*|n|no*) VIS="--private" ;; esac

[ -d .git ] || git init -q -b main
git config user.name "$OWNER"
git config user.email "$OWNER@users.noreply.github.com"
git add -A
if git diff --cached --name-only | grep -Eq '(\.env$|\.jks$|parol|kalit/)'; then echo "XATO: maxfiy fayl commit'ga tushyapti — to'xtatildi."; exit 1; fi
git diff --cached --quiet || git commit -q -m "Oqtosh Kassa — kompyuter dasturi"

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  say "Repozitoriy ochilmoqda: $REPO ($VIS)"
  git remote remove origin 2>/dev/null || true
  gh repo create "$REPO" "$VIS" --source . --remote origin
elif ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/$REPO.git"
fi

say "Kod yuklanmoqda — GitHub dasturni yig'ishni boshlaydi"
git push -u origin main

cat <<MSG

✅ Tayyor. Yig'ish 6–10 daqiqa davom etadi.
   Kuzatish:  https://github.com/$REPO/actions
   Tayyor bo'lgach:  bash scripts/yuklash.sh
   Kassa kompyuterida yuklab olish havolasi (har doim eng oxirgi versiya):
   https://github.com/$REPO/releases/latest/download/Oqtosh-Kassa-Setup.exe
MSG
