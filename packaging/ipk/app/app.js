/* Nyamiko launcher — обёртка над Homebrew Channel: ставит и запускает клиент.
 *
 * Приложение ничего не делает само: все команды выполняет root-сервис
 * Homebrew Channel (luna://org.webosbrew.hbchannel.service/exec|spawn). Так
 * установка возможна с пульта, без ssh и без компьютера рядом.
 *
 * ES5-only: на webOS 4.x браузер старый.
 */
var REPO = 'https://raw.githubusercontent.com/yanineko77/nyamiko/main';
var CLIENT_DIR = '/media/internal/tv-tunnel';
var INSTALL_SH = '/tmp/nyamiko-install.sh';
var PANEL_URL = 'http://127.0.0.1:8099/';

function el(id) { return document.getElementById(id); }

function log(line) {
  var box = el('log');
  var stamp = new Date().toTimeString().slice(0, 8);
  box.textContent += '[' + stamp + '] ' + line + '\n';
  box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------------------ luna */

function bridge() {
  if (window.PalmServiceBridge) return new window.PalmServiceBridge();
  return null;
}

function execCmd(command, cb) {
  var b = bridge();
  if (!b) { cb && cb({ error: 'нет моста к сервисам (это не webOS?)' }); return; }
  var done = false;
  b.onservicecallback = function (msg) {
    if (done) return;
    done = true;
    var res = {};
    try { res = JSON.parse(msg); } catch (e) { res = { error: String(msg) }; }
    try { b.cancel(); } catch (e) {}
    cb && cb(res);
  };
  b.call('luna://org.webosbrew.hbchannel.service/exec',
         JSON.stringify({ command: command }));
}

/* поток вывода долгой команды (установка ядра и т.п.) */
function spawnCmd(command, onLine, onDone) {
  var b = bridge();
  if (!b) { onDone && onDone(1, 'нет моста к сервисам'); return null; }
  var buf = '';
  b.onservicecallback = function (msg) {
    var res = {};
    try { res = JSON.parse(msg); } catch (e) { return; }
    if (res.type === 'stdoutData' || res.type === 'stderrData') {
      var chunk = res.stdoutString || res.stderrString || '';
      if (!chunk && res.stdoutBytes) {
        try { chunk = atob(res.stdoutBytes); } catch (e) { chunk = ''; }
      }
      buf += chunk;
      var parts = buf.split('\n');
      buf = parts.pop();
      for (var i = 0; i < parts.length; i++) onLine && onLine(parts[i]);
    } else if (res.error) {
      onDone && onDone(1, res.error);
    } else if (res.type === 'close' || res.type === 'exit') {
      if (buf) { onLine && onLine(buf); buf = ''; }
      var code = (res.exitCode !== undefined && res.exitCode !== null) ? res.exitCode : res.closeCode;
      onDone && onDone(code === undefined || code === null ? 0 : code, null);
    }
  };
  b.call('luna://org.webosbrew.hbchannel.service/spawn',
         JSON.stringify({ command: command, subscribe: true }));
  return b;
}

/* ------------------------------------------------------------- состояние */

function noChannel(reason) {
  // без Homebrew Channel приложение ничего сделать не может: честно говорим об этом,
  // а не показываем «клиент установлен»
  var box = el('statusBox');
  box.className = 'status err';
  el('statusText').textContent = 'Нет доступа к Homebrew Channel' +
      (reason ? ' (' + reason + ')' : '') +
      ' — установите его на рутованный телевизор и откройте приложение снова';
  el('btnPanel').disabled = true;
  el('footerRight').textContent = 'нет Homebrew Channel';
}

function refreshStatus() {
  var box = el('statusBox'), text = el('statusText');
  box.className = 'status';
  text.textContent = 'проверяю состояние…';
  execCmd('if [ -f ' + CLIENT_DIR + '/tvtunnd.js ]; then echo INSTALLED; else echo MISSING; fi',
    function (res) {
      if (!res || res.error || res.returnValue === false) {
        noChannel((res && (res.error || res.errorText)) || '');
        return;
      }
      var out = (res.stdoutString || '');
      if (out.indexOf('MISSING') >= 0 && out.indexOf('INSTALLED') < 0) {
        box.className = 'status err';
        text.textContent = 'Клиент не установлен — вставьте ссылку подписки и нажмите «Установить»';
        el('btnPanel').disabled = true;
        el('footerRight').textContent = 'клиента нет';
        return;
      }
      // клиент есть: спрашиваем его собственный статус
      execCmd('curl -s -m 6 ' + PANEL_URL + 'api/status', function (st) {
        var body = (st && st.stdoutString) || '';
        var up = body.indexOf('"state":"up"') >= 0;
        var core = body.indexOf('"core":"running"') >= 0;
        var mode = /"mode":"([a-z]+)"/.exec(body);
        box.className = 'status ' + (up ? 'on' : 'err');
        text.textContent = up
          ? ('Туннель работает' +
             (mode ? ' · режим: ' + (mode[1] === 'whitelist' ? 'обход белых списков' : 'обычный VPN') : '') +
             (core ? '' : ' · ядро не запущено'))
          : 'Клиент установлен, туннель опущен — откройте панель и нажмите «Авто»';
        el('btnPanel').disabled = false;
        el('footerRight').textContent = up ? 'туннель поднят' : 'туннель опущен';
      });
    });
}

/* -------------------------------------------------------------- действия */

function quote(s) { return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"'; }

function downloadInstaller(next) {
  log('скачиваю установщик из репозитория…');
  execCmd('curl -fsSL ' + REPO + '/install.sh -o ' + INSTALL_SH + ' && wc -c < ' + INSTALL_SH,
    function (res) {
      if (!res || res.error || (res.returnValue === false)) {
        log('! не удалось скачать установщик: ' + ((res && (res.stderrString || res.error)) || 'нет ответа'));
        setBusy(false); next && next(false); return;
      }
      log('установщик скачан (' + String(res.stdoutString || '').replace(/\s+$/, '') + ' байт)');
      next && next(true);
    });
}

function runStreaming(command, doneText) {
  log('$ ' + command);
  var spoked = false;
  var fallbackTimer = window.setTimeout(function () {
    if (spoked) return;
    spoked = true;
    log('· поток не отвечает, жду завершения команды целиком…');
    execCmd(command, function (res) {
      var out = (res && (res.stdoutString || res.stderrString)) || '';
      if (out) log(out.replace(/\s+$/, ''));
      var code = res && res.exitCode !== undefined ? res.exitCode : 0;
      log((code ? 'завершено с кодом ' + code + '. ' : 'готово. ') + (doneText || ''));
      setBusy(false);
      refreshStatus();
    });
  }, 8000);
  spawnCmd(command, function (line) { spoked = true; log(line); }, function (code, err) {
    if (spoked) return;
    spoked = true;
    window.clearTimeout(fallbackTimer);
    if (err) log('! ошибка: ' + err);
    log((code === 0 ? 'готово. ' : 'завершено с кодом ' + code + '. ') + (doneText || ''));
    setBusy(false);
    refreshStatus();
  });
}

var busy = false;
function setBusy(state) {
  busy = state;
  var ids = ['btnInstall', 'btnUpdate', 'btnRestart', 'btnUninstall', 'btnPanel'];
  for (var i = 0; i < ids.length; i++) el(ids[i]).disabled = state;
  el('footerLeft').textContent = state ? 'Nyamiko launcher · идёт работа' : 'Nyamiko launcher';
}

function startInstall(update) {
  if (busy) return;
  var sub = el('subInput').value.replace(/^\s+|\s+$/g, '');
  if (!update && !sub) { log('! вставьте ссылку на подписку'); el('subInput').focus(); return; }
  try { window.localStorage.setItem('nyamiko.sub', sub); } catch (e) {}
  setBusy(true);
  downloadInstaller(function (ok) {
    if (!ok) return;
    var cmd = 'sh ' + INSTALL_SH + (update ? ' --update' : ' ' + quote(sub)) + ' 2>&1';
    runStreaming(cmd, update ? 'Файлы обновлены, ключи и настройки не тронуты.' : 'Клиент установлен.');
  });
}

function openPanel() {
  log('открываю панель в браузере телевизора…');
  var b = bridge();
  if (!b) { log('адрес панели: ' + PANEL_URL); return; }
  b.onservicecallback = function (msg) {
    var res = {};
    try { res = JSON.parse(msg); } catch (e) {}
    if (res.returnValue === false) log('! браузер не открылся, наберите адрес вручную: ' + PANEL_URL);
    try { b.cancel(); } catch (e) {}
  };
  b.call('luna://com.webos.applicationManager/launch',
         JSON.stringify({ id: 'com.webos.app.browser', params: { target: PANEL_URL } }));
}

function restartAll() {
  if (busy) return;
  setBusy(true);
  // 60-tvtunnel — тот же хук, который телевизор запускает при включении:
  // перезапуск им гарантированно повторяет поведение штатной загрузки
  runStreaming('sh -c ' + quote('pkill -f "tunnelctl.sh [w]atch" 2>/dev/null; ' +
             'for p in $(pgrep -f "[t]vtunnd.js"); do kill -9 $p 2>/dev/null; done; ' +
             'pkill -x sing-box 2>/dev/null; sleep 3; ' +
             'rm -f ' + CLIENT_DIR + '/panic; ' +
             'setsid nohup node ' + CLIENT_DIR + '/tvtunnd.js >> ' + CLIENT_DIR + '/daemon.log 2>&1 < /dev/null & ' +
             'sleep 4; setsid nohup sh ' + CLIENT_DIR + '/tunnelctl.sh watch >> ' + CLIENT_DIR + '/ctl.log 2>&1 < /dev/null & ' +
             'sleep 3; sh ' + CLIENT_DIR + '/tunnelctl.sh up normal -1') + ' 2>&1',
             'Панель и туннель подняты заново.');
}

var uninstallArmed = false;
function uninstallClient() {
  if (busy) return;
  var btn = el('btnUninstall');
  if (!uninstallArmed) {
    // вместо confirm(): в webOS-приложении модальное окно может не появиться
    uninstallArmed = true;
    btn.querySelector('.t').textContent = 'Нажмите ещё раз, чтобы удалить';
    window.setTimeout(function () {
      uninstallArmed = false;
      btn.querySelector('.t').textContent = 'Удалить клиент';
    }, 8000);
    return;
  }
  uninstallArmed = false;
  btn.querySelector('.t').textContent = 'Удалить клиент';
  setBusy(true);
  downloadInstaller(function (ok) {
    if (!ok) return;
    runStreaming('sh ' + INSTALL_SH + ' --uninstall 2>&1',
                 'Клиент удалён, телевизор работает как раньше.');
  });
}

/* --------------------------------------------------------------- запуск */


/* --------------------------------------------------- управление с пульта
 * У webOS-приложения нет мыши: стрелки двигают фокус, OK нажимает, BACK
 * закрывает приложение. Без этого обработчика экран живёт, но пульт его
 * не двигает — именно так и получилось в первой сборке.
 */
function focusables() {
  var all = document.querySelectorAll('button, a[href], input, pre[tabindex]');
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.disabled) continue;
    var r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    out.push(e);
  }
  return out;
}

function focusEl(e) {
  if (!e) return;
  try { e.focus(); } catch (err) {}
  if (e.scrollIntoView) { try { e.scrollIntoView(false); } catch (err) {} }
}

function moveFocus(dir) {
  var items = focusables();
  if (!items.length) return;
  var cur = document.activeElement;
  if (!cur || indexOfEl(items, cur) < 0) { focusEl(items[0]); return; }
  var cr = cur.getBoundingClientRect();
  var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
  var best = null, bestScore = 1e9;
  for (var i = 0; i < items.length; i++) {
    var e = items[i];
    if (e === cur) continue;
    var r = e.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var dx = x - cx, dy = y - cy;
    var ok = (dir === 'left') ? dx < -4 : (dir === 'right') ? dx > 4
           : (dir === 'up') ? dy < -4 : dy > 4;
    if (!ok) continue;
    // ближе по направлению, и рядом по перпендикуляру — так стрелка не прыгает
    // в другой столбец через пол-экрана
    var primary = (dir === 'left' || dir === 'right') ? Math.abs(dx) : Math.abs(dy);
    var secondary = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx);
    var score = primary + secondary * 1.6;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  if (best) focusEl(best);
}

function indexOfEl(list, e) {
  for (var i = 0; i < list.length; i++) if (list[i] === e) return i;
  return -1;
}

var KEYS = { 37: '◀', 38: '▲', 39: '▶', 40: '▼', 13: 'OK', 461: 'BACK', 27: 'ESC' };
function showKey(k) {
  var el2 = el('footerRight');
  if (!el2) return;
  var old2 = el2.textContent;
  el2.textContent = 'клавиша: ' + (KEYS[k] || k);
  window.setTimeout(function () {
    if (el2.textContent.indexOf('клавиша:') === 0) el2.textContent = old2;
  }, 1500);
}

function onKey(ev) {
  var k = ev.keyCode;
  showKey(k);
  if (k >= 37 && k <= 40) {
    ev.preventDefault();
    moveFocus(k === 37 ? 'left' : k === 38 ? 'up' : k === 39 ? 'right' : 'down');
    return;
  }
  if (k === 13) {                       // OK
    var f = document.activeElement;
    if (f && f.tagName === 'INPUT') return;      // в поле ввода OK — обычный ввод
    if (f && f.click) { ev.preventDefault(); f.click(); }
    return;
  }
  if (k === 461 || k === 27) {          // BACK / ESC закрывает приложение
    try { window.close(); } catch (e) {}
  }
}

/* вешаем и на document, и на window: разные сборки webOS шлют клавиши по-разному */
document.addEventListener('keydown', onKey, false);
window.addEventListener('keydown', onKey, false);

function init() {
  el('btnInstall').addEventListener('click', function () { startInstall(false); });
  el('btnUpdate').addEventListener('click', function () { startInstall(true); });
  el('btnPanel').addEventListener('click', openPanel);
  el('btnRestart').addEventListener('click', restartAll);
  el('btnUninstall').addEventListener('click', uninstallClient);
  el('btnClear').addEventListener('click', function () { el('log').textContent = ''; });
  try {
    var saved = window.localStorage.getItem('nyamiko.sub');
    if (saved) el('subInput').value = saved;
  } catch (e) {}
  el('subInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') startInstall(false);
  });
  log('Nyamiko: установка клиента на телевизор через Homebrew Channel.');
  log('Ссылка подписки берётся у вашей панели (Clash/Mihomo).');
  log('Управление с пульта: стрелки — переход, OK — нажать, BACK — выйти.');
  el('footerLeft').textContent = 'Nyamiko launcher · стрелки + OK';
  focusEl(el('btnInstall'));        // пульт должен работать сразу, без нажатий мышью
  document.addEventListener('keyup', function (ev) {
    // некоторые пульты присылают только keyup для BACK
    if (ev.keyCode === 461 || ev.keyCode === 27) { try { window.close(); } catch (e) {} }
  }, false);
  refreshStatus();
  window.setInterval(refreshStatus, 15000);
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  window.setTimeout(init, 1);
} else {
  document.addEventListener('DOMContentLoaded', init);
}
