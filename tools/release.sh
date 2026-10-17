#!/bin/sh
# Сборка релизного архива Nyamiko.
#
#   sh tools/release.sh            -> nyamiko-<версия>.tar.gz в текущей папке
#   sh tools/release.sh --out DIR  -> положить архив в DIR
#
# Версия берётся из футера панели (src/ui.html) — единственного места, где она
# видна пользователю. Ключи, config.json и логи в архив не попадают.
set -eu

OUT="."
[ "${1:-}" = "--out" ] && OUT="${2:-.}"
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { sed -n '2,8p' "$0"; exit 0; }

cd "$(dirname "$0")/.." || exit 1

VER=$(sed -n 's/.*Nyamiko v\([0-9][0-9.]*\).*/\1/p' src/ui.html | head -1)
[ -n "$VER" ] || { echo "не смог определить версию в src/ui.html" >&2; exit 1; }

NAME="nyamiko-$VER"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/$NAME"

# то, что уходит в релиз
for f in install.sh LICENSE README.md README.ru.md CHANGELOG.md INSTALL.md \
         SECURITY.md .gitignore; do
    [ -e "$f" ] && cp -a "$f" "$STAGE/$NAME/"
done
for d in src docs hooks tools assets screenshots .github; do
    [ -d "$d" ] && cp -a "$d" "$STAGE/$NAME/"
done
rm -rf "$STAGE/$NAME/src/__pycache__" "$STAGE/$NAME/__pycache__"

# страховка: секретов в архиве быть не должно
if grep -rInE 'sub/[A-Za-z0-9]{12,}' "$STAGE/$NAME" 2>/dev/null | grep -v 'КЛЮЧ\|KEY' | head -3 | grep . ; then
    echo "СТОП: похоже на настоящий ключ подписки в архиве" >&2
    rm -rf "$STAGE"; exit 1
fi

mkdir -p "$OUT"
tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
rm -rf "$STAGE"
echo "$OUT/$NAME.tar.gz"
