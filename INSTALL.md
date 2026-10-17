# Установка Nyamiko

## Что должно быть готово

1. **Рут на телевизоре.** Клиент ставится по SSH и пишет файлы в
   `/media/internal/tv-tunnel` и `/var/lib/webosbrew/init.d`. Без рута ничего не
   выйдет: `ssh root@<ip>` должен открывать шелл.
2. **Второй ключ не нужен**, если у вас одна подписка.
3. **Проверьте, что на телевизоре есть `node`** (ставится вместе с Homebrew
   Channel): `node -v` должен показать версию. Панель — это маленький сервер на
   Node.

Уточнить, что за телевизор, можно так:

```sh
ssh root@<ip> 'uname -m; cat /etc/version 2>/dev/null; df -m /media/internal | tail -1'
```

## Способ 1: одной командой (рекомендуется)

На телевизоре:

```sh
curl -fsSL https://raw.githubusercontent.com/yanineko77/nyamiko/main/install.sh \
  | sh -s -- "https://ваша-панель/sub/КЛЮЧ"
```

Со вторым профилем (режим обхода белых списков):

```sh
curl -fsSL https://raw.githubusercontent.com/yanineko77/nyamiko/main/install.sh \
  | sh -s -- "https://ваша-панель/sub/КЛЮЧ_1" "https://ваша-панель/sub/КЛЮЧ_2"
```

Без аргумента ссылки установщик спросит её сам (если запускать в терминале):

```sh
sh install.sh
```

Полезные флаги: `--no-autostart` (не поднимать туннель при включении
телевизора), `--dir DIR` (другая папка), `--version v0.3.0` (конкретный
выпуск), `--help`.

## Способ 2: из архива

Если на телевизоре нет доступа в интернет или репозиторий закрыт:

```sh
# на компьютере
scp -r nyamiko root@<ip>:/media/internal/

# на телевизоре
cd /media/internal/nyamiko
sh install.sh "https://ваша-панель/sub/КЛЮЧ"
```

Установщик увидит папку `src/` рядом с собой и возьмёт файлы оттуда, а не из
сети.

## Способ 3: вручную

```sh
ssh root@<ip>
mkdir -p /media/internal/tv-tunnel/{state,ca/extra}
cd /media/internal/tv-tunnel
# положите сюда src/*: genconfig.py yamlite.py tvtunnd.js tunnelctl.sh ui.html
# https://github.com/SagerNet/sing-box/releases -> sing-box-linux-armv7.tar.gz
chmod +x sing-box tunnelctl.sh
umask 077
printf '{"sub_normal":"https://ваша-панель/sub/КЛЮЧ","mode":"normal","node":-1,"auto":true,"autostart":true}' > config.json
# автозапуск
cp hooks/60-tvtunnel hooks/55-ca-extra /var/lib/webosbrew/init.d/
chmod +x /var/lib/webosbrew/init.d/60-* /var/lib/webosbrew/init.d/55-*
# запуск
setsid nohup node tvtunnd.js >>daemon.log 2>&1 </dev/null &
setsid nohup sh tunnelctl.sh watch >>ctl.log 2>&1 </dev/null &
sh tunnelctl.sh up normal -1
```

## Что делает установщик

Шесть шагов, каждый печатает результат:

| Шаг | Что происходит |
|---|---|
| 1. файлы | кладёт `src/*` в `/media/internal/tv-tunnel` (при `--update` сначала делает копию прежних файлов в `state/backup-*`) |
| 2. ядро | скачивает `sing-box` под архитектуру телевизора, если его ещё нет |
| 3. настройки | пишет `config.json` с ключами, права 600 (при `--update` не трогает) |
| 4. автозапуск | ставит хуки `60-tvtunnel` и `55-ca-extra` в `/var/lib/webosbrew/init.d` |
| 5. запуск | глушит прежние процессы, поднимает панель и сторож маршрутов |
| 6. проверка | панель `:8099`, ютуб через туннель, выходной адрес |

## После установки

1. Откройте `http://<ip телевизора>:8099/`.
2. Нажмите **«Авто»** — клиент замерит узлы и выберет самый быстрый
   (на 90 узлах это занимает минуту-полторы).
3. Включите «Быстрый запуск+» в настройках телевизора, если хотите, чтобы
   панель отвечала, когда телевизор «выключен».
4. Если нужен обход белых списков — переключите режим и проверьте, что вторая
   подписка добавлена (кнопка «Подписки»).

## Обновление

```sh
sh /media/internal/nyamiko/install.sh --update      # из папки проекта
# или одной строкой с компьютера:
ssh root@<ip> "sh /media/internal/tv-tunnel/install.sh --update"
```

Файлы заменяются, ключи, режим, выбранный узел и автозапуск остаются. Прежняя
версия складывается в `/media/internal/tv-tunnel/state/backup-<дата>` — откат
сводится к копированию файлов обратно.

## Удаление

```sh
sh install.sh --uninstall          # убрать клиент, оставить ключи и настройки
sh install.sh --uninstall --purge  # убрать всё вместе с ключами
```

## Если что-то пошло не так

| Симптом | Что делать |
|---|---|
| `нужен root` | зайти как `ssh root@<ip>`, не как обычный пользователь |
| `не скачался src/...` | нет интернета на телевизоре или неверный адрес репозитория — используйте способ 2 (из архива) |
| `ядра нет` | скачайте `sing-box-linux-armv7` вручную и положите в `/media/internal/tv-tunnel/sing-box` |
| панель не ответила | `tail -50 /media/internal/tv-tunnel/daemon.log`, чаще всего занят порт 8099 |
| ютуб не открывается | панель → «Авто» (перебрать узлы) или другой режим |
| нет интернета после установки | `sh /media/internal/tv-tunnel/tunnelctl.sh rescue` |

Больше случаев — [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
