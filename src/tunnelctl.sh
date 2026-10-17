#!/bin/sh
# tunnelctl.sh - routing/lifecycle control for the LG TV sing-box tunnel client.
# busybox sh compatible (webOS 4.x). Runs as root.
#
#   tunnelctl.sh up <normal|whitelist> [node-index]
#   tunnelctl.sh down
#   tunnelctl.sh status
#   tunnelctl.sh nodes <mode>
#   tunnelctl.sh fetch <mode>
#   tunnelctl.sh set <key> <value>
#   tunnelctl.sh check
#   tunnelctl.sh watch            (loop; watchdog, started at boot)
#
# Routing model (kernel 4.4 on this TV has no policy routing):
#   * default route is moved onto the tun device
#   * the proxy server's IP gets a /32 route out of the physical interface,
#     so the client's own traffic never loops back into the tunnel
#   * LAN traffic stays direct (link routes are untouched)

DIR=/media/internal/tv-tunnel
SB="$DIR/sing-box"
PY=/usr/bin/python
LOG="$DIR/ctl.log"
STATE="$DIR/state"
TUN=sbtun
CHECK_URL="http://cp.cloudflare.com/generate_204"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

conf() { $PY -c "import json;d=json.load(open('$DIR/config.json'));print(d.get('$1',''))" 2>/dev/null; }

phys_iface() {
    ip route | awk '/^default/ && $0 !~ /sbtun/ {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}' | head -1
}

phys_gw() {
    ip route | awk '/^default/ && $0 !~ /sbtun/ {for(i=1;i<=NF;i++) if($i=="via") {print $(i+1); exit}}' | head -1
}

singbox_alive() { pgrep -x sing-box >/dev/null 2>&1; }

acquire_lock() {
    mkdir "$DIR/lock" 2>/dev/null && { date '+%s' > "$DIR/lock/at"; return 0; }
    at=$(cat "$DIR/lock/at" 2>/dev/null || echo 0)
    now=$(date '+%s')
    if [ $((now - at)) -gt 240 ]; then
        log "up: removing a stale start lock"
        rm -rf "$DIR/lock"
        mkdir "$DIR/lock" 2>/dev/null && { date '+%s' > "$DIR/lock/at"; return 0; }
    fi
    return 1
}

up() {
    # the watchdog and the panel can both ask for a start at the same moment
    acquire_lock || { log "up: another start is already running"; return 1; }
    up_body "$@"
    rc=$?
    rm -rf "$DIR/lock"
    return $rc
}

tun_up() { ip -o link show 2>/dev/null | grep -q "$TUN"; }

restore_default() {
    IFACE=$(cat "$STATE/iface" 2>/dev/null)
    GW=$(cat "$STATE/gw" 2>/dev/null)
    [ -z "$IFACE" ] && IFACE=$(phys_iface)
    [ -z "$GW" ] && GW=$(phys_gw)
    if [ -n "$IFACE" ] && [ -n "$GW" ]; then
        ip route del default dev "$TUN" metric 0 2>/dev/null
        ip route del default dev "$TUN" metric 1 2>/dev/null
        ip route del default via "$GW" dev "$IFACE" metric 100 2>/dev/null
        ip route del default 2>/dev/null
        ip route replace default via "$GW" dev "$IFACE" 2>/dev/null
        log "default restored via $GW dev $IFACE"
    fi
}

pin_server() {
    # $1 = server ip
    [ -z "$1" ] && return 0
    [ "$1" = "0.0.0.0" ] && return 0
    IFACE=$(cat "$STATE/iface" 2>/dev/null); [ -z "$IFACE" ] && IFACE=$(phys_iface)
    GW=$(cat "$STATE/gw" 2>/dev/null); [ -z "$GW" ] && GW=$(phys_gw)
    ip route add "$1/32" via "$GW" dev "$IFACE" 2>/dev/null
    log "pinned $1/32 via $GW dev $IFACE"
}

resolve_host() {
    host="$1"
    case "$host" in
        *[!0-9.]*) : ;;                 # contains something non-numeric -> a name
        *) [ -n "$host" ] && { echo "$host"; return 0; } ;;
    esac
    ip=""
    if command -v getent >/dev/null 2>&1; then
        ip=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.' | head -1)
    fi
    if [ -z "$ip" ]; then
        GW=$(phys_gw)
        ip=$(nslookup "$host" "$GW" 2>/dev/null | awk '/^Name:/{seen=1} seen && /^Address/{print $3; exit}')
    fi
    echo "$ip"
}

dns_mount_on() {
    # point the TV's resolver at public IPs: the queries land in the TUN, get
    # hijacked by sing-box and answered over DoH through the proxy - no UDP
    # through the proxy node, no ISP resolver in the loop
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$DIR/resolv.conf"
    mount --bind "$DIR/resolv.conf" /etc/resolv.conf 2>/dev/null && \
        log "resolv.conf -> public resolvers via the tunnel" || log "dns: bind mount failed"
}

dns_mount_off() {
    umount /etc/resolv.conf 2>/dev/null && log "resolv.conf restored"
}

fetch_sub() {
    mode="$1"
    url=$(conf "sub_$mode")
    [ -z "$url" ] && { log "fetch: no url for $mode"; return 1; }

    # Remnawave panels hand out a stub ("App not supported") unless the client
    # identifies the device: x-hwid + device headers. The HWID is derived from
    # this TV's wlan0 MAC and stays on the device.
    MAC=$(cat /sys/class/net/wlan0/address 2>/dev/null | tr -d ':')
    HWID=$($PY -c "import hashlib;print(hashlib.sha256('$MAC'.encode()).hexdigest()[:16].upper())" 2>/dev/null)

    curl -sL -m 120 -A 'Mihomo/1.19.32' \
        -H "x-hwid: $HWID" -H 'x-device-os: Linux' -H 'x-ver-os: Linux' \
        -H 'x-device-model: LG webOS TV' \
        "$url" -o "$DIR/sub-$mode.raw"
    rc=$?
    size=$(wc -c < "$DIR/sub-$mode.raw" 2>/dev/null)
    log "fetched $mode: rc=$rc bytes=$size"
    [ "$rc" = 0 ] && [ -n "$size" ] && [ "$size" -gt 100 ] || rc=1

    # the panel answers with a one-node stub (server 0.0.0.0) when it does not
    # like the request - either encoded or as plain text
    if [ "$rc" = 0 ]; then
        real=$($PY "$DIR/genconfig.py" --sub "$DIR/sub-$mode.raw" --list 2>/dev/null | \
               $PY -c "import json,sys;
try:
    n=json.load(sys.stdin)
    print(sum(1 for x in n if x.get('server') not in ('', '0.0.0.0')))
except Exception:
    print(0)")
        [ "$real" -gt 0 ] 2>/dev/null || { log "fetch: profile looks empty (stub)"; rc=1; }
    fi

    if [ "$rc" = 0 ]; then
        cp -f "$DIR/sub-$mode.raw" "$DIR/sub-$mode.good"
        log "fetch: ok, ${real} usable nodes"
        return 0
    fi

    if [ -f "$DIR/sub-$mode.good" ]; then
        cp -f "$DIR/sub-$mode.good" "$DIR/sub-$mode.raw"
        log "fetch: using cached profile from the last successful fetch"
        return 0
    fi
    return 1
}

do_fetch_all() { fetch_sub normal; fetch_sub whitelist; }

up_body() {
    mode="$1"
    [ -z "$mode" ] && mode=$(conf mode)
    [ -z "$mode" ] && mode=normal
    node="${2:-0}"

    IFACE=$(phys_iface); GW=$(phys_gw)
    ip route | grep '^default' | grep -v "$TUN" | head -1 > "$DIR/.orig_default"
    printf '%s' "$IFACE" > "$STATE/iface"
    printf '%s' "$GW" > "$STATE/gw"
    log "up: mode=$mode node=$node iface=$IFACE gw=$GW"

    # tear the old tunnel down first: the subscription panel binds the HWID to
    # the home address and answers with a stub when the request comes out of
    # the VPN, so the fetch must always happen on the direct path
    dns_mount_off
    pkill -x sing-box 2>/dev/null
    ip route del default dev "$TUN" metric 0 2>/dev/null
    ip route del default dev "$TUN" metric 1 2>/dev/null
    ip route del default via "$GW" dev "$IFACE" metric 100 2>/dev/null
    ip route replace default via "$GW" dev "$IFACE" 2>/dev/null
    sleep 3

    if ! fetch_sub "$mode"; then
        log "up: subscription fetch failed for $mode"
        printf 'error: no subscription for %s\n' "$mode" > "$STATE/last_error"
        return 1
    fi

    server=$($PY "$DIR/genconfig.py" --sub "$DIR/sub-$mode.raw" --list 2>/dev/null | \
             $PY -c "import json,sys;
try:
    n=json.load(sys.stdin); i=int('$node'); i=i if 0<=i<len(n) else 0; print(n[i]['server'])
except Exception: print('')")
    sip=$(resolve_host "$server")
    log "up: server=$server ip=$sip"

    $PY "$DIR/genconfig.py" --sub "$DIR/sub-$mode.raw" --mode "$mode" --node "$node" \
        --core "$sip" --iface "$IFACE" --out "$DIR/cfg-current.json" >> "$LOG" 2>&1 || {
        log "up: config generation failed"
        printf 'error: bad subscription\n' > "$STATE/last_error"
        return 1
    }

    case "$sip" in
        ""|"0.0.0.0")
            log "up: no usable node (placeholder subscription)"
            printf 'error: subscription gave no usable node\n' > "$STATE/last_error"
            down >/dev/null 2>&1
            return 1
        ;;
    esac

    cfg_ok=1
    "$SB" check -c "$DIR/cfg-current.json" >> "$LOG" 2>&1 || cfg_ok=0
    [ "$cfg_ok" = 0 ] && { log "up: core rejected config"; printf 'error: config invalid\n' > "$STATE/last_error"; return 1; }

    "$SB" run -c "$DIR/cfg-current.json" > "$DIR/sing-box.out" 2>&1 &
    n=0
    while [ $n -lt 20 ]; do
        tun_up && break
        sleep 1; n=$((n+1))
    done
    if ! tun_up; then
        log "up: tun did not come up"
        printf 'error: tun failed\n' > "$STATE/last_error"
        down >/dev/null 2>&1
        return 1
    fi

    pin_server "$sip"
    # two default routes: the tun wins on metric, while sockets bound to the
    # physical device (sing-box's own dials) still find a route out via wlan0
    # the interface manager (connman) keeps its own metric-0 default, so ours
    # has to take metric 0 as well - otherwise it never wins the lookup
    ip route del default via "$GW" dev "$IFACE" 2>/dev/null
    ip route replace default dev "$TUN" metric 0 2>/dev/null
    ip route replace default via "$GW" dev "$IFACE" metric 100 2>/dev/null
    log "default -> $TUN (metric 0), physical fallback via $GW metric 100"

    # both modes get the tunnel resolver: the ISP then never sees the queries
    if true; then
        dns_mount_on
    fi

    printf '%s' "$mode" > "$STATE/mode"
    printf '%s' "$node" > "$STATE/node"
    printf '%s' "$sip" > "$STATE/server_ip"
    printf '%s' "$server" > "$STATE/server"
    date '+%s' > "$STATE/since"
    date '+%s' > "$STATE/sub_updated"
    rm -f "$STATE/last_error"

    # the tunnel needs a moment to come up (handshake, first packets)
    try=0
    while [ $try -lt 8 ]; do
        if check >/dev/null 2>&1; then
            log "up: tunnel verified (after ${try} retries)"
            printf 'up' > "$STATE/state"
            rm -f "$DIR/fail_count"
            return 0
        fi
        try=$((try+1))
        sleep 4
    done
    log "up: verification failed, rolling back"
    printf 'error: tunnel not working\n' > "$STATE/last_error"
    down >/dev/null 2>&1
    return 1
}

down() {
    log "down"
    dns_mount_off
    pkill -x sing-box 2>/dev/null
    sleep 1
    restore_default
    sip=$(cat "$STATE/server_ip" 2>/dev/null)
    [ -n "$sip" ] && ip route del "$sip/32" 2>/dev/null
    ip route del 0.0.0.0/32 2>/dev/null
    tun_up && ip link delete "$TUN" 2>/dev/null
    printf 'down' > "$STATE/state"
    rm -f "$STATE/mode"
}

check() {
    code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$CHECK_URL" 2>/dev/null)
    [ "$code" = "204" ] || [ "$code" = "200" ]
}

status() {
    echo "state=$(cat "$STATE/state" 2>/dev/null)"
    echo "mode=$(cat "$STATE/mode" 2>/dev/null)"
    echo "node=$(cat "$STATE/node" 2>/dev/null)"
    echo "server=$(cat "$STATE/server" 2>/dev/null)"
    echo "server_ip=$(cat "$STATE/server_ip" 2>/dev/null)"
    echo "since=$(cat "$STATE/since" 2>/dev/null)"
    echo "error=$(cat "$STATE/last_error" 2>/dev/null)"
    if singbox_alive; then echo "core=running"; else echo "core=stopped"; fi
    if tun_up; then echo "tun=up"; else echo "tun=down"; fi
    echo "default=$(ip route | grep '^default' | head -1)"
}

watch() {
    # watchdog: keep the tunnel honest, never leave the TV without internet.
    # A "panic" file (touch /media/internal/tv-tunnel/panic) freezes it.
    fails=0
    restarts=0
    while true; do
        sleep 20
        # the panel is a service of its own: it has to answer even when the
        # tunnel is down, because that is how the tunnel gets switched on
        if ! curl -s -m 4 -o /dev/null http://127.0.0.1:8099/api/status 2>/dev/null; then
            log "watch: panel is not answering, restarting it"
            ( cd "$DIR" && setsid sh -c 'cd '"$DIR"' && node tvtunnd.js >> daemon.log 2>&1' >>/dev/null 2>&1 & )
        fi
        [ -e "$DIR/panic" ] && { restarts=0; fails=0; continue; }
        [ "$(cat "$STATE/state" 2>/dev/null)" = "up" ] || { restarts=0; continue; }
        # мусор от заливок (base64-копии) ест оперативную память: /tmp - это tmpfs
        find /tmp -maxdepth 1 -name "*.b64" -mtime +0 -delete 2>/dev/null
        # unbounded logs would fill /media/internal sooner or later
        for lf in sing-box.log ctl.log daemon.log; do
            if [ -f "$DIR/$lf" ] && [ "$(wc -c < "$DIR/$lf" 2>/dev/null || echo 0)" -gt 524288 ]; then
                tail -c 65536 "$DIR/$lf" > "$DIR/$lf.trim" 2>/dev/null &&
                    cat "$DIR/$lf.trim" > "$DIR/$lf" && rm -f "$DIR/$lf.trim"
            fi
        done

        # раз в сутки тянем свежий профиль: подписка меняется (новые узлы,
        # смена адресов), а панель отдаёт заглушку, если запрос уходит через
        # сам туннель - поэтому опускаем, обновляем, поднимаем обратно
        SUB_LAST=$(cat "$STATE/sub_updated" 2>/dev/null || echo 0)
        SUB_NOW=$(date '+%s')
        if [ $((SUB_NOW - SUB_LAST)) -gt 79200 ]; then
            log "watch: обновляю профиль подписки (прошло больше 22 часов)"
            SUB_MODE=$(cat "$STATE/mode" 2>/dev/null); [ -z "$SUB_MODE" ] && SUB_MODE=normal
            SUB_NODE=$(cat "$STATE/node" 2>/dev/null); [ -z "$SUB_NODE" ] && SUB_NODE=0
            down >/dev/null 2>&1
            FRESH=1
            fetch_sub normal >/dev/null 2>&1 || FRESH=0
            fetch_sub whitelist >/dev/null 2>&1 || true
            # метку ставим только если профиль правда обновился, иначе попробуем
            # снова через 20 минут, а не через сутки
            if [ "$FRESH" = 1 ]; then
                date '+%s' > "$STATE/sub_updated"
            else
                log "watch: профиль обновить не удалось, повторю позже"
                date '+%s' > "$DIR/.sub_retry"
            fi
            up "$SUB_MODE" "$SUB_NODE" >/dev/null 2>&1
            continue
        fi

        if ! singbox_alive || ! tun_up; then
            restarts=$((restarts+1))
            if [ $restarts -gt 3 ]; then
                log "watch: too many restarts, giving up (state -> down)"
                printf 'error: watchdog gave up after repeated failures\n' > "$STATE/last_error"
                down >/dev/null 2>&1
                restarts=0
                continue
            fi
            log "watch: core/tun gone, restart attempt $restarts"
            up "$(cat "$STATE/mode" 2>/dev/null)" "$(cat "$STATE/node" 2>/dev/null)"
            continue
        fi

        restarts=0
        if ! ip route | grep -q "default dev $TUN"; then
            log "watch: tunnel route lost, re-asserting"
            ip route replace default dev "$TUN" metric 0 2>/dev/null
        fi
        if check; then
            fails=0
        else
            fails=$((fails+1))
            log "watch: connectivity check failed ($fails/3)"
            if [ $fails -ge 3 ]; then
                log "watch: restoring direct internet"
                printf 'error: watchdog restored direct routing\n' > "$STATE/last_error"
                down >/dev/null 2>&1
                fails=0
            fi
        fi
    done
}

rescue() {
    # emergency: freeze automation, tear the tunnel down, put normal routing back
    touch "$DIR/panic"
    pkill -f '[t]unnelctl.sh watch' 2>/dev/null
    pkill -x sing-box 2>/dev/null
    IFACE=$(cat "$STATE/iface" 2>/dev/null); GW=$(cat "$STATE/gw" 2>/dev/null)
    [ -z "$IFACE" ] && IFACE=$(phys_iface)
    [ -z "$GW" ] && GW=$(phys_gw)
    [ -n "$IFACE" ] && [ -n "$GW" ] && {
        ip route del default dev "$TUN" 2>/dev/null
        ip route del default via "$GW" dev "$IFACE" metric 100 2>/dev/null
        ip route del default 2>/dev/null
        ip route replace default via "$GW" dev "$IFACE" 2>/dev/null
    }
    tun_up && ip link delete "$TUN" 2>/dev/null
    printf 'down' > "$STATE/state"
    rm -f "$STATE/mode"
    echo "rescue done: panic freeze set, routing restored"
}

case "$1" in
    up) shift; up "$@";;
    down) down;;
    status) status;;
    check) check && echo ok || echo fail;;
    nodes) $PY "$DIR/genconfig.py" --sub "$DIR/sub-$2.raw" --list 2>&1;;
    fetch) fetch_sub "$2" && echo ok || echo fail;;
    set) $PY - "$DIR/config.json" "$2" "$3" <<'PYEOF'
import json, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
if value in ("true", "false"):
    d[key] = (value == "true")
else:
    try:
        d[key] = int(value)
    except ValueError:
        d[key] = value
json.dump(d, open(path, "w"), ensure_ascii=False, indent=1)
print("%s=%s" % (key, d[key]))
PYEOF
    ;;
    watch) watch;;
    rescue) rescue;;
    panic-off) rm -f "$DIR/panic"; echo "panic cleared";;
    *) echo "usage: tunnelctl.sh {up MODE [NODE]|down|status|check|nodes MODE|fetch MODE|set KEY VALUE|watch|rescue|panic-off}"; exit 1;;
esac
