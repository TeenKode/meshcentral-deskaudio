/**
 * Desktop Audio plugin for MeshCentral — server side + web UI.
 *
 * Flow:  browser --(plugin/start)--> server --(plugin/start)--> agent
 *        agent captures desktop audio, sends base64 PCM chunks --> server --> browser(s)
 *
 * Functions listed in obj.exports are serialized and run in the BROWSER:
 * they must not reference anything outside their own body (except browser globals
 * and `pluginHandler`).
 */
"use strict";

module.exports.deskaudio = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = ['onDeviceRefreshEnd', 'render', 'toggle', 'start', 'stop', 'setVolume', 'onChunk', 'onStatus'];

    var fs = require('fs');
    var path = require('path');
    var crypto = require('crypto');

    var MESHRIGHT_REMOTECONTROL = 0x00000008;
    var MAX_LISTENERS_PER_NODE = 3;
    var KEEPALIVE_MS = 15000;
    var listeners = {};          // nodeid -> [user session objects]
    var keepTimer = null;
    var helperCache = null;

    // ---------- helpers ----------
    function log(msg) { try { obj.meshServer.debug('deskaudio: ' + msg); } catch (e) { } }

    function loadHelpers() {
        if (helperCache) return helperCache;
        var src = fs.readFileSync(path.join(__dirname, 'helpers', 'win-loopback.cs'));
        var sh = fs.readFileSync(path.join(__dirname, 'helpers', 'linux-capture.sh'));
        helperCache = {
            source: src.toString('base64'),
            script: sh.toString('base64'),
            ver: crypto.createHash('md5').update(src).digest('hex').substring(0, 8)
        };
        return helperCache;
    }

    function agentOf(nodeid) {
        var wa = obj.meshServer.webserver.wsagents;
        return (wa && wa[nodeid]) ? wa[nodeid] : null;
    }

    function sendAgent(agent, msg) {
        msg.action = 'plugin'; msg.plugin = 'deskaudio';
        try { agent.send(JSON.stringify(msg)); } catch (e) { }
    }

    function sendUser(sess, msg) {
        try {
            var ws = sess.ws;
            if (!ws || ws.readyState !== 1) return;
            // Real-time: if the browser can't keep up, drop audio instead of queueing it.
            if (msg.method === 'onChunk' && (ws.bufferedAmount || 0) > 1048576) return;
            msg.action = 'plugin'; msg.plugin = 'deskaudio';
            ws.send(JSON.stringify(msg));
        } catch (e) { }
    }

    function logEvent(sess, node, text) {
        try {
            obj.meshServer.DispatchEvent(['*', node.meshid, node._id], obj, {
                etype: 'node', action: 'deskaudio', nodeid: node._id,
                userid: sess.user._id, username: sess.user.name,
                msg: text, domain: node.domain
            });
        } catch (e) { }
    }

    function ensureKeepalive() {
        if (keepTimer) return;
        keepTimer = setInterval(function () {
            var ids = Object.keys(listeners);
            if (ids.length === 0) { clearInterval(keepTimer); keepTimer = null; return; }
            ids.forEach(function (nodeid) {
                var agent = agentOf(nodeid);
                if (!agent) { endStream(nodeid, 'stopped', 'Агент отключился'); return; }
                sendAgent(agent, { pluginaction: 'keepalive' });
            });
        }, KEEPALIVE_MS);
        if (keepTimer.unref) keepTimer.unref();
    }

    function endStream(nodeid, state, msg) {
        var list = listeners[nodeid];
        delete listeners[nodeid];
        if (list) list.forEach(function (s) { sendUser(s, { method: 'onStatus', nodeid: nodeid, state: state, msg: msg || '' }); });
    }

    function removeListener(nodeid, sess) {
        var list = listeners[nodeid];
        if (!list) return;
        list = list.filter(function (s) { return s !== sess; });
        if (list.length > 0) { listeners[nodeid] = list; return; }
        delete listeners[nodeid];
        var agent = agentOf(nodeid);
        if (agent) sendAgent(agent, { pluginaction: 'stop' });
    }

    function removeSession(sess) {
        Object.keys(listeners).forEach(function (nodeid) { removeListener(nodeid, sess); });
    }

    // ---------- user (browser) -> server ----------
    function userAction(command, sess, web) {
        var nodeid = command.nodeid;
        if (typeof nodeid !== 'string' || nodeid.indexOf('node/') !== 0) return;

        if (command.pluginaction === 'stop') { removeListener(nodeid, sess); return; }
        if (command.pluginaction !== 'start') return;

        var domain = sess.domain || obj.meshServer.config.domains[sess.user.domain];
        web.GetNodeWithRights(domain, sess.user, nodeid, function (node, rights) {
            if (!node || (rights & MESHRIGHT_REMOTECONTROL) === 0)
                return sendUser(sess, { method: 'onStatus', nodeid: nodeid, state: 'error', msg: 'Нет права «удалённое управление» на это устройство' });
            var agent = agentOf(nodeid);
            if (!agent)
                return sendUser(sess, { method: 'onStatus', nodeid: nodeid, state: 'error', msg: 'Устройство не в сети' });

            var list = listeners[nodeid] || [];
            if (list.indexOf(sess) >= 0) return;
            if (list.length >= MAX_LISTENERS_PER_NODE)
                return sendUser(sess, { method: 'onStatus', nodeid: nodeid, state: 'error', msg: 'Слишком много слушателей' });

            if (!sess._deskaudioHooked && sess.ws) {
                sess._deskaudioHooked = true;
                sess.ws.on('close', function () { removeSession(sess); });
            }
            list.push(sess);
            listeners[nodeid] = list;
            ensureKeepalive();
            logEvent(sess, node, 'Прослушивание звука рабочего стола: начало');

            if (list.length === 1) {
                var rate = parseInt(command.rate, 10);
                if ([8000, 16000, 24000].indexOf(rate) < 0) rate = 16000;
                var h;
                try { h = loadHelpers(); } catch (e) { endStream(nodeid, 'error', 'Не найдены файлы helpers/ плагина'); return; }
                sendAgent(agent, { pluginaction: 'start', rate: rate, script: h.script, source: h.source, ver: h.ver });
            } else {
                sendUser(sess, { method: 'onStatus', nodeid: nodeid, state: 'started' });
            }
        });
    }

    // ---------- agent -> server ----------
    function agentAction(command, agent) {
        var nodeid = agent.dbNodeKey;   // taken from the authenticated agent, never from the message
        var list = listeners[nodeid];
        if (!list) return;
        switch (command.pluginaction) {
            case 'chunk':
                if (typeof command.d !== 'string' || command.d.length > 262144) return;
                list.forEach(function (s) { sendUser(s, { method: 'onChunk', nodeid: nodeid, rate: command.rate, d: command.d }); });
                break;
            case 'status':
                var state = String(command.state || '');
                var msg = String(command.msg || '').substring(0, 500);
                if (state === 'stopped' || state === 'error') endStream(nodeid, state, msg);
                else list.forEach(function (s) { sendUser(s, { method: 'onStatus', nodeid: nodeid, state: state, rate: command.rate }); });
                break;
        }
    }

    obj.serveraction = function (command, myparent, grandparent) {
        try {
            var web = grandparent || obj.meshServer.webserver;
            if (myparent && myparent.user != null) return userAction(command, myparent, web);
            if (myparent && myparent.dbNodeKey != null) return agentAction(command, myparent);
        } catch (ex) { log('serveraction error: ' + ex); }
    };

    obj.server_startup = function () { log('loaded'); };

    // =====================================================================
    //  Everything below runs in the BROWSER (serialized via obj.exports)
    // =====================================================================

    obj.onDeviceRefreshEnd = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        pluginHandler.registerPluginTab({ tabId: 'pluginDeskAudio', tabTitle: 'Звук' });
        if (s.active && typeof currentNode !== 'undefined' && currentNode && s.nodeid !== currentNode._id) P.stop();
        QH('pluginDeskAudio',
            '<div style="padding:10px;max-width:520px">' +
            '<b>Звук рабочего стола</b>' +
            '<p style="opacity:.7;font-size:12px;margin:6px 0">Передаётся то, что воспроизводится на динамики удалённого компьютера. ' +
            'Нужно право «удалённое управление». Действие записывается в журнал событий устройства.</p>' +
            '<div style="margin:6px 0">Качество: <select id="da_rate">' +
            '<option value="8000">8 кГц — экономно</option>' +
            '<option value="16000" selected>16 кГц — речь</option>' +
            '<option value="24000">24 кГц — лучше</option></select></div>' +
            '<div style="margin:6px 0"><input type="button" id="da_btn" value="Слушать" onclick="pluginHandler.deskaudio.toggle()"> ' +
            ' Громкость <input type="range" id="da_vol" min="0" max="100" value="80" oninput="pluginHandler.deskaudio.setVolume(this.value)"></div>' +
            '<div style="height:8px;background:rgba(128,128,128,.25);border-radius:4px;overflow:hidden;margin:6px 0">' +
            '<div id="da_bar" style="height:100%;width:0;background:#4a9;"></div></div>' +
            '<div id="da_status" style="font-size:12px;opacity:.8"></div></div>');
        P.render();
    };

    obj.render = function () {
        var s = pluginHandler.deskaudio._s || {};
        var b = document.getElementById('da_btn');
        if (b) b.value = s.active ? 'Остановить' : 'Слушать';
        var r = document.getElementById('da_rate');
        if (r) r.disabled = !!s.active;
        var st = document.getElementById('da_status');
        if (st) st.textContent = s.statusText || '';
        if (!s.active) { var bar = document.getElementById('da_bar'); if (bar) bar.style.width = '0'; }
    };

    obj.toggle = function () {
        var P = pluginHandler.deskaudio;
        if ((P._s || {}).active) P.stop(); else P.start();
    };

    obj.start = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.active || typeof currentNode === 'undefined' || !currentNode) return;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { s.statusText = 'Браузер не поддерживает Web Audio'; P.render(); return; }
        s.ctx = new AC();
        if (s.ctx.resume) s.ctx.resume();          // we are inside a click handler, so this is allowed
        s.gain = s.ctx.createGain();
        var v = document.getElementById('da_vol');
        s.gain.gain.value = v ? (v.value / 100) : 0.8;
        s.gain.connect(s.ctx.destination);
        s.next = 0;
        s.nodeid = currentNode._id;
        s.active = true;
        s.statusText = 'Подключение…';
        var r = document.getElementById('da_rate');
        meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'start', nodeid: s.nodeid, rate: r ? parseInt(r.value, 10) : 16000 });
        P.render();
    };

    obj.stop = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.nodeid) meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'stop', nodeid: s.nodeid });
        try { if (s.ctx) s.ctx.close(); } catch (e) { }
        s.ctx = null; s.gain = null; s.active = false; s.statusText = 'Остановлено';
        P.render();
    };

    obj.setVolume = function (val) {
        var s = pluginHandler.deskaudio._s || {};
        if (s.gain) s.gain.gain.value = val / 100;
    };

    obj.onStatus = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;     // handler signature differs between MeshCentral versions
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (!m || m.nodeid !== s.nodeid) return;
        if (m.state === 'started') s.statusText = 'Идёт передача звука' + (m.rate ? ' (' + (m.rate / 1000) + ' кГц)' : '');
        else if (m.state === 'error' || m.state === 'stopped') {
            try { if (s.ctx) s.ctx.close(); } catch (e) { }
            s.ctx = null; s.gain = null; s.active = false;
            s.statusText = (m.state === 'error' ? 'Ошибка: ' : 'Остановлено. ') + (m.msg || '');
        }
        P.render();
    };

    obj.onChunk = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;
        var s = (pluginHandler.deskaudio._s || {});
        if (!s.active || !s.ctx || !m || m.nodeid !== s.nodeid || typeof m.d !== 'string') return;
        var bin = atob(m.d);
        var n = bin.length >> 1;
        if (n === 0) return;
        var f = new Float32Array(n), sum = 0;
        for (var i = 0; i < n; i++) {
            var v = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i);
            if (v & 0x8000) v -= 0x10000;
            f[i] = v / 32768;
            sum += f[i] * f[i];
        }
        var ctx = s.ctx, now = ctx.currentTime;
        if (s.next - now > 0.6) return;                      // too far behind real time: drop
        var buf = ctx.createBuffer(1, n, m.rate || 16000);
        buf.copyToChannel(f, 0);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(s.gain);
        if (s.next < now + 0.02) s.next = now + 0.15;        // (re)start with ~150 ms jitter buffer
        src.start(s.next);
        s.next += buf.duration;
        if (!s.gotAudio) { s.gotAudio = true; s.statusText = 'Идёт передача звука (' + ((m.rate || 16000) / 1000) + ' кГц)'; pluginHandler.deskaudio.render(); }
        var bar = document.getElementById('da_bar');
        if (bar) bar.style.width = Math.min(100, Math.round(Math.sqrt(sum / n) * 300)) + '%';
    };

    return obj;
};
