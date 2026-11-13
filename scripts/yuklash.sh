#!/usr/bin/env bash
# Oxirgi yig'ishni kutadi, natijani ko'rsatadi va Setup.exe'ni telefonga (Download/oqtosh-kassa) ham yuklaydi.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

RUN_ID="$(gh run list --workflow windows.yml --limit 1 --json databaseId -q '.[0].databaseId')"
[ -n "$RUN_ID" ] || { echo "Hali yig'ish bo'lmagan. Avval: bash scripts/github-setup.sh"; exit 1; }
STATUS="$(gh run view "$RUN_ID" --json status,conclusion -q '.status + " " + .conclusion')"
if [[ "$STATUS" != completed* ]]; then
  echo "Yig'ish davom etyapti — tugashini kutyapmiz…"
  gh run watch "$RUN_ID" --exit-status || { echo "Xato bilan tugadi. Sababi:  gh run view $RUN_ID --log-failed | tail -60"; exit 1; }
elif [[ "$STATUS" != "completed success" ]]; then
  echo "Oxirgi yig'ish xato bilan tugagan. Sababini ko'rish:  gh run view $RUN_ID --log-failed | tail -60"
  exit 1
fi

echo
echo "✅ Tayyor. Kassa kompyuterida shu havolani oching:"
echo "   https://github.com/$REPO/releases/latest/download/Oqtosh-Kassa-Setup.exe"
if [ -d "$HOME/storage/downloads" ]; then
  mkdir -p "$HOME/storage/downloads/oqtosh-kassa"
  gh release download --repo "$REPO" --pattern 'Oqtosh-Kassa-Setup.exe' --dir "$HOME/storage/downloads/oqtosh-kassa" --clobber
  echo "📁 Telefonda ham: Download/oqtosh-kassa/Oqtosh-Kassa-Setup.exe"
fi
