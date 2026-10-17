<img src="assets/icon.png" width="96" align="right" alt="Nyamiko">

# Nyamiko

**A VPN client that lives on your LG webOS TV.** sing-box with a TUN interface,
a black-and-white TV-first control panel, per-node latency testing, automatic
picking of the fastest node, automatic failover — no laptop, no router, no
always-on box next to the TV.

Works with ordinary Clash/Mihomo subscriptions (VLESS+Reality, Trojan,
Hysteria2, …), including panels that bind a subscription to a device
(`x-hwid`, Remnawave).

[По-русски →](README.ru.md) · [Install](INSTALL.md) · [Usage](docs/USAGE.md) ·
[FAQ](docs/FAQ.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) ·
[API](docs/API.md) · [How it works](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md)

| Light | Dark |
|---|---|
| ![Nyamiko, light theme](screenshots/nyamiko-bw-light.png) | ![Nyamiko, dark theme](screenshots/nyamiko-bw-dark.png) |

The same panel opens on a phone or a laptop — the theme and the language come
from the device:

| Українська (laptop) | Беларуская (phone) |
|---|---|
| ![Українська](screenshots/ui-laptop-uk.png) | ![Беларуская](screenshots/ui-phone-be.png) |

## Features

- **Whole-TV tunnel.** Routing on kernels without policy routing (`ip rule`
  doesn't work on webOS 4), a loop guard, and a one-button emergency rollback.
- **Two modes:** *Standard VPN* (everything through the server, VK Video goes
  direct) and *Whitelist bypass* (for ISPs that only allow a list of
  destinations — uses a second subscription).
- **Remote-first panel.** Arrow keys/OK/Back, no mouse. Black-and-white design
  that follows the TV's own theme, **four interface languages** (Русский,
  English, Українська, Беларуская) picked from the device language, node search
  and sorting, exit IP, logs, panic reset.
- **Latency test for every node** (a few at a time so a weak TV keeps up) and
  **auto-pick** of the fastest.
- **Failover without opening the panel:** the client probes the link through the
  active node every minute, switches after three failures, doesn't flap
  (10-minute pause, calms down after two good probes) and periodically checks
  whether a faster node has appeared.
- **Live switching** through the core's Clash API — no tunnel restart.
- **Daily subscription refresh** (with the tunnel down, see docs).
- **Trust-store fix:** adds the 76 root certificates 2018 firmware is missing —
  the reason VK and VK Video fail.
- **Watchdogs:** autostart on TV power-on, core restart, route restore, bounded
  logs, `/tmp` cleanup.

## Requirements

1. **Rooted LG TV** (webOS 3.5–4.x; developed on a 2018 LG set running webOS 4.4).
   Rooting: [webosbrew](https://www.webosbrew.org/) / Homebrew Channel.
2. **A subscription** in Clash/Mihomo format. The key never leaves the TV.
3. **SSH** to the TV (`ssh root@<tv-ip>`) and `node` (comes with Homebrew
   Channel).

## Install

On the TV:

```sh
curl -fsSL https://raw.githubusercontent.com/yanineko77/nyamiko/main/install.sh \
  | sh -s -- "https://your-panel/sub/KEY"
```

Add a second link for the *whitelist bypass* mode if you have one. `--update`
refreshes the files and keeps keys and settings; `--uninstall` removes
everything. Full details, manual install and post-install checks:
[INSTALL.md](INSTALL.md).

## Daily use

Open `http://<tv-ip>:8099/` from the TV browser, a phone or a laptop, then:

1. press **Auto** once — the client measures every node and keeps the fastest;
2. pick a **mode**; the tunnel is re-raised to match it;
3. forget about it — the client re-checks and switches on its own.

Everything else (subscriptions, log, panic reset, language, theme) is in the
panel: [docs/USAGE.md](docs/USAGE.md).

## How it works

```
TV
├── sing-box (core)   TUN sbtun, default route -> tunnel,
│                     Clash API on 127.0.0.1:9090 (switching, latency)
├── tunnelctl.sh      up/down/fetch/status/watch/rescue, routes, DNS
├── tvtunnd.js        panel on :8099 + JSON API, failover supervisor
└── ui.html           interface (remote, 4 languages, device theme)
```

Long version: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Certificates: [docs/TRUST-STORE.md](docs/TRUST-STORE.md).

## Security & privacy

- Subscription keys live only on the TV (`/media/internal/tv-tunnel/config.json`,
  mode 600) and are sent only to your own panel.
- The panel is open to the home network by default so you can use it from a
  phone. Set `"require_key": true` in `config.json` to require `?k=<token>` for
  non-local callers.
- Nothing is written to the system partition: the client lives in
  `/media/internal` and can be removed with the folder.

## License and disclaimer

MIT — see [LICENSE](LICENSE). Nyamiko is a client for **your own** subscription.
Using a VPN privately is not itself punishable in Russia, but **advertising or
popularising ways to bypass blocking is prohibited** and carries administrative
fines. You are responsible for how you use and distribute this. Never commit
subscription keys, and don't turn the project into a public service.
