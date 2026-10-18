# Пакет для Homebrew Channel (.ipk)

Обёртка, которая ставит клиент **с пульта**, без ssh и без компьютера рядом:
приложение показывает состояние, спрашивает ссылку на подписку и вызывает
установщик клиента от root через сервис Homebrew Channel.

## Как это работает

Приложение ничего не делает само — оно разговаривает с Homebrew Channel:

| Что нужно | Чем делается |
|---|---|
| выполнить команду от root | `luna://org.webosbrew.hbchannel.service/exec` `{command}` → `stdoutString` |
| долгая команда с выводом на экран | тот же сервис, метод `spawn` (подписка на поток) |
| открыть панель клиента | `luna://com.webos.applicationManager/launch` с `target: http://127.0.0.1:8099/` |
| поставить сам клиент | `install.sh` из репозитория, запущенный через `exec` |

Ключ подписки остаётся на телевизоре (`/media/internal/tv-tunnel/config.json`,
права 600) и в приложение не пишется: оно передаёт его установщику одной
командой и сохраняет только локально, чтобы не вводить дважды.

Автозапуск отдельно настраивать не нужно: Homebrew Channel выполняет скрипты из
`/var/lib/webosbrew/init.d`, и клиент ставит туда свой хук `60-tvtunnel`.

## Сборка

```sh
npm i @webos-tools/cli @webosbrew/pub-utils     # ares-package + генератор манифеста
sh packaging/ipk/build.sh                       # -> packaging/ipk/dist/
```

Скрипт делает иконки (80×80 и 130×130), проверяет структуру приложения,
собирает `org.nyamiko.launcher_<версия>_all.ipk` и кладёт рядом манифест
(`rootRequired: true`) — он нужен, чтобы добавить приложение в репозиторий
webosbrew и чтобы Homebrew Channel показал предупреждение про root.

Публичный адрес сборки подставляется переменной:

```sh
IPK_URL=https://github.com/yanineko77/nyamiko/releases/download/v0.4.0/org.nyamiko.launcher_0.4.0_all.ipk \
  sh packaging/ipk/build.sh
```

## Установка на телевизор

```sh
# с компьютера, если настроен dev-mode (ares-install из webos-tools)
ares-install packaging/ipk/dist/org.nyamiko.launcher_0.4.0_all.ipk

# или прямо на телевизоре по ssh (рутованный, Homebrew Channel установлен)
luna-send -n 1 -t 30 luna://com.webos.appInstallService/dev/install \
  '{"id":"org.nyamiko.launcher","ipkUrl":"/tmp/org.nyamiko.launcher_0.4.0_all.ipk"}'
```

После установки приложение появляется в списке и на домашнем экране.

## Публикация в репозитории webosbrew

1. Приложить к релизу GitHub `.ipk` и манифест (или положить манифест в
   репозиторий и сослаться на него).
2. В форке репозитория `webosbrew/apps-repo` создать
   `packages/nyamiko.yml`:

```yaml
title: Nyamiko
iconUri: https://raw.githubusercontent.com/yanineko77/nyamiko/main/assets/icon.png
manifestUrl: https://github.com/yanineko77/nyamiko/releases/latest/download/org.nyamiko.launcher.manifest.json
category: system
pool: main
description: |
  VPN-клиент для своего сервера на рутованном телевизоре LG (webOS 3.5–4.x):
  sing-box + TUN, чёрно-белая панель под пульт, замер узлов, автовыбор и
  автопереключение. Это установщик: он раскладывает клиент на телевизоре и
  открывает его панель.
screenshots:
  - https://raw.githubusercontent.com/yanineko77/nyamiko/main/screenshots/nyamiko-bw-light.png
funding:
  github: [yanineko77]
```

3. Сделать PR. В описании PR **обязательно раскрыть**, что проект и код писались
   с помощью ИИ, кто отвечает за код и как проект проверялся на живом
   телевизоре — у webosbrew это первое требование к чужим приложениям
   («NO AI SLOP»), и попытка умолчать о происхождении кода приведёт к отказу.

## Ограничения

- работает только на рутованном телевизоре с Homebrew Channel: без root сервис
  `exec` есть, но команды выполняются не от root, и установка не пройдёт;
- на webOS 5+ рут закрыт на свежих прошивках — приложение поставится, но
  клиенту не хватит прав (об этом честно сказано в описании);
- поле `requiredACG` в `appinfo.json` не заполнено: оно нужно для сабмита в
  магазин LG, для установки из Homebrew Channel не используется.
