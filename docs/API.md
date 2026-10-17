# HTTP API панели

Демон `tvtunnd.js` слушает `0.0.0.0:8099` и отдаёт саму панель и небольшой
JSON-API. Это удобно для автоматизации: то же самое можно делать из скриптов,
Home Assistant или `curl` с телефона.

- авторизация: нет, если в `config.json` нет `require_key`; при
  `"require_key": true` нужен параметр `?k=<token>` для обращений не с самого
  телевизора (запросы с `127.0.0.1` проходят всегда);
- формат: JSON, `Content-Type: application/json`;
- ошибки: `{ "ok": false, "error": "..." }` (иногда с кодом 400).

## Чтение (GET)

| Запрос | Ответ |
|---|---|
| `GET /` | HTML панели (`ui.html` с диска, без кеша) |
| `GET /api/status` | состояние: `state` (`up`/`down`), `mode`, `mode_setting`, `node_setting`, `auto`, `autostart`, `best_ms`, `core`, `tun`, `default` (маршрут по умолчанию), `sub_normal_set`, `sub_whitelist_set`, `sub_updated`, `sup` (`{switches, good, bad, note}`), `error` |
| `GET /api/nodes?mode=normal\|whitelist` | `{mode, nodes:[{index, tag, name, type, server, port}], error}` |
| `GET /api/proxies` | `{ok, proxies:{<tag>:{now, delay}}, error}` — из Clash-API ядра |
| `GET /api/ping` | `{ok, sweep:{running, done, total, results:{<tag>:<ms\|null>}}}` |
| `GET /api/exitip` | `{ok, ip}` — выходной адрес (кеш 30 с) |
| `GET /api/log` | текст: хвост `ctl.log` (3000 строк) + `sing-box.log` (2000 строк) |

## Действия (POST, тело — JSON)

| Запрос | Тело | Что делает |
|---|---|---|
| `POST /api/start` | `{mode, node}` | сохраняет режим/узел в конфиг и поднимает туннель |
| `POST /api/stop` | — | опускает туннель, возвращает обычный интернет |
| `POST /api/ping` | `{mode}` | запускает замер всех узлов профиля (порциями) |
| `POST /api/auto` | `{on:true\|false}` | включает/выключает автовыбор; при включении сразу запускает замер |
| `POST /api/failover` | — | принудительный перебор лучших узлов |
| `POST /api/select` | `{tag:"n12"}` | переключает узел через Clash-API; **выключает авто** (ручной выбор приоритетнее) |
| `POST /api/fetch` | — | обновляет обе подписки (с туннелем вниз — иначе панель отдаёт заглушку) |
| `POST /api/save` | `{sub_normal?, sub_whitelist?, mode?, autostart?, node?, clear_normal?, clear_whitelist?}` | правит конфиг. Пустое значение поля подписки **ничего не стирает** — для очистки нужен явный `clear_*` |
| `POST /api/rescue` | — | аварийный сброс: туннель вниз, маршруты и DNS как были |

## Примеры

```sh
# что сейчас
curl -s http://<ip-телевизора>:8099/api/status

# замерить узлы и через минуту посмотреть результат
curl -s -X POST -d '{"mode":"normal"}' http://<ip-телевизора>:8099/api/ping
curl -s http://<ip-телевизора>:8099/api/ping

# переключиться на узел n4
curl -s -X POST -d '{"tag":"n4"}' http://<ip-телевизора>:8099/api/select

# включить авто
curl -s -X POST -d '{"on":true}' http://<ip-телевизора>:8099/api/auto

# свернуть всё и вернуть обычный интернет
curl -s -X POST http://<ip-телевизора>:8099/api/rescue
```

## Clash-API ядра

Внутри телевизора sing-box поднимает собственный API на `127.0.0.1:9090`:

```sh
curl -s 127.0.0.1:9090/version
curl -s 127.0.0.1:9090/proxies | head -c 400
curl -s -X PUT -d '{"name":"n4"}' 127.0.0.1:9090/proxies/vpn
```

Через него же идут задержки узлов — это самый быстрый способ проверить, что
ядро живо, не трогая панель.
