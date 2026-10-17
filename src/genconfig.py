#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Subscription -> sing-box config generator for the LG TV tunnel client.

Python 2.7 compatible (webOS ships 2.7). Reads a raw subscription file
(base64 list of node URIs, plain URI list, Clash YAML, or sing-box JSON)
and writes a sing-box config with a TUN inbound and the routing policy
for the requested mode.

Usage:
  python genconfig.py --sub FILE --mode normal|whitelist [--out FILE] [--node N] [--core IP]
"""
import base64
import json
import optparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import yamlite
except Exception:  # pragma: no cover
    yamlite = None

VK_SUFFIXES = [
    "vk.com", "vk.ru", "vkvideo.ru", "vkvideo.com", "vk-cdn.net", "vk-cdn.ru",
    "mycdn.me", "userapi.com", "vk-analytics.com", "vkuseraudio.net",
    "vkuservideo.net", "vksite.ru", "vk-portal.net", "dzen.ru",
]

TUN_NAME = "sbtun"
TUN_ADDR = "172.19.0.1/30"


# ---------------------------------------------------------------- URI parsing

def b64d(s):
    s = s.strip().replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    try:
        return base64.b64decode(s)
    except Exception:
        return ""


def qs(part):
    out = {}
    if not part:
        return out
    for kv in part.split("&"):
        if not kv:
            continue
        if "=" in kv:
            k, v = kv.split("=", 1)
        else:
            k, v = kv, ""
        out[k.strip()] = v.strip()
    return out


def _tls_block(sec, sni, fp, alpn=None, insecure=False):
    if sec == "reality":
        return {
            "enabled": True,
            "server_name": sni,
            "utls": {"enabled": True, "fingerprint": fp or "chrome"},
            "reality": {"enabled": True, "public_key": "", "short_id": ""},
        }
    if sec == "tls":
        tls = {"enabled": True, "server_name": sni or None,
               "utls": {"enabled": True, "fingerprint": fp or "chrome"}}
        if alpn:
            tls["alpn"] = alpn
        if insecure:
            tls["insecure"] = True
        return {k: v for k, v in tls.items() if v is not None}
    return None


def transport(net, host, path, service, mode=None):
    net = (net or "tcp").lower()
    if net in ("", "tcp"):
        return None
    if net == "ws":
        t = {"type": "ws", "path": path or "/"}
        if host:
            t["headers"] = {"Host": host}
        return t
    if net == "grpc":
        return {"type": "grpc", "service_name": service or ""}
    if net == "httpupgrade":
        t = {"type": "httpupgrade", "path": path or "/"}
        if host:
            t["host"] = host
        return t
    return None


def parse_vless(uri, name):
    body = uri[len("vless://"):]
    main, _, frag = body.partition("#")
    if frag and not name:
        name = frag
    userinfo, _, hostport = main.rpartition("@")
    uuid = userinfo
    host, _, port = hostport.partition(":")
    host, port = host.split("?")[0], port.split("?")[0]
    q = qs(main.split("?", 1)[1]) if "?" in main else {}
    out = {
        "type": "vless", "tag": name or ("vless-%s" % host), "server": host,
        "server_port": int(port or 443), "uuid": uuid,
        "packet_encoding": "xudp",
    }
    flow = q.get("flow")
    if flow:
        out["flow"] = flow
    t = transport(q.get("type"), q.get("host"), q.get("path"), q.get("serviceName"), q.get("mode"))
    if t:
        out["transport"] = t
    sec = (q.get("security") or "none").lower()
    if sec == "reality":
        pbk, sid = q.get("pbk", ""), q.get("sid", "")
        out["tls"] = {
            "enabled": True, "server_name": q.get("sni") or host,
            "utls": {"enabled": True, "fingerprint": q.get("fp") or "chrome"},
            "reality": {"enabled": True, "public_key": pbk, "short_id": sid},
        }
    elif sec == "tls":
        tls = {"enabled": True, "server_name": q.get("sni") or host,
               "utls": {"enabled": True, "fingerprint": q.get("fp") or "chrome"}}
        if q.get("alpn"):
            tls["alpn"] = [a for a in q["alpn"].split(",") if a]
        if q.get("allowInsecure") in ("1", "true"):
            tls["insecure"] = True
        out["tls"] = tls
    return out


def parse_vmess(uri, name):
    raw = uri[len("vmess://"):]
    data = b64d(raw.split("#")[0])
    j = json.loads(data)
    host = j.get("add")
    port = int(j.get("port") or 443)
    out = {
        "type": "vmess", "tag": name or j.get("ps") or ("vmess-%s" % host),
        "server": host, "server_port": port, "uuid": j.get("id"),
        "security": j.get("scy") or "auto", "alter_id": int(j.get("aid") or 0),
    }
    net = j.get("net")
    if net == "ws":
        t = {"type": "ws", "path": j.get("path") or "/"}
        if j.get("host"):
            t["headers"] = {"Host": j["host"]}
        out["transport"] = t
    elif net == "grpc":
        out["transport"] = {"type": "grpc", "service_name": j.get("path") or ""}
    elif net == "h2":
        t = {"type": "http", "path": j.get("path") or "/"}
        if j.get("host"):
            t["host"] = [j["host"]]
        out["transport"] = t
    if (j.get("tls") or "") in ("tls", "true", True):
        tls = {"enabled": True, "server_name": j.get("sni") or j.get("host") or host}
        if j.get("alpn"):
            tls["alpn"] = [a for a in str(j["alpn"]).split(",") if a]
        out["tls"] = tls
    return out


def parse_trojan(uri, name):
    main = uri[len("trojan://"):].split("#")[0]
    passwd, _, hostport = main.rpartition("@")
    host, _, port = hostport.partition(":")
    q = qs(main.split("?", 1)[1]) if "?" in main else {}
    host, port = host.split("?")[0], port.split("?")[0]
    out = {"type": "trojan", "tag": name or ("trojan-%s" % host), "server": host,
           "server_port": int(port or 443), "password": passwd}
    t = transport(q.get("type"), q.get("host"), q.get("path"), q.get("serviceName"))
    if t:
        out["transport"] = t
    tls = {"enabled": True, "server_name": q.get("sni") or host}
    if q.get("allowInsecure") in ("1", "true"):
        tls["insecure"] = True
    out["tls"] = tls
    return out


def parse_ss(uri, name):
    main = uri[len("ss://"):].split("#")[0]
    if "@" in main:
        userinfo, _, hostport = main.rpartition("@")
        if ":" in userinfo and not userinfo.startswith(""):
            dec = b64d(userinfo)
            userinfo = dec if dec else userinfo
        method, _, password = userinfo.partition(":")
        host, _, port = hostport.partition(":")
    else:
        dec = b64d(main)
        methodpass, _, hostport = dec.rpartition("@")
        method, _, password = methodpass.partition(":")
        host, _, port = hostport.partition(":")
    return {"type": "shadowsocks", "tag": name or ("ss-%s" % host),
            "server": host, "server_port": int(port or 8388),
            "method": method, "password": password}


def parse_hy2(uri, name):
    scheme = "hysteria2://" if uri.startswith("hysteria2://") else "hy2://"
    main = uri[len(scheme):].split("#")[0]
    auth, _, hostport = main.rpartition("@")
    q = qs(main.split("?", 1)[1]) if "?" in main else {}
    host, _, port = hostport.partition(":")
    host, port = host.split("?")[0], port.split("?")[0]
    out = {"type": "hysteria2", "tag": name or ("hy2-%s" % host), "server": host,
           "server_port": int(port or 443), "password": auth}
    tls = {"enabled": True, "server_name": q.get("sni") or host}
    if q.get("insecure") in ("1", "true"):
        tls["insecure"] = True
    out["tls"] = tls
    if q.get("obfs") == "salamander" and q.get("obfs-password"):
        out["obfs"] = {"type": "salamander", "password": q["obfs-password"]}
    return out


def parse_tuic(uri, name):
    main = uri[len("tuic://"):].split("#")[0]
    creds, _, hostport = main.rpartition("@")
    uuid, _, password = creds.partition(":")
    q = qs(main.split("?", 1)[1]) if "?" in main else {}
    host, _, port = hostport.partition(":")
    host, port = host.split("?")[0], port.split("?")[0]
    out = {"type": "tuic", "tag": name or ("tuic-%s" % host), "server": host,
           "server_port": int(port or 443), "uuid": uuid, "password": password,
           "congestion_control": "bbr"}
    tls = {"enabled": True, "server_name": q.get("sni") or host, "alpn": ["h3"]}
    if q.get("allow_insecure") in ("1", "true"):
        tls["insecure"] = True
    out["tls"] = tls
    return out


PARSERS = {
    "vless://": parse_vless, "vmess://": parse_vmess, "trojan://": parse_trojan,
    "ss://": parse_ss, "hysteria2://": parse_hy2, "hy2://": parse_hy2, "tuic://": parse_tuic,
}


def parse_uri(uri):
    uri = uri.strip()
    for prefix, fn in PARSERS.items():
        if uri.startswith(prefix):
            name = ""
            if "#" in uri:
                name = uri.split("#", 1)[1]
                name = re.sub(r"[^0-9A-Za-zА-Яа-яЁё _.-]", "", name)[:40]
            try:
                out = fn(uri, name)
            except Exception:
                return None
            if not out.get("server") or not out.get("server_port"):
                return None
            return out
    return None



def clash_proxy_to_outbound(p):
    """Convert one Clash proxy mapping into a sing-box outbound (or None)."""
    t = (p.get("type") or "").lower()
    net = (p.get("network") or "tcp").lower()
    if net not in ("", "tcp", "ws", "grpc"):
        return None                      # xhttp/h2 etc. are not supported by sing-box 1.14
    name = p.get("name") or p.get("server")
    host = p.get("server")
    port = p.get("port")
    if not host or not port:
        return None
    out = {"tag": name, "server": host, "server_port": int(port)}
    tls = None
    sni = p.get("servername") or p.get("sni")
    fp = p.get("client-fingerprint") or "chrome"

    if t == "vless":
        out.update({"type": "vless", "uuid": p.get("uuid"), "packet_encoding": "xudp"})
        if p.get("flow"):
            out["flow"] = p["flow"]
        if p.get("tls"):
            if p.get("reality-opts"):
                ro = p["reality-opts"] or {}
                tls = {"enabled": True, "server_name": sni or host,
                       "utls": {"enabled": True, "fingerprint": fp},
                       "reality": {"enabled": True,
                                   "public_key": ro.get("public-key", ""),
                                   "short_id": ro.get("short-id", "") or ""}}
            else:
                tls = {"enabled": True, "server_name": sni or host,
                       "utls": {"enabled": True, "fingerprint": fp}}
    elif t == "vmess":
        out.update({"type": "vmess", "uuid": p.get("uuid"),
                    "security": p.get("cipher") or "auto",
                    "alter_id": int(p.get("alterId") or 0)})
        if p.get("tls"):
            tls = {"enabled": True, "server_name": sni or host}
    elif t == "trojan":
        out.update({"type": "trojan", "password": p.get("password")})
        tls = {"enabled": True, "server_name": sni or host}
    elif t in ("ss", "shadowsocks"):
        out.update({"type": "shadowsocks", "method": p.get("cipher"),
                    "password": p.get("password")})
    elif t in ("hysteria2", "hy2"):
        out.update({"type": "hysteria2", "password": p.get("password")})
        tls = {"enabled": True, "server_name": sni or host}
        if p.get("obfs") == "salamander":
            out["obfs"] = {"type": "salamander", "password": p.get("obfs-password") or ""}
    elif t == "tuic":
        out.update({"type": "tuic", "uuid": p.get("uuid"), "password": p.get("password"),
                    "congestion_control": "bbr"})
        tls = {"enabled": True, "server_name": sni or host, "alpn": ["h3"]}
    else:
        return None

    if net == "ws":
        ws = p.get("ws-opts") or {}
        tr = {"type": "ws", "path": ws.get("path") or "/"}
        headers = ws.get("headers") or {}
        if headers.get("Host"):
            tr["headers"] = {"Host": headers["Host"]}
        out["transport"] = tr
    elif net == "grpc":
        gr = p.get("grpc-opts") or {}
        out["transport"] = {"type": "grpc", "service_name": gr.get("grpc-service-name") or ""}

    if tls is not None:
        if p.get("alpn"):
            alpn = p["alpn"]
            tls["alpn"] = alpn if isinstance(alpn, list) else [a for a in str(alpn).split(",") if a]
        if p.get("skip-cert-verify"):
            tls["insecure"] = True
        out["tls"] = tls
    return out


def clash_yaml_nodes(text):
    """Parse a Clash-style profile and return sing-box outbounds."""
    if yamlite is None:
        return []
    try:
        doc = yamlite.load(text)
    except Exception:
        return []
    proxies = doc.get("proxies") or []
    out = []
    for p in proxies:
        if not isinstance(p, dict):
            continue
        o = clash_proxy_to_outbound(p)
        if o:
            out.append(o)
    return out


# ------------------------------------------------------------- subscription

def clash_min_parse(text):
    """Very small reader for Clash-style YAML: only the `proxies:` list."""
    nodes = []
    cur = None
    in_proxies = False
    for line in text.splitlines():
        if re.match(r"^proxies:\s*$", line):
            in_proxies = True
            continue
        if in_proxies and re.match(r"^[A-Za-z_]", line):
            break
        if not in_proxies:
            continue
        m = re.match(r"^\s*-\s*\{?(.*)$", line)
        if m:
            if cur:
                nodes.append(cur)
            cur = {}
            rest = m.group(1)
            if rest.strip().startswith("{"):
                for kv in re.findall(r'([a-zA-Z-]+)\s*:\s*"?(.*?)"?(?=,\s*[a-zA-Z-]+\s*:|$)', rest):
                    cur[kv[0]] = kv[1].strip().strip('"')
                continue
            if ":" in rest:
                k, _, v = rest.partition(":")
                cur[k.strip()] = v.strip().strip('"')
            continue
        if cur is not None and ":" in line:
            k, _, v = line.partition(":")
            cur[k.strip()] = v.strip().strip('"')
    if cur:
        nodes.append(cur)
    out = []
    for n in nodes:
        t = (n.get("type") or "").lower()
        try:
            if t == "vless":
                o = {"type": "vless", "tag": n.get("name") or n.get("server"),
                     "server": n.get("server"), "server_port": int(n.get("port")),
                     "uuid": n.get("uuid"), "packet_encoding": "xudp"}
                if n.get("flow"):
                    o["flow"] = n["flow"]
                nw = (n.get("network") or "tcp").lower()
                if nw == "ws":
                    o["transport"] = {"type": "ws", "path": n.get("ws-path") or "/"}
                if n.get("tls") in ("true", True, "1") or n.get("reality-opts"):
                    if n.get("reality-opts"):
                        o["tls"] = {"enabled": True, "server_name": n.get("servername") or n.get("server"),
                                    "utls": {"enabled": True, "fingerprint": n.get("client-fingerprint") or "chrome"},
                                    "reality": {"enabled": True,
                                                "public_key": n.get("public-key", ""),
                                                "short_id": n.get("short-id", "")}}
                    else:
                        o["tls"] = {"enabled": True, "server_name": n.get("servername") or n.get("server")}
            elif t == "vmess":
                o = {"type": "vmess", "tag": n.get("name") or n.get("server"),
                     "server": n.get("server"), "server_port": int(n.get("port")),
                     "uuid": n.get("uuid"), "security": n.get("cipher") or "auto",
                     "alter_id": int(n.get("alterId") or 0)}
                if (n.get("tls") in ("true", True, "1")):
                    o["tls"] = {"enabled": True, "server_name": n.get("servername") or n.get("server")}
            elif t == "trojan":
                o = {"type": "trojan", "tag": n.get("name") or n.get("server"),
                     "server": n.get("server"), "server_port": int(n.get("port")),
                     "password": n.get("password"),
                     "tls": {"enabled": True, "server_name": n.get("sni") or n.get("server")}}
            elif t in ("ss", "shadowsocks"):
                o = {"type": "shadowsocks", "tag": n.get("name") or n.get("server"),
                     "server": n.get("server"), "server_port": int(n.get("port")),
                     "method": n.get("cipher"), "password": n.get("password")}
            elif t in ("hysteria2", "hy2"):
                o = {"type": "hysteria2", "tag": n.get("name") or n.get("server"),
                     "server": n.get("server"), "server_port": int(n.get("port")),
                     "password": n.get("password"),
                     "tls": {"enabled": True, "server_name": n.get("sni") or n.get("server")}}
            else:
                continue
            out.append(o)
        except Exception:
            continue
    return out


def names_from_raw(path):
    """Pull the display names straight out of the profile's proxies section."""
    try:
        text = open(path, "rb").read().decode("utf-8", "replace")
    except Exception:
        return []
    out = []
    inside = False
    for line in text.splitlines():
        if re.match(r"^proxies:\s*$", line):
            inside = True
            continue
        if inside and re.match(r"^[a-zA-Z-]+:\s*", line) and not line.startswith(" "):
            break
        if not inside:
            continue
        m = re.match(r"^\s+name:\s*(.+?)\s*$", line)
        if m:
            v = m.group(1).strip()
            if v[:1] in ("'", '"') and v[-1:] == v[:1]:
                v = v[1:-1]
            out.append(v)
    return out


def load_nodes(path):
    raw = open(path, "rb").read()
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return []
    # sing-box / JSON subscription
    if text.startswith("{"):
        try:
            j = json.loads(text)
            if "outbounds" in j:
                return [o for o in j["outbounds"] if o.get("type") not in ("direct", "block")]
        except Exception:
            pass
    # Clash YAML (the format the panel serves to Mihomo clients)
    if "proxies:" in text and ("type:" in text):
        nodes = clash_yaml_nodes(text)
        if nodes:
            return nodes
        nodes = clash_min_parse(text)
        if nodes:
            return nodes
    # URI list, plain or base64
    if "://" not in text:
        dec = b64d(text)
        if dec:
            text = dec.decode("utf-8", "replace")
    nodes = []
    for line in text.splitlines():
        line = line.strip()
        if "://" in line:
            n = parse_uri(line)
            if n:
                nodes.append(n)
    return nodes


# ------------------------------------------------------------------ building

def build_config(nodes, mode, node_index, core_ip, iface="wlan0"):
    if not nodes:
        raise SystemExit("no nodes parsed from subscription")
    idx = node_index if 0 <= node_index < len(nodes) else 0

    # Every node becomes its own outbound (tag n0..nN) so the panel can switch
    # between them live through the Clash API without restarting the core.
    # "vpn" is a selector, "auto" a urltest group that keeps picking the
    # fastest node by URL latency.
    node_outbounds = []
    node_tags = []
    meta = []
    for i, n in enumerate(nodes):
        o = dict(n)
        o["tag"] = "n%d" % i
        # the client's own sockets must leave through the physical NIC, otherwise
        # they would follow the default route back into the tun ("empty direct
        # outbound" is also rejected by 1.14 as a DNS detour)
        o["bind_interface"] = iface
        node_outbounds.append(o)
        node_tags.append(o["tag"])
        meta.append({"index": i, "tag": o["tag"], "name": n.get("name") or n.get("server"),
                     "type": o.get("type"), "server": o.get("server"),
                     "port": o.get("server_port")})

    # No urltest group: this TV is weak, and testing ~90 nodes every few
    # minutes is far too heavy. Auto-picking is done by the panel (small
    # batches) and applied to the selector.
    default_pick = node_tags[idx]
    selector = {"type": "selector", "tag": "vpn", "outbounds": node_tags,
                "default": default_pick, "interrupt_exist_connections": False}

    rules = []
    # 1.13+: sniffing moved from the inbound to a route action
    rules.append({"action": "sniff"})
    # keep private/LAN traffic off the tunnel
    rules.append({"ip_is_private": True, "outbound": "direct"})
    # VK Video stays on the direct path in both modes (the video service does
    # not like foreign exits, and it is not what the tunnel is for)
    rules.append({"domain_suffix": VK_SUFFIXES, "outbound": "direct"})
    rules.append({"protocol": "dns", "action": "hijack-dns"})
    if core_ip:
        if ":" in core_ip:
            rules.append({"ip_cidr": ["%s/128" % core_ip], "outbound": "direct"})
        else:
            rules.append({"ip_cidr": ["%s/32" % core_ip], "outbound": "direct"})

    dns_servers = [{"type": "udp", "tag": "dns-direct", "server": "192.168.1.1", "detour": "direct"},
                   {"type": "https", "tag": "dns-proxy", "server": "1.1.1.1", "detour": "vpn"}]
    dns_rules = [{"domain_suffix": VK_SUFFIXES, "server": "dns-direct"}]
    dns = {
        "servers": dns_servers,
        "rules": dns_rules,
        "final": "dns-direct" if mode == "whitelist" else "dns-proxy",
        "strategy": "prefer_ipv4",
    }
    if mode == "whitelist":
        # ISP only allows its whitelist: resolve everything through the tunnel
        dns["final"] = "dns-proxy"

    cfg = {
        # the TV's own trust store is from 2018 - DoH to public resolvers fails
        # against it (x509: certificate signed by unknown authority), so use the
        # Mozilla bundle bundled inside sing-box
        "certificate": {"store": "mozilla"},
        "log": {"level": "warn", "timestamp": True, "output": "/media/internal/tv-tunnel/sing-box.log"},
        "dns": dns,
        "inbounds": [
            {"type": "tun", "tag": "tun-in", "interface_name": TUN_NAME,
             "address": [TUN_ADDR], "mtu": 1400, "auto_route": False,
             "strict_route": False, "stack": "system"},
            {"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 7893},
            # local DNS for the TV itself: queries to 127.0.0.2:53 are answered by
            # the DNS module (and resolved through the right detour, no leak)
            {"type": "direct", "tag": "dns-in", "listen": "127.0.0.2", "listen_port": 53,
             "override_address": "1.1.1.1", "override_port": 53},
        ],
        "experimental": {
            # the panel talks to this to switch nodes and measure latency
            "clash_api": {"external_controller": "127.0.0.1:9090"},
        },
        "outbounds": node_outbounds + [selector,
                                      {"type": "direct", "tag": "direct", "bind_interface": iface}],
        "route": {
            "rules": rules,
            "final": "vpn",
            "auto_detect_interface": False,
            "default_domain_resolver": {"server": "dns-direct", "strategy": "prefer_ipv4"},
        },
    }
    return cfg, meta


def main():
    ap = optparse.OptionParser()
    ap.add_option("--sub", dest="sub")
    ap.add_option("--mode", dest="mode", default="normal")
    ap.add_option("--out", dest="out", default="-")
    ap.add_option("--node", dest="node", type="int", default=0)
    ap.add_option("--core", dest="core", default="")
    ap.add_option("--iface", dest="iface", default="wlan0")
    ap.add_option("--list", dest="list_nodes", action="store_true")
    opts, _ = ap.parse_args()

    nodes = load_nodes(opts.sub)
    if opts.list_nodes:
        try:
            _, meta = build_config(nodes, opts.mode, 0, "", opts.iface)
        except SystemExit:
            meta = []
        names = names_from_raw(opts.sub)
        for m in meta:
            i = m["index"]
            if i < len(names) and names[i]:
                m["name"] = names[i]
        print(json.dumps(meta, ensure_ascii=False))
        return 0
    cfg, meta = build_config(nodes, opts.mode, opts.node, opts.core, opts.iface)
    text = json.dumps(cfg, ensure_ascii=False, indent=1)
    if opts.out == "-":
        print(text)
    else:
        open(opts.out, "w").write(text)
        print("wrote %s (%d nodes, mode=%s, node=%d)" % (opts.out, len(meta), opts.mode, opts.node))
    return 0


if __name__ == "__main__":
    sys.exit(main())
