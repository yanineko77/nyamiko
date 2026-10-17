#!/bin/sh
# Добавляет хешированные ссылки для сертификатов из ca/extra/*.pem
# в подготовленный каталог ca/dir (нужно для openssl и приложений).
D=/media/internal/tv-tunnel
CA=$D/ca
DIR=$CA/dir
mkdir -p $CA/split
rm -f $CA/split/c*.pem
for f in $CA/extra/*.pem; do
    [ -f "$f" ] || continue
    awk -v out="$CA/split" -v tag="$(basename "$f" .pem)" '
      /BEGIN CERTIFICATE/ { n++; f = sprintf("%s/%s-%03d.pem", out, tag, n) }
      f != "" { print > f }
      /END CERTIFICATE/ { f = "" }' "$f"
done
ADDED=0
for f in $CA/split/*.pem; do
    H=$(openssl x509 -hash -noout -in "$f" 2>/dev/null)
    [ -z "$H" ] && continue
    [ -e "$DIR/$H.0" ] && continue
    cp -f "$f" "$DIR/$H.0" && ADDED=$((ADDED+1))
done
echo "добавлено ссылок: $ADDED"
sh /var/lib/webosbrew/init.d/55-ca-extra
