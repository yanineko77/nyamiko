/*
 * tvtunnd.js - Nyamiko v0.5.2: control daemon for the LG TV tunnel client
 * (sing-box + tun).
 *
 * Written for the webOS 4.x node (v0.12): ES5 only, no dependencies.
 * Runs as root (started from /var/lib/webosbrew/init.d/60-tvtunnel).
 *
 *   http://<tv-ip>:8099/          web UI
 *   GET  /api/status              state of the tunnel
 *   GET  /api/nodes?mode=normal   parsed node list
 *   POST /api/start {mode,node}   bring the tunnel up
 *   POST /api/stop                tear it down
 *   POST /api/fetch               re-download both subscriptions
 *   POST /api/save  {...}         store settings
 *   GET  /api/log                 tail of the logs
 */
var http = require('http');
var fs = require('fs');
var url = require('url');
var exec = require('child_process').exec;
var http = require('http');

var DIR = '/media/internal/tv-tunnel';
var CTL = DIR + '/tunnelctl.sh';
var PORT = 8099;

/* Откуда клиент берёт обновления и диагностику. Публичный репозиторий проекта. */
var REPO = 'https://raw.githubusercontent.com/yanineko77/nyamiko/main';
var UPDATE_RUNNING = false;

/* Выбранный узел у каждого режима свой: индекс из одного профиля не значит
   ничего в другом (в обычной подписке узлов 94, в обходной 7 — старый индекс
   попадал на чужой или мёртвый узел и туннель не работал). */
function nodeFor(cfg, mode) {
  var v = cfg['node_' + (mode === 'whitelist' ? 'whitelist' : 'normal')];
  if (v === undefined || v === null) {
    // старые файлы настроек: единственный cfg.node относился к текущему режиму
    v = (mode === (cfg.mode || 'normal')) ? (cfg.node === undefined ? -1 : cfg.node) : -1;
  }
  return v;
}

function localVersion() {
  var m = readFile(DIR + '/ui.html', '').match(/Nyamiko v([0-9]+\.[0-9]+\.[0-9]+)/);
  return m ? m[1] : null;
}

function cmpVer(a, b) {
  var pa = String(a).split('.'), pb = String(b).split('.');
  for (var i = 0; i < 3; i++) {
    var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/* Диагностика одним текстом: версии, состояние, маршруты, место, логи, настройки
   без ключей. Человек прикладывает файл к сообщению об ошибке — и не нужен ssh. */
function diagnostics(cb) {
  var commands = [
    'date',
    'cat /proc/version',
    'node -v',
    DIR + '/sing-box version',
    'sh ' + CTL + ' status',
    'ip route',
    'ip -o -4 addr show',
    'cat /etc/resolv.conf',
    'df -h /media/internal /tmp',
    'ps -eo pid,pcpu,pmem,comm',
    'tail -40 ' + DIR + '/ctl.log',
    'tail -40 ' + DIR + '/sing-box.log',
    'tail -20 ' + DIR + '/daemon.log'
  ];
  var out = '# Nyamiko — диагностика\n# панель v' + (localVersion() || '?') + '\n';
  (function next(i) {
    if (i >= commands.length) {
      var cfg = config();
      out += '\n# настройки (ключи не выводятся)\n';
      out += 'mode=' + (cfg.mode || 'normal') + ' node=' + cfg.node +
             ' auto=' + (cfg.auto === true) + ' autostart=' + (cfg.autostart === true) + '\n';
      out += 'подписка: ' + (cfg.sub_normal ? 'задана' : 'нет') +
             ', обходная: ' + (cfg.sub_whitelist ? 'задана' : 'нет') + '\n';
      return cb(out);
    }
    out += '\n# $ ' + commands[i] + '\n';
    run(commands[i], function (r) {
      out += (r.out || '');
      if (r.errOut) out += '[stderr] ' + r.errOut;
      next(i + 1);
    });
  })(0);
}

/* The panel can switch the tunnel and set subscriptions, so it must not be
   open to the whole LAN. Loopback (the TV's own app and terminal) is trusted;
   remote callers need ?k=<token> from config.json. */
function token() {
  var t = config().token;
  if (t) return t;
  var c = config();
  c.token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  saveConfig(c);
  return c.token;
}
function allowed(req, u) {
  var ra = (req.socket && req.socket.remoteAddress) || '';
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return true;
  var k = u.query.k || '';
  return !!k && k === token();
}

function readFile(p, dflt) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return dflt; }
}

function stateFile(name) { return readFile(DIR + '/state/' + name, '').replace(/\s+$/, ''); }

function config() {
  try { return JSON.parse(readFile(DIR + '/config.json', '{}')); } catch (e) { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(DIR + '/config.json', JSON.stringify(cfg, null, 1), 'utf8');
}

function run(cmd, cb) {
  exec(cmd, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
    cb({ err: err ? String(err.message || err) : null, out: stdout || '', errOut: stderr || '' });
  });
}

function status(cb) {
  var cfg = config();
  run('sh ' + CTL + ' status', function (r) {
    var st = {};
    (r.out || '').split('\n').forEach(function (line) {
      var i = line.indexOf('=');
      if (i > 0) st[line.slice(0, i)] = line.slice(i + 1);
    });
    st.autostart = cfg.autostart === true;
    st.mode_setting = cfg.mode || 'normal';
    st.sub_normal_set = !!(cfg.sub_normal || '');
    st.sub_whitelist_set = !!(cfg.sub_whitelist || '');
    st.node_setting = nodeFor(cfg, cfg.mode || 'normal');
    st.auto = cfg.auto === true;
    st.best = cfg.best || null;
    st.best_ms = cfg.best_ms || null;
    st.picked_at = cfg.picked_at || null;
    st.sub_updated = parseInt(cfg.sub_updated || stateFile('sub_updated') || 0, 10) || null;
    st.sup = { good: SUP.good, bad: SUP.bad, switches: SUP.switches, bad_total: SUP.badTotal,
               last_switch: SUP.lastSwitch ? Math.floor(SUP.lastSwitch / 1000) : null,
               note: SUP.note || null };
    if (r.err) st.exec_error = r.err;
    cb(st);
  });
}

function listNodes(mode, cb) {
  var raw = DIR + '/sub-' + mode + '.raw';
  var py = '/usr/bin/python';
  run(py + ' ' + DIR + '/genconfig.py --sub ' + raw + ' --list', function (r) {
    var nodes = [];
    try { nodes = JSON.parse(r.out || '[]'); } catch (e) { nodes = []; }
    // why some nodes never reached the list (xhttp: the core has no such
    // transport). The panel shows this instead of silently losing half a
    // subscription.
    run(py + ' ' + DIR + '/genconfig.py --sub ' + raw + ' --stats', function (s) {
      var dropped = {};
      try { dropped = JSON.parse(s.out || '{}').dropped || {}; } catch (e) { dropped = {}; }
      cb(nodes, r.errOut, dropped);
    });
  });
}

var CLASH = { host: '127.0.0.1', port: 9090 };

/* ask the sing-box Clash API something, e.g. GET /proxies */
function clash(method, path, payload, cb) {
  var data = payload ? JSON.stringify(payload) : null;
  var req = http.request({ host: CLASH.host, port: CLASH.port, path: path,
                           method: method, timeout: 20000,
                           headers: data ? { 'Content-Type': 'application/json',
                                             'Content-Length': Buffer.byteLength(data) } : {} },
    function (r) {
      var out = '';
      r.on('data', function (c) { out += c; });
      r.on('end', function () {
        var obj = null;
        try { obj = JSON.parse(out); } catch (e) { obj = null; }
        cb(obj, r.statusCode, out);
      });
    });
  req.on('error', function (e) { cb(null, 0, String(e.message || e)); });
  req.on('timeout', function () { req.abort(); cb(null, 0, 'timeout'); });
  if (data) req.write(data);
  req.end();
}

/* one node's latency in ms via the Clash API (null when it does not answer) */
function clashDelay(tag, cb) {
  var url = '/proxies/' + tag + '/delay?timeout=3000&url=' +
            encodeURIComponent('http://cp.cloudflare.com/generate_204');
  clash('GET', url, null, function (obj, code) {
    cb(obj && obj.delay ? obj.delay : null);
  });
}

/* node list + the delay each node last reported */
function proxies(cb) {
  clash('GET', '/proxies', null, function (obj, code) {
    if (!obj || !obj.proxies) return cb({}, null);
    var out = {};
    for (var k in obj.proxies) {
      if (!obj.proxies.hasOwnProperty(k)) continue;
      var pr = obj.proxies[k];
      var hist = pr.history || [];
      var last = hist.length ? hist[hist.length - 1] : null;
      out[k] = { now: pr.now || null, type: pr.type,
                 delay: (last && last.delay) ? last.delay : null };
    }
    cb(out, null);
  });
}

var SWEEP = { running: false, done: 0, total: 0, results: {}, started: 0, error: null };
var EXITIP = { value: null, at: 0 };

function sweepState() {
  return { running: SWEEP.running, done: SWEEP.done, total: SWEEP.total,
           results: SWEEP.results, started: SWEEP.started, error: SWEEP.error };
}

/* measure every node's latency, a few at a time, and remember the results */
function startSweep(mode, cb) {
  if (SWEEP.running) return cb(sweepState());
  var py = '/usr/bin/python';
  run(py + ' ' + DIR + '/genconfig.py --sub ' + DIR + '/sub-' + mode + '.raw --list', function (r) {
    var list = [];
    try { list = JSON.parse(r.out || '[]'); } catch (e) { list = []; }
    if (!list.length) { SWEEP.error = 'no nodes'; return cb(sweepState()); }
    SWEEP = { running: true, done: 0, total: list.length, results: {}, started: Date.now(), error: null };
    var i = 0;
    var inflight = 0;
    function pump() {
      while (inflight < 5 && i < list.length) {
        (function (tag) {
          inflight++;
          clashDelay(tag, function (ms) {
            SWEEP.results[tag] = ms;
            SWEEP.done++;
            inflight--;
            pump();
          });
        })(list[i].tag);
        i++;
      }
      if (i >= list.length && inflight === 0) {
        SWEEP.running = false;
        if (config().auto) applyBest();
      }
    }
    pump();
    cb(sweepState());
  });
}

/* switch the selector to the node with the smallest measured delay */
function applyBest() {
  var best = null, bestMs = 1e9;
  for (var tag in SWEEP.results) {
    if (!SWEEP.results.hasOwnProperty(tag)) continue;
    var ms = SWEEP.results[tag];
    if (ms && ms > 0 && ms < bestMs) { bestMs = ms; best = tag; }
  }
  if (!best) return;
  clash('PUT', '/proxies/vpn', { name: best }, function () {
    var c = config();
    c.node = parseInt(best.replace(/^n/, ''), 10) || 0;
    c.best = best; c.best_ms = bestMs; c.picked_at = Math.floor(Date.now() / 1000);
    saveConfig(c);
  });
}

/* ---------------------------------------------------------------- supervisor
 * Один в один схема с телефона: проба внешнего канала через сам туннель,
 * гистерезис (3 плохие -> переключение, 2 хорошие -> назад), пауза >= 10 мин
 * между переключениями, периодическая перепроверка лучшего узла.
 */
var SUP = { good: 0, bad: 0, lastSwitch: 0, lastBest: 0, switches: 0, badTotal: 0, note: '', at: 0, startAt: 0 };
var NODES = [];

function measure(tags, cb) {
  var out = {}, i = 0, inflight = 0;
  function pump() {
    while (inflight < 3 && i < tags.length) {
      (function (tag) {
        inflight++;
        clashDelay(tag, function (ms) { out[tag] = ms; inflight--; pump(); });
      })(tags[i]);
      i++;
    }
    if (i >= tags.length && inflight === 0) cb(out);
  }
  if (!tags.length) return cb(out);
  pump();
}

/* список тегов узлов: из последнего замера, иначе спрашиваем профиль */
function nodeTags(cb) {
  if (NODES.length) return cb(NODES);
  run('/usr/bin/python ' + DIR + '/genconfig.py --sub ' + DIR + '/sub-' +
      (config().mode === 'whitelist' ? 'whitelist' : 'normal') + '.raw --list', function (r) {
    var list = [];
    try { list = JSON.parse(r.out || '[]'); } catch (e) { list = []; }
    NODES = list.map(function (n) { return n.tag; });
    cb(NODES);
  });
}

/* кандидаты на переключение: сначала те, что уже показали малый пинг */
function candidates(count, cb) {
  nodeTags(function (tags) {
    var scored = tags.filter(function (t) { return SWEEP.results[t]; })
                     .sort(function (a, b) { return SWEEP.results[a] - SWEEP.results[b]; });
    var out = scored.slice(0, count);
    if (out.length < count) {
      // мало замеров - берём окно по кругу, чтобы узлы проверялись со временем
      var start = Math.floor(Math.random() * Math.max(1, tags.length));
      for (var i = 0; i < tags.length && out.length < count; i++) {
        var t = tags[(start + i) % tags.length];
        if (out.indexOf(t) < 0) out.push(t);
      }
    }
    cb(out);
  });
}

function switchTo(tag, ms, why) {
  clash('PUT', '/proxies/vpn', { name: tag }, function (obj, code) {
    if (code && code >= 400) { SUP.note = 'переключение не удалось: ' + code; return; }
    var c = config();
    var idx = parseInt(String(tag).replace(/^n/, ''), 10) || 0;
    c.node = idx;
    c['node_' + ((c.mode === 'whitelist') ? 'whitelist' : 'normal')] = idx;
    c.best = tag; c.best_ms = ms || null; c.picked_at = Math.floor(Date.now() / 1000);
    saveConfig(c);
    SUP.lastSwitch = Date.now(); SUP.switches++; SUP.good = 0; SUP.bad = 0;
    SUP.note = (why || 'переключение') + ': ' + tag + (ms ? ' (' + ms + ' мс)' : '');
    console.log('supervisor: ' + SUP.note);
  });
}

function failover() {
  var cc = config();
  var cur = 'n' + Math.max(0, nodeFor(cc, cc.mode || 'normal'));
  candidates(10, function (tags) {
    if (tags.indexOf(cur) < 0) tags.unshift(cur);   // сравнивать с текущим
    measure(tags, function (res) {
      var best = null, ms = 1e9;
      for (var t in res) if (res[t] && res[t] > 0 && res[t] < ms) { ms = res[t]; best = t; }
      if (!best) { SUP.note = 'не нашёл рабочий узел, оставляю как есть (попробую позже)'; return; }
      var curMs = res[cur] || 0;
      if (best !== cur && curMs && ms > curMs) {
        SUP.note = 'лучше текущего не нашлось (' + cur + ' ' + curMs + ' мс, лучший ' + best + ' ' + ms + ' мс)';
        return;
      }
      switchTo(best, ms, 'автопереключение');
    });
  });
}

function keepBest() {
  nodeTags(function (tags) {
    var cc = config();
  var cur = 'n' + Math.max(0, nodeFor(cc, cc.mode || 'normal'));
    candidates(5, function (list) {
      if (list.indexOf(cur) < 0) list.unshift(cur);
      measure(list, function (res) {
        var best = null, ms = 1e9;
        for (var t in res) if (res[t] && res[t] > 0 && res[t] < ms) { ms = res[t]; best = t; }
        var curMs = res[cur] || 0;
        if (best && best !== cur && (!curMs || ms < curMs * 0.75)) switchTo(best, ms, 'нашёл быстрее');
        else SUP.lastBest = Date.now();
      });
    });
  });
}

/* Сразу после подъёма проверяем связь: первый узел профиля может быть мёртвым, и
   человек не должен ждать три минуты. Ждём 25 секунд (Reality-рукопожатие) и,
   если связи нет, сразу пересаживаемся на рабочий узел. */
function kickAfterStart(attempt) {
  attempt = attempt || 0;
  setTimeout(function () {
    var c = config();
    if (!c.auto) return;
    if (stateFile('state') !== 'up') {
      // туннель ещё поднимается — вернёмся к проверке позже
      if (attempt < 4) return kickAfterStart(attempt + 1);
      return;
    }
    clash('GET', '/proxies/vpn/delay?timeout=4000&url=' +
          encodeURIComponent('http://cp.cloudflare.com/generate_204'), null, function (obj) {
      if (obj && obj.delay) { SUP.startAt = 0; return; }   // узел живой
      SUP.startAt = SUP.startAt || Date.now();
      failover();
      // после пересадки проверяем ещё раз: в обходном профиле часть узлов мертва
      if (attempt < 3) kickAfterStart(attempt + 1);
    });
  }, attempt === 0 ? 25000 : 30000);
}

function superviseTick() {
  var c = config();
  SUP.at = Math.floor(Date.now() / 1000);
  if (!c.auto) return;
  if (stateFile('state') !== 'up') return;
  clash('GET', '/proxies/vpn/delay?timeout=3000&url=' +
        encodeURIComponent('http://cp.cloudflare.com/generate_204'), null, function (obj) {
    var ok = !!(obj && obj.delay);
    if (ok) {
      SUP.good++; SUP.bad = 0;
      // раз в ~5 минут и не чаще, чем раз в 10 минут: не пора ли пересесть
      if (SUP.good >= 5 && (Date.now() - SUP.lastSwitch) > 600000) {
        SUP.good = 0;
        keepBest();
      }
    } else {
      SUP.bad++; SUP.good = 0; SUP.badTotal++;
      var fresh = SUP.startAt && (Date.now() - SUP.startAt) < 300000;
      if ((SUP.bad >= 3 || (fresh && SUP.bad >= 1)) && (Date.now() - SUP.lastSwitch) > 120000) {
        SUP.startAt = 0;
        failover();
      }
    }
  });
}

setInterval(superviseTick, 60000);
setTimeout(superviseTick, 15000);

function body(req, cb) {
  var chunks = '';
  req.on('data', function (c) { chunks += c; });
  req.on('end', function () { cb(chunks); });
}

function json(res, obj, code) {
  var text = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function text(res, str, code) {
  res.writeHead(code || 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(str);
}

function tail(file, bytes) {
  var data = readFile(file, '');
  return data.slice(-(bytes || 4000));
}

/* with auto enabled the best node is picked again after every reboot */
setTimeout(function () {
  var c = config();
  if (c.auto) startSweep(c.mode === 'whitelist' ? 'whitelist' : 'normal', function () {});
}, 25000);

function handler(req, res) {
  var u = url.parse(req.url, true);
  var path = u.pathname;

  // By default the panel is open to the whole home network (anyone on the LAN
  // can start/stop the tunnel). Put "require_key": true into config.json to
  // gate every remote call behind ?k=<token>.
  if (config().require_key === true && !allowed(req, u)) {
    return text(res, 'нужен ключ доступа: http://<tv-ip>:8099/?k=<token>\n' +
                     'ключ в config.json на телевизоре (поле token)', 403);
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    var html = readFile(DIR + '/ui.html', '<h1>ui.html missing</h1>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  if (path === '/api/status') {
    return status(function (st) { json(res, st); });
  }

  if (path === '/api/nodes') {
    var mode = u.query.mode === 'whitelist' ? 'whitelist' : 'normal';
    return listNodes(mode, function (nodes, err, dropped) {
      NODES = (nodes || []).map(function (n) { return n.tag; });
      json(res, { mode: mode, nodes: nodes, error: err || null, dropped: dropped || {} });
    });
  }

  if (path === '/api/proxies') {
    return proxies(function (map, err) { json(res, { ok: !err, proxies: map, error: err }); });
  }

  if (path === '/api/ping') {
    return json(res, { ok: true, sweep: sweepState() });
  }

  if (path === '/api/exitip') {
    var now = Date.now();
    if (EXITIP.value && (now - EXITIP.at) < 30000) return json(res, { ok: true, ip: EXITIP.value });
    return run('curl -s -m 10 https://api.ipify.org', function (r) {
      var ip = (r.out || '').trim();
      if (/^[0-9a-fA-F:.]{7,45}$/.test(ip)) EXITIP = { value: ip, at: now };
      json(res, { ok: !!EXITIP.value, ip: EXITIP.value || null });
    });
  }

  if (path === '/api/log') {
    return text(res, '--- ctl.log ---\n' + tail(DIR + '/ctl.log', 3000) +
      '\n--- sing-box.log ---\n' + tail(DIR + '/sing-box.log', 2000));
  }

  // есть ли в репозитории версия новее: панель показывает кнопку «Обновить»
  if (path === '/api/update-check') {
    return run('curl -s -m 20 ' + REPO + '/src/ui.html | grep -o "Nyamiko v[0-9.]*" | head -1', function (r) {
      var latest = ((r.out || '').match(/v([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1] || null;
      var mine = localVersion();
      return json(res, { ok: !!latest, current: mine, latest: latest,
                         newer: !!(latest && mine && cmpVer(latest, mine) > 0) });
    });
  }

  // диагностика: один текстовый файл, который человек приложит к сообщению об ошибке
  if (path === '/api/diag') {
    return diagnostics(function (txt) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
                           'Content-Disposition': 'attachment; filename="nyamiko-diag.txt"' });
      res.end(txt);
    });
  }

  if (req.method !== 'POST') return text(res, 'not found', 404);

  return body(req, function (raw) {
    var data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }

    if (path === '/api/start') {
      var cfg = config();
      var mode = data.mode || cfg.mode || 'normal';
      var node = (data.node === undefined || data.node === null) ? nodeFor(cfg, mode) : data.node;
      cfg.mode = mode;
      cfg['node_' + (mode === 'whitelist' ? 'whitelist' : 'normal')] = node;
      cfg.node = node;                 // для совместимости со старыми файлами
      saveConfig(cfg);
      SUP.startAt = Date.now();
      return run('sh ' + CTL + ' up ' + mode + ' ' + node, function (r) {
        status(function (st) { json(res, { ok: !r.err, run: r.out, error: r.err || st.error || null, status: st }); });
        kickAfterStart();
      });
    }

    if (path === '/api/stop') {
      return run('sh ' + CTL + ' down', function (r) {
        status(function (st) { json(res, { ok: !r.err, run: r.out, status: st }); });
      });
    }

    if (path === '/api/ping') {
      var m = (data.mode === 'whitelist') ? 'whitelist' : 'normal';
      return startSweep(m, function (st) { json(res, { ok: true, sweep: st }); });
    }

    if (path === '/api/auto') {
      var c2 = config();
      c2.auto = !!data.on;
      saveConfig(c2);
      if (c2.auto) return startSweep(c2.mode === 'whitelist' ? 'whitelist' : 'normal', function (st) {
        json(res, { ok: true, auto: true, sweep: st });
      });
      return json(res, { ok: true, auto: false });
    }

    if (path === '/api/failover') {
      failover();
      return json(res, { ok: true, note: 'запускаю перебор лучших узлов' });
    }

    if (path === '/api/select') {
      var tag = String(data.tag || '');
      if (!/^[a-zA-Z0-9_-]+$/.test(tag)) return json(res, { ok: false, error: 'bad tag' }, 400);
      return clash('PUT', '/proxies/vpn', { name: tag }, function (obj, code, raw) {
        if (code && code >= 400) return json(res, { ok: false, error: 'clash ' + code + ': ' + raw });
        var c = config();
        c.auto = false;                      // a manual pick switches auto off
        c.node = parseInt(tag.replace(/^n/, ''), 10) || 0;
        c['node_' + ((c.mode === 'whitelist') ? 'whitelist' : 'normal')] = c.node;
        saveConfig(c);
        json(res, { ok: true, selected: tag });
      });
    }

    if (path === '/api/fetch') {
      return run('sh ' + CTL + ' fetch normal; sh ' + CTL + ' fetch whitelist', function (r) {
        json(res, { ok: !r.err, out: r.out, error: r.err });
      });
    }

    if (path === '/api/rescue') {
      return run('sh ' + CTL + ' rescue', function (r) {
        json(res, { ok: !r.err, out: (r.out || '') + (r.errOut || ''), error: r.err });
      });
    }

    if (path === '/api/save') {
      var c = config();
      // an empty string means "leave it alone": the panel cannot show the
      // stored link back to the user, so it must never blank it by accident
      if (data.sub_normal !== undefined) {
        var sn = String(data.sub_normal).trim();
        if (sn) c.sub_normal = sn; else if (data.clear_normal) c.sub_normal = '';
      }
      if (data.sub_whitelist !== undefined) {
        var sw = String(data.sub_whitelist).trim();
        if (sw) c.sub_whitelist = sw; else if (data.clear_whitelist) c.sub_whitelist = '';
      }
      if (data.mode !== undefined) c.mode = (data.mode === 'whitelist') ? 'whitelist' : 'normal';
      if (data.autostart !== undefined) c.autostart = !!data.autostart;
      if (data.node !== undefined) {
        var nv = parseInt(data.node, 10);
        c.node = nv;
        c['node_' + ((c.mode === 'whitelist') ? 'whitelist' : 'normal')] = nv;
      }
      saveConfig(c);
      // answer at once: the subscription fetch can take a while
      json(res, { ok: true, saved: { sub_normal: !!c.sub_normal, sub_whitelist: !!c.sub_whitelist, mode: c.mode, autostart: c.autostart } });
      return run('sh ' + CTL + ' fetch normal; sh ' + CTL + ' fetch whitelist', function () {});
    }

    // обновление клиента из панели: тянем установщик из репозитория и запускаем
    // его в фоне. Демон при этом перезапустится, поэтому ответ отдаём сразу.
    if (path === '/api/self-update') {
      if (UPDATE_RUNNING) return json(res, { ok: false, error: 'обновление уже идёт', running: true }, 409);
      UPDATE_RUNNING = true;
      run('sh -c "curl -fsSL ' + REPO + '/install.sh -o /tmp/nyamiko-install.sh && ' +
          'sh /tmp/nyamiko-install.sh --update > /tmp/nyamiko-update.log 2>&1" >/dev/null 2>&1 &', function () {});
      setTimeout(function () { UPDATE_RUNNING = false; }, 120000);
      return json(res, { ok: true, started: true,
                         note: 'файлы обновляются, панель перезапустится через несколько секунд' });
    }

    return text(res, 'unknown endpoint', 404);
  });
}
var listener = http.createServer(handler);
listener.on('error', function (e) {
  if (e && e.code === 'EADDRINUSE') {
    console.log('tvtunnd: 8099 уже слушается, выходим (второй экземпляр не нужен)');
    process.exit(0);
  }
  console.log('tvtunnd error: ' + (e && e.message));
  process.exit(1);
});
listener.listen(PORT, '0.0.0.0', function () {
  console.log('tvtunnd listening on ' + PORT);
});
