#!/usr/bin/env python3
"""Тесты парсера подписок и генератора конфига Nyamiko.

Без внешних зависимостей (никакого pytest): гоняются и в CI, и на машине.
  python3 tests/run_tests.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures")
GEN = os.path.join(ROOT, "src", "genconfig.py")

FAILED = []
PASSED = [0]


def check(cond, what):
    if cond:
        PASSED[0] += 1
        print("  ok   %s" % what)
    else:
        FAILED.append(what)
        print("  FAIL %s" % what)


def gen(*args):
    p = subprocess.run([sys.executable, GEN] + list(args), capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def nodes_of(fixture):
    rc, out, err = gen("--sub", os.path.join(FIX, fixture), "--list")
    assert rc == 0, "genconfig упал на %s: %s" % (fixture, err[:300])
    return json.loads(out)


def stats_of(fixture):
    rc, out, err = gen("--sub", os.path.join(FIX, fixture), "--stats")
    assert rc == 0, "genconfig --stats упал: %s" % err[:300]
    return json.loads(out)


def config_of(fixture, *extra):
    out_path = "/tmp/nyamiko-test-cfg.json"
    rc, out, err = gen("--sub", os.path.join(FIX, fixture), "--mode", "normal",
                       "--core", "203.0.113.10", "--out", out_path, *extra)
    assert rc == 0, "генерация конфига упала: %s / %s" % (out[-300:], err[-300:])
    with open(out_path, encoding="utf-8") as f:
        return json.load(f)


print("\n== URI-подписка (плоский список) ==")
uri = nodes_of("uris.txt")
types = [n["type"] for n in uri]
check(len(uri) == 7, "все 7 URI разобраны (получено %d)" % len(uri))
for want in ("vless", "trojan", "hysteria2", "shadowsocks", "tuic", "vmess"):
    check(want in types, "есть узел типа %s" % want)

print("\n== URI-подписка (base64) ==")
b64 = nodes_of("uris.txt.b64")
check(len(b64) == len(uri), "base64-список даёт столько же узлов (%d/%d)" % (len(b64), len(uri)))

print("\n== Clash YAML, плоский стиль ==")
flat = nodes_of("clash-full.yaml")
flat_stats = stats_of("clash-full.yaml")
flat_types = [n["type"] for n in flat]
check(len(flat) == 9, "9 рабочих узлов, xhttp и битый отброшены (получено %d)" % len(flat))
check(flat_stats["dropped"].get("network:xhttp") == 1, "xhttp посчитан как отброшенный")
check(flat_stats["dropped"].get("bad-server-address") == 1, "узел без сервера посчитан")
check("hysteria2" in flat_types and "shadowsocks" in flat_types and "tuic" in flat_types,
      "hysteria2 / ss / tuic разобраны")

print("\n== Clash YAML, блочный стиль с анкорами ==")
block = nodes_of("clash-block.yaml")
block_stats = stats_of("clash-block.yaml")
check(len(block) == 3, "3 узла, xhttp отброшен (получено %d)" % len(block))
check(block_stats["dropped"].get("network:xhttp") == 1, "xhttp в блоке посчитан")
check([n["type"] for n in block] == ["vless", "trojan", "vmess"], "типы узлов верные")

print("\n== Транспорты в конфиге ==")
cfg = config_of("clash-full.yaml")
by_tag = {}
outs = cfg["outbounds"]
for o in outs:
    if o.get("tag") == "n0":
        by_tag["reality"] = o
transports = {o.get("transport", {}).get("type") for o in outs if o.get("transport")}
check("ws" in transports, "ws-транспорт попал в конфиг")
check("grpc" in transports, "grpc-транспорт попал в конфиг")
check("http" in transports, "h2/http-транспорт поддержан (раньше узел пропадал)")
check("httpupgrade" in transports, "httpupgrade-транспорт поддержан")
check("quic" in transports, "quic-транспорт поддержан")
check("xhttp" not in transports, "xhttp в конфиг не попадает")
r = by_tag["reality"]
check(r.get("tls", {}).get("reality", {}).get("public_key", "").startswith("PUBKEY"),
      "VLESS+Reality: публичный ключ на месте")
check(r.get("flow") == "xtls-rprx-vision", "VLESS+Reality: сохранён flow")

print("\n== Структура конфига ==")
inbounds = {i["type"] for i in cfg["inbounds"]}
check("tun" in inbounds and "direct" in inbounds, "tun-инбаунд и локальный DNS на месте")
check(cfg["certificate"]["store"] == "mozilla", "подставлен встроенный store сертификатов")
check(cfg["experimental"]["clash_api"]["external_controller"] == "127.0.0.1:9090",
      "Clash API включён (панель без него не переключает узлы)")
tags = [o["tag"] for o in outs]
check("vpn" in tags and "direct" in tags, "selector и direct есть")
check(all(("n%d" % i) in tags for i in range(9)), "все узлы получили теги n0..n8")
check(cfg["route"]["final"] == "vpn", "весь трафик уходит в selector")
check(all(o.get("bind_interface") == "wlan0"
          for o in outs if o["tag"].startswith("n")), "сокеты клиента привязаны к wlan0")
rules = cfg["route"]["rules"]
check(any(r.get("action") == "sniff" for r in rules), "правило sniff есть")
check(any(r.get("ip_is_private") for r in rules), "локальная сеть идёт мимо туннеля")
check(any("vk.com" in (r.get("domain_suffix") or []) for r in rules), "VK остаётся напрямую")
check(any(r.get("ip_cidr", [""])[0] == "203.0.113.10/32" for r in rules),
      "адрес узла исключён из туннеля (защита от петли)")

print("\n== Шлюз для прямого DNS ==")
cfg_gw = config_of("uris.txt", "--gw", "10.0.0.1")
server = [s for s in cfg_gw["dns"]["servers"] if s["tag"] == "dns-direct"][0]["server"]
check(server == "10.0.0.1", "переданный шлюз попал в dns-direct")
check(server != "192.168.1.1", "домашний адрес разработчика не зашит")

print("\n== Выбор узла и режимы ==")
cfg2 = config_of("uris.txt")
sel = [o for o in cfg2["outbounds"] if o["tag"] == "vpn"][0]
check(len(sel["outbounds"]) == 7, "в selector попали все узлы")
check(sel["default"] == "n0", "по умолчанию выбран первый узел")
rc, out, _ = gen("--sub", os.path.join(FIX, "uris.txt"), "--node", "99", "--out", "/tmp/nyamiko-test-cfg2.json")
check(rc == 0, "номер узла вне диапазона не роняет генерацию")

print("\n== Пустая и мусорная подписка ==")
empty = "/tmp/nyamiko-empty.raw"
open(empty, "w").write("")
rc, out, err = gen("--sub", empty, "--out", "/tmp/nyamiko-test-empty.json")
check(rc != 0, "пустая подписка даёт ошибку, а не пустой конфиг")
open(empty, "w").write("это не подписка\n")
rc, out, err = gen("--sub", empty, "--out", "/tmp/nyamiko-test-empty.json")
check(rc != 0, "мусорный файл тоже даёт ошибку")

print("\n== yamlite: разбор YAML ==")
sys.path.insert(0, os.path.join(ROOT, "src"))
import yamlite  # noqa: E402
doc = yamlite.load("""
proxies:
  - name: "A: #1"
    type: vless
    opts:
      path: "/x"
      host: "example.com"
      flag: true
      num: 443
list: [1, "два", false]
""")
check(doc["proxies"][0]["name"] == "A: #1", "двоеточие и решётка внутри кавычек не ломают разбор")
check(doc["proxies"][0]["opts"]["path"] == "/x", "вложенный словарь разобран")
check(doc["proxies"][0]["opts"]["flag"] is True, "true → True")
check(doc["proxies"][0]["opts"]["num"] == 443, "число → int")
check(doc["list"] == [1, "два", False], "потоковый список разобран")

print("\n" + "=" * 52)
print("пройдено: %d, провалено: %d" % (PASSED[0], len(FAILED)))
for f in FAILED:
    print("  - %s" % f)
sys.exit(1 if FAILED else 0)
