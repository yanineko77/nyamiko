#!/bin/sh
# Nyamiko - установка и обслуживание VPN-клиента на рутованном LG webOS TV.
#
#   Установка:      sh install.sh "https://ваша-панель/sub/КЛЮЧ" [".../КЛЮЧ_ОБХОДА"]
#   Одной строкой:  curl -fsSL https://raw.githubusercontent.com/yanineko77/nyamiko/main/install.sh | sh -s -- "https://..."
#   Обновление:     sh install.sh --update      (файлы обновятся, ключи и настройки останутся)
#   Удаление:       sh install.sh --uninstall [--purge]
#
# Флаги: --no-autostart, --dir DIR, --version TAG, --help
# Ключи подписки остаются только на телевизоре (config.json, права 600).
set -u

REPO_URL="${NYAMIKO_REPO:-https://raw.githubusercontent.com/yanineko77/nyamiko/main}"
DIR_DEFAULT=/media/internal/tv-tunnel
INITD=/var/lib/webosbrew/init.d
AUTOSTART=1
MODE=install
PURGE=0

say(){ printf '%s\n' "$*"; }
step(){ printf '\n[%s] %s\n' "$1" "$2"; }
ok(){ printf '   + %s\n' "$*"; }
warn(){ printf '   ! %s\n' "$*"; }
die(){ printf '   x %s\n' "$*" >&2; exit 1; }

SUB_NORMAL=""; SUB_WHITELIST=""
while [ $# -gt 0 ]; do
    case "$1" in
        --update) MODE=update ;;
        --uninstall) MODE=uninstall ;;
        --purge) PURGE=1 ;;
        --no-autostart) AUTOSTART=0 ;;
        --dir) shift; DIR_DEFAULT="${1:-}" ;;
        --version) shift; VERSION_TAG="${1:-}"; REPO_URL="https://raw.githubusercontent.com/yanineko77/nyamiko/${VERSION_TAG}" ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) die "неизвестный флаг: $1 (справка: sh install.sh --help)" ;;
        *) if [ -z "$SUB_NORMAL" ]; then SUB_NORMAL="$1"; elif [ -z "$SUB_WHITELIST" ]; then SUB_WHITELIST="$1"; else die "лишний аргумент: $1"; fi ;;
    esac
    shift
done
DIR="$DIR_DEFAULT"

# ---------------------------------------------------------------- проверки
[ "$(id -u)" = "0" ] || die "нужен root: зайдите на телевизор как root (ssh root@<ip>)"
command -v node >/dev/null 2>&1 || warn "node не найден - панель не запустится (нужен Homebrew Channel)"
ARCH=$(uname -m)
case "$ARCH" in armv7l|armv7|aarch64|arm64) ;; *) warn "незнакомая архитектура $ARCH - ядро придётся положить руками" ;; esac
FREE=$(df -k /media/internal 2>/dev/null | awk 'NR==2{print int($4/1024)}')
if [ -n "$FREE" ] && [ "$FREE" -lt 20 ]; then die "на /media/internal меньше 20 МБ свободно (${FREE} МБ)"; fi

SRC="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
get(){  # get <путь в репозитории> <куда>
    rel="$1"; dst="$2"
    if [ -n "$SRC" ] && [ -f "$SRC/$rel" ]; then cp -f "$SRC/$rel" "$dst" && return 0; fi
    curl -fsSL -m 180 "$REPO_URL/$rel" -o "$dst"
}

# ---------------------------------------------------------------- удаление
if [ "$MODE" = "uninstall" ]; then
    step "1/3" "останавливаю клиент"
    [ -f "$DIR/tunnelctl.sh" ] && sh "$DIR/tunnelctl.sh" rescue >/dev/null 2>&1
    pkill -f "tunnelctl.sh [w]atch" 2>/dev/null
    for p in $(pgrep -f "[t]vtunnd.js"); do kill -9 "$p" 2>/dev/null; done
    pkill -x sing-box 2>/dev/null
    ok "туннель снят, интернет идёт напрямую"
    step "2/3" "убираю автозапуск"
    rm -f "$INITD/60-tvtunnel"
    [ "$PURGE" = "1" ] && rm -f "$INITD/55-ca-extra"
    ok "хуки удалены"
    step "3/3" "данные"
    if [ "$PURGE" = "1" ]; then rm -rf "$DIR"; ok "папка $DIR удалена вместе с ключами"
    else ok "папка $DIR оставлена (ключи на месте; удалить: rm -rf $DIR)"; fi
    say ""
    say "Готово."
    exit 0
fi

# ---------------------------------------------------------------- ключи
if [ "$MODE" = "install" ]; then
    if [ -z "$SUB_NORMAL" ] && [ -t 0 ]; then
        say "Ссылка на подписку (Clash/Mihomo, обычно https://панель/sub/XXXX):"
        read -r SUB_NORMAL
    fi
    [ -n "$SUB_NORMAL" ] || die "нужна ссылка на подписку. Пример: sh install.sh \"https://панель/sub/КЛЮЧ\""
    if [ -z "$SUB_WHITELIST" ] && [ -t 0 ]; then
        say "Ссылка для режима «обход белых списков» (Enter - пропустить):"
        read -r SUB_WHITELIST
    fi
fi

# ---------------------------------------------------------------- файлы
step "1/6" "файлы клиента"
mkdir -p "$DIR/state" "$DIR/ca/extra"
if [ "$MODE" = "update" ]; then
    BK="$DIR/state/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BK"
    for f in genconfig.py yamlite.py tvtunnd.js tunnelctl.sh ui.html; do
        [ -f "$DIR/$f" ] && cp -f "$DIR/$f" "$BK/$f"
    done
    ok "копия прежних файлов: $BK"
fi
for f in genconfig.py yamlite.py tvtunnd.js tunnelctl.sh ui.html; do
    get "src/$f" "$DIR/$f" || die "не скачался src/$f - проверьте интернет и адрес репозитория"
done
chmod +x "$DIR/tunnelctl.sh" "$DIR/genconfig.py"
ok "положено: genconfig.py yamlite.py tvtunnd.js tunnelctl.sh ui.html"

step "2/6" "ядро sing-box"
if [ ! -x "$DIR/sing-box" ]; then
    case "$ARCH" in
        armv7l|armv7) SB="sing-box-linux-armv7" ;;
        aarch64|arm64) SB="sing-box-linux-arm64" ;;
        *) SB="" ;;
    esac
    if [ -n "$SB" ]; then
        say "   качаю $SB (около 15 МБ, это займёт минуту)"
        if curl -sL -m 300 "https://github.com/SagerNet/sing-box/releases/latest/download/$SB.tar.gz" -o /tmp/sb.tgz; then
            gunzip -c /tmp/sb.tgz | tar -x -C /tmp 2>/dev/null
            F=$(find /tmp -maxdepth 2 -name sing-box -type f 2>/dev/null | head -1)
            [ -n "$F" ] && cp -f "$F" "$DIR/sing-box" && chmod +x "$DIR/sing-box"
            rm -f /tmp/sb.tgz
        fi
    fi
fi
[ -x "$DIR/sing-box" ] || die "ядра нет. Скачайте sing-box под $ARCH и положите в $DIR/sing-box"
ok "ядро: $("$DIR/sing-box" version 2>/dev/null | head -2 | tr '\n' ' ')"

step "3/6" "настройки"
if [ "$MODE" = "install" ]; then
    umask 077
    if [ "$AUTOSTART" = "1" ]; then AS=true; else AS=false; fi
    cat > "$DIR/config.json" <<JSON
{
  "sub_normal": "$SUB_NORMAL",
  "sub_whitelist": "$SUB_WHITELIST",
  "mode": "normal",
  "node": -1,
  "auto": true,
  "autostart": $AS
}
JSON
    chmod 600 "$DIR/config.json"
    ok "ключи сохранены только на телевизоре (права 600)"
else
    [ -f "$DIR/config.json" ] || die "нет $DIR/config.json - сначала обычная установка, потом --update"
    ok "конфигурация и ключи не тронуты"
fi

step "4/6" "автозапуск"
mkdir -p "$INITD"
get "hooks/60-tvtunnel" "$INITD/60-tvtunnel" && chmod +x "$INITD/60-tvtunnel" || warn "хук автозапуска не поставился"
if [ ! -f "$DIR/ca/orig.crt" ]; then
    get "hooks/55-ca-extra" "$INITD/55-ca-extra" && chmod +x "$INITD/55-ca-extra" || warn "хук сертификатов не поставился"
else
    ok "хранилище сертификатов уже пропатчено ранее"
fi
ok "в $INITD: $(ls "$INITD" 2>/dev/null | tr '\n' ' ')"

step "5/6" "запуск"
pkill -f "tunnelctl.sh [w]atch" 2>/dev/null
for p in $(pgrep -f "[t]vtunnd.js"); do kill -9 "$p" 2>/dev/null; done
pkill -x sing-box 2>/dev/null

# Ждём, пока порт панели действительно освободится: новый демон на занятом порту
# выходит молча (EADDRINUSE), и панель остаётся без процесса — так уже случалось.
i=0
while [ "$i" -lt 20 ]; do
    if ! curl -s -m 2 -o /dev/null http://127.0.0.1:8099/ 2>/dev/null; then break; fi
    sleep 1; i=$((i+1))
done
# и пока уйдёт интерфейс умершего туннеля
i=0
while ip link show sbtun >/dev/null 2>&1 && [ "$i" -lt 12 ]; do sleep 1; i=$((i+1)); done

rm -f "$DIR/panic"
setsid nohup node "$DIR/tvtunnd.js" >>"$DIR/daemon.log" 2>&1 </dev/null &
sleep 4

# если панель не поднялась с первой попытки — гасим остатки и пробуем ещё раз
if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/)" != "200" ]; then
    warn "панель не поднялась, повторяю запуск"
    for p in $(pgrep -f "[t]vtunnd.js"); do kill -9 "$p" 2>/dev/null; done
    sleep 3
    setsid nohup node "$DIR/tvtunnd.js" >>"$DIR/daemon.log" 2>&1 </dev/null &
    sleep 4
fi

setsid nohup sh "$DIR/tunnelctl.sh" watch >>"$DIR/ctl.log" 2>&1 </dev/null &
sleep 2
sh "$DIR/tunnelctl.sh" up normal -1 >/dev/null 2>&1
ok "демон и сторож запущены, туннель поднимается"

step "6/6" "проверка"
sleep 6
P=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/)
if [ "$P" = "200" ]; then ok "панель отвечает"; else warn "панель не ответила (код $P) - смотрите $DIR/daemon.log"; fi
Y=$(curl -s -m 25 -o /dev/null -w '%{http_code}' https://www.youtube.com/)
if [ "$Y" = "200" ]; then ok "ютуб через туннель работает"
else warn "ютуб вернул $Y - зайдите в панель и нажмите «Авто» (клиент замерит узлы и выберет живой)"; fi
E=$(curl -s -m 20 https://api.ipify.org 2>/dev/null)
ok "выходной адрес: ${E:-не определился (туннель ещё поднимается)}"
IP=$(ip -o -4 addr show wlan0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)

say ""
say "─────────────────────────────────────────────"
say " Панель: http://${IP:-<ip телевизора>}:8099/"
say " Открывается и с телефона, если он в той же сети."
say "─────────────────────────────────────────────"
say " Дальше: откройте панель и нажмите «Авто» один раз - клиент замерит"
say " узлы и сам выберет самый быстрый. Потом он переключается сам,"
say " заходить в панель больше не нужно."
say ""
say " Обновление:  sh install.sh --update"
say " Диагностика: sh $DIR/tunnelctl.sh status    (вернуть интернет: rescue)"
say " Логи:        $DIR/ctl.log, $DIR/sing-box.log, $DIR/daemon.log"
say " Удаление:    sh install.sh --uninstall [--purge]"
