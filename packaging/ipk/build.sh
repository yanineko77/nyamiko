#!/bin/sh
# Сборка .ipk приложения-обёртки Nyamiko (установка клиента из Homebrew Channel)
# и манифеста для репозитория webosbrew.
#
#   sh packaging/ipk/build.sh            -> оба файла в packaging/ipk/dist/
#
# Требуется node + @webos-tools/cli и @webosbrew/pub-utils
# (ставятся как `npm i @webos-tools/cli @webosbrew/pub-utils`), путь к бинарникам
# можно задать переменной IPK_TOOLS.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
TOOLS="${IPK_TOOLS:-/root/ipk-tools/node_modules/.bin}"
OUT="$HERE/dist"
LINK="https://github.com/yanineko77/nyamiko"
WEBOS_MIN="4.0.0"

ARES="$TOOLS/ares-package"
GEN="$TOOLS/webosbrew-gen-manifest"
[ -x "$ARES" ] || { echo "нет ares-package в $TOOLS (npm i @webos-tools/cli)" >&2; exit 1; }
[ -x "$GEN" ]  || { echo "нет webosbrew-gen-manifest в $TOOLS (npm i @webosbrew/pub-utils)" >&2; exit 1; }

ID=$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$HERE/app/appinfo.json" | head -1)
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/app/appinfo.json" | head -1)
[ -n "$ID" ] && [ -n "$VER" ] || { echo "не прочитал id/version из appinfo.json" >&2; exit 1; }

mkdir -p "$OUT"

# иконки приложения: webOS ждёт маленькую (80) и большую (130)
python3 - "$ROOT/assets/icon.png" "$HERE/app/icon.png" "$HERE/app/largeIcon.png" <<'PY'
import sys
from PIL import Image
src, small, large = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(src).convert("RGBA")
im.resize((80, 80), Image.LANCZOS).save(small)
im.resize((130, 130), Image.LANCZOS).save(large)
print("иконки: %s (80x80), %s (130x130)" % (small, large))
PY

echo "проверка структуры приложения…"
"$ARES" -c "$HERE/app"

echo "собираю ipk…"
"$ARES" -n -o "$OUT" "$HERE/app"
IPK="$OUT/${ID}_${VER}_all.ipk"
[ -f "$IPK" ] || { echo "ipk не появился по ожидаемому пути $IPK" >&2; ls -la "$OUT"; exit 1; }

echo "манифест для репозитория webosbrew…"
# iconUri в манифесте должен быть публичным: по нему магазин отрисует иконку
ICON_URL="$LINK/raw/main/assets/icon.png"
"$GEN" -a "$HERE/app/appinfo.json" -p "$IPK" -i "$ICON_URL" \
       -o "$OUT/${ID}.manifest.json" -l "$LINK" -r true -w "$WEBOS_MIN"

# если задан публичный адрес сборки (например, ссылка на файл релиза),
# подставляем его в манифест: Homebrew Channel умеет ставить ipk прямо по URL
if [ -n "${IPK_URL:-}" ]; then
    python3 - "$OUT/${ID}.manifest.json" "$IPK_URL" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
data["ipkUrl"] = url
json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("ipkUrl в манифесте ->", url)
PY
fi

echo
echo "готово:"
echo "  приложение: $IPK ($(wc -c < "$IPK") байт)"
echo "  манифест:   $OUT/${ID}.manifest.json"
echo
echo "поставить на телевизор:"
echo "  ares-install $IPK        (или через Homebrew Channel по манифесту)"
