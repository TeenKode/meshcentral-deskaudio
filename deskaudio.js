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
    obj.exports = ['onDeviceRefreshEnd', 'render', 'toggle', 'start', 'stop', 'setVolume', 'setAuto', 'setCompress', 'setRate', 'setSilence', 'setBuffer', 'onChunk', 'onStatus', 'onDesktopDisconnect', '_adpcmDecode'];

    var fs = require('fs');
    var path = require('path');
    var crypto = require('crypto');

    var MESHRIGHT_REMOTECONTROL = 0x00000008;
    var MAX_LISTENERS_PER_NODE = 10;
    var MAX_TOTAL_STREAMS = 50;   // server-wide cap on simultaneously captured devices
    var KEEPALIVE_MS = 15000;
    var listeners = {};          // nodeid -> [user session objects]
    var keepTimer = null;
    var helperCache = null;

    // ---------- helpers ----------
    function log(msg) { try { obj.meshServer.debug('deskaudio: ' + msg); } catch (e) { } }

    function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex').substring(0, 8); }

    function loadHelpers() {
        if (helperCache) return helperCache;
        var src = fs.readFileSync(path.join(__dirname, 'helpers', 'win-loopback.cs'));
        var sh = fs.readFileSync(path.join(__dirname, 'helpers', 'linux-capture.sh'));
        var exe64 = fs.readFileSync(path.join(__dirname, 'helpers', 'deskaudio-x64.exe'));
        var exe32 = fs.readFileSync(path.join(__dirname, 'helpers', 'deskaudio-x86.exe'));
        helperCache = {
            script: sh.toString('base64'),
            // Windows: prebuilt native helpers (no .NET required). 32-bit build runs
            // on 32- and 64-bit Windows; 64-bit build runs natively on x64.
            exe64: exe64.toString('base64'), ver64: md5(exe64),
            exe32: exe32.toString('base64'), ver32: md5(exe32),
            // Fallback if the prebuilt exe can't be dropped: compile the C# helper on
            // the machine with any csc.exe that ships with the .NET Framework.
            source: src.toString('base64'), ver: md5(src)
        };
        return helperCache;
    }

    // Sign the native Windows helpers with the same code-signing certificate
    // MeshCentral uses for its agents (obj.certificates.codesign), via the built-in
    // authenticode.js module. Best-effort: if there is no code-signing certificate
    // or the module can't be loaded, the helpers are shipped as-is. Signed bytes
    // replace the cached copies in place, so the agent re-drops the signed version
    // (its version hash changes) on the next start.
    function signHelpers() {
        var mc = obj.meshServer;
        if (!mc || !mc.certificates || !mc.certificates.codesign) {
            log('signing skipped: no server code-signing certificate'); return;
        }
        var co = mc.certificateOperations, forge = co && co.forge;
        if (!forge) { log('signing skipped: certificate operations unavailable'); return; }

        var authenticode = null;
        try {
            var mainFile = (require.main && require.main.filename) || (process.mainModule && process.mainModule.filename);
            if (mainFile) authenticode = require(path.join(path.dirname(mainFile), 'authenticode.js'));
        } catch (e) { }
        if (!authenticode) { try { authenticode = require('./authenticode.js'); } catch (e) { } }
        if (!authenticode || typeof authenticode.createAuthenticodeHandler !== 'function') {
            log('signing skipped: authenticode module not found'); return;
        }

        var certInfo;
        try {
            certInfo = {
                cert: forge.pki.certificateFromPem(mc.certificates.codesign.cert),
                key: forge.pki.privateKeyFromPem(mc.certificates.codesign.key)
            };
            if (mc.certificates.root && mc.certificates.root.cert)
                certInfo.extraCerts = [forge.pki.certificateFromPem(mc.certificates.root.cert)];
        } catch (e) { log('signing skipped: cannot read certificate: ' + e); return; }

        var h;
        try { h = loadHelpers(); } catch (e) { return; }
        var outDir = mc.datapath || __dirname;
        var certKey = md5(mc.certificates.codesign.cert);   // changes if the cert changes

        [['deskaudio-x64.exe', 'exe64', 'ver64'], ['deskaudio-x86.exe', 'exe32', 'ver32']].forEach(function (f) {
            try {
                var inPath = path.join(__dirname, 'helpers', f[0]);
                // Cache the signed binary by (unsigned-exe hash + cert). Reusing it
                // keeps the signed bytes — and thus the version hash the agent sees —
                // stable across server restarts (Authenticode embeds a signing time,
                // so re-signing every startup would otherwise change the hash).
                var outPath = path.join(outDir, 'deskaudio-signed-' + h[f[2]] + '-' + certKey + '-' + f[0]);
                if (fs.existsSync(outPath)) {
                    var cached = fs.readFileSync(outPath);
                    h[f[1]] = cached.toString('base64');
                    h[f[2]] = md5(cached);
                    return;
                }
                var hnd = authenticode.createAuthenticodeHandler(inPath);
                if (!hnd) return;
                hnd.sign(certInfo, { hash: 'sha384', out: outPath, desc: 'Desktop Audio helper' }, function (err) {
                    try {
                        if (!err) {
                            var signed = fs.readFileSync(outPath);
                            h[f[1]] = signed.toString('base64');
                            h[f[2]] = md5(signed);
                            log('signed ' + f[0] + ' with server code-signing certificate');
                        } else { log('signing failed for ' + f[0] + ': ' + err); }
                    } catch (e) { }
                    try { hnd.close(); } catch (e) { }
                });
            } catch (e) { log('signing error for ' + f[0] + ': ' + e); }
        });
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
            // Server-wide cap: a brand-new capture (no existing listeners for this
            // node) counts against the total number of simultaneous streams.
            if (!listeners[nodeid] && Object.keys(listeners).length >= MAX_TOTAL_STREAMS)
                return sendUser(sess, { method: 'onStatus', nodeid: nodeid, state: 'error', msg: 'Сервер: слишком много одновременных аудиопотоков' });

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
                sendAgent(agent, {
                    pluginaction: 'start', rate: rate,
                    compress: command.compress !== false, silence: command.silence !== false, script: h.script,
                    exe64: h.exe64, ver64: h.ver64, exe32: h.exe32, ver32: h.ver32,
                    source: h.source, ver: h.ver
                });
            } else {
                sendUser(sess, { method: 'onStatus', nodeid: nodeid, state: 'started' });
            }
        });
    }

    // ---------- agent -> server ----------
    function agentAction(command, agent) {
        var nodeid = agent.dbNodeKey;   // taken from the authenticated agent, never from the message
        var list = listeners[nodeid];
        if (!list) {
            // No listeners (e.g. the server restarted while the agent was still
            // capturing, or the last listener just left): tell the agent to stop
            // so it does not keep an orphaned capture running.
            if (command.pluginaction === 'chunk' || (command.pluginaction === 'status' && command.state !== 'stopped' && command.state !== 'error')) {
                sendAgent(agent, { pluginaction: 'stop' });
            }
            return;
        }
        switch (command.pluginaction) {
            case 'chunk':
                if (typeof command.d !== 'string' || command.d.length > 262144) return;
                list.forEach(function (s) { sendUser(s, { method: 'onChunk', nodeid: nodeid, rate: command.rate, codec: command.codec, d: command.d }); });
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

    obj.server_startup = function () { log('loaded'); try { signHelpers(); } catch (e) { log('signHelpers error: ' + e); } };

    // =====================================================================
    //  Everything below runs in the BROWSER (serialized via obj.exports)
    // =====================================================================

    obj.onDeviceRefreshEnd = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        pluginHandler.registerPluginTab({ tabId: 'pluginDeskAudio', tabTitle: 'Звук' });
        if (s.active && typeof currentNode !== 'undefined' && currentNode && s.nodeid !== currentNode._id) P.stop();
        function pref(k, d) { try { var v = localStorage.getItem('deskaudio_' + k); return (v === null) ? d : v; } catch (e) { return d; } }
        var H = 'pluginHandler.deskaudio';
        QH('pluginDeskAudio',
            '<div style="padding:10px;max-width:560px">' +
            '<b>Звук рабочего стола</b>' +
            '<p style="opacity:.7;font-size:12px;margin:6px 0">Передаётся то, что воспроизводится на динамики удалённого компьютера. ' +
            'Нужно право «удалённое управление». Действие записывается в журнал событий устройства.</p>' +
            '<div style="margin:6px 0"><input type="button" id="da_btn" value="Слушать" onclick="' + H + '.toggle()"> ' +
            ' Громкость <input type="range" id="da_vol" min="0" max="100" value="80" style="vertical-align:middle" oninput="' + H + '.setVolume(this.value)"></div>' +
            '<div style="height:8px;background:rgba(128,128,128,.25);border-radius:4px;overflow:hidden;margin:6px 0">' +
            '<div id="da_bar" style="height:100%;width:0;background:#4a9;"></div></div>' +
            '<div id="da_status" style="font-size:12px;opacity:.8;min-height:16px"></div>' +
            '<fieldset style="margin:10px 0 0;border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:8px 10px">' +
            '<legend style="opacity:.7;font-size:12px;padding:0 4px">Настройки</legend>' +
            '<div style="margin:5px 0">Качество: <select id="da_rate" onchange="' + H + '.setRate(this.value)">' +
            '<option value="8000">8 кГц — экономно</option>' +
            '<option value="16000">16 кГц — речь</option>' +
            '<option value="24000">24 кГц — лучше</option></select>' +
            ' <span style="opacity:.6;font-size:11px">применится при следующем запуске</span></div>' +
            '<div style="margin:5px 0"><label><input type="checkbox" id="da_compress" onchange="' + H + '.setCompress(this.checked)"> ' +
            'Сжатие звука (ADPCM, экономит трафик; выключите для максимального качества)</label></div>' +
            '<div style="margin:5px 0"><label><input type="checkbox" id="da_silence" onchange="' + H + '.setSilence(this.checked)"> ' +
            'Не передавать тишину (экономит трафик, когда ничего не играет)</label></div>' +
            '<div style="margin:5px 0">Буфер / задержка: <select id="da_buffer" onchange="' + H + '.setBuffer(this.value)">' +
            '<option value="low">Низкий — меньше задержка</option>' +
            '<option value="med">Средний</option>' +
            '<option value="high">Высокий — стабильнее при рывках</option></select></div>' +
            '<div style="margin:5px 0"><label><input type="checkbox" id="da_auto" onchange="' + H + '.setAuto(this.checked)"> ' +
            'Слушать звук при подключении к рабочему столу</label></div>' +
            '</fieldset></div>');
        function setSel(id, val) { var e = document.getElementById(id); if (e) e.value = val; }
        function setChk(id, on) { var e = document.getElementById(id); if (e) e.checked = on; }
        setSel('da_rate', pref('rate', '16000'));
        setSel('da_buffer', pref('buffer', 'med'));
        setChk('da_compress', pref('compress', '1') !== '0');
        setChk('da_silence', pref('silence', '1') !== '0');
        setChk('da_auto', pref('auto', '0') === '1');
        try { var vv = document.getElementById('da_vol'); var sv = pref('vol', null); if (sv !== null && vv) vv.value = sv; } catch (e) { }

        // Button in the Desktop tab's official custom-UI slot (survives version changes).
        var slot = document.getElementById('desktopCustomUiButtons');
        if (slot && !document.getElementById('da_deskbtn')) {
            var db = document.createElement('input');
            db.type = 'button'; db.id = 'da_deskbtn';
            db.title = 'Слушать звук рабочего стола';
            db.onclick = function () { pluginHandler.deskaudio.toggle(); };
            slot.appendChild(db);
        }

        // Live "audio is being listened" indicator in the Desktop panel, styled
        // exactly like MeshCentral's own record indicator (deskRecordIcon) and
        // placed right next to it. render() shows/hides it with the session.
        var rec = document.getElementById('deskRecordIcon');
        if (rec && rec.parentNode && !document.getElementById('da_deskind')) {
            var ind = document.createElement('div');
            ind.id = 'da_deskind';
            ind.className = 'deskareaicon';
            ind.title = 'Идёт прослушивание звука рабочего стола';
            ind.style.cssText = 'display:none;background-color:#4a9;width:12px;height:12px;border-radius:6px;margin-top:5px;margin-left:5px';
            rec.parentNode.insertBefore(ind, rec.nextSibling);
        }

        // Auto-start on desktop connect. MeshCentral has no onDesktopConnect hook,
        // so hook the Connect button; audio runs over its own channel and does not
        // depend on the desktop stream. Stop is handled by onDesktopDisconnect.
        var cbtn = document.getElementById('connectbutton1');
        if (cbtn && !cbtn._daHooked) {
            cbtn._daHooked = true;
            cbtn.addEventListener('click', function () {
                var P2 = pluginHandler.deskaudio, s2 = P2._s || {};
                var auto = false; try { auto = (localStorage.getItem('deskaudio_auto') === '1'); } catch (e) { }
                if (auto && !s2.active) setTimeout(function () {
                    pluginHandler.deskaudio.start();
                }, 300);
            });
        }
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
        var db = document.getElementById('da_deskbtn');
        if (db) db.value = s.active ? '⏹ Звук' : '🔊 Звук';
        var ind = document.getElementById('da_deskind');
        if (ind) ind.style.display = s.active ? '' : 'none';
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
        s.gotAudio = false;
        s.statusText = 'Подключение…';
        // Don't hang on "Подключение…": if the agent never responds, reset.
        if (s.connectTimer) { clearTimeout(s.connectTimer); }
        s.connectTimer = setTimeout(function () {
            var Pt = pluginHandler.deskaudio, st2 = Pt._s || {};
            if (st2.active && !st2.gotAudio) { Pt.stop(); st2.statusText = 'Нет ответа от агента'; Pt.render(); }
        }, 10000);
        function g(k, d) { try { var v = localStorage.getItem('deskaudio_' + k); return (v === null) ? d : v; } catch (e) { return d; } }
        var r = document.getElementById('da_rate');
        var rate = r ? parseInt(r.value, 10) : parseInt(g('rate', '16000'), 10);
        var compress = (g('compress', '1') !== '0');
        var silence = (g('silence', '1') !== '0');
        var jit = { low: 0.08, med: 0.15, high: 0.30 }[g('buffer', 'med')] || 0.15;
        s.jitter = jit;
        meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'start', nodeid: s.nodeid, rate: rate, compress: compress, silence: silence });
        P.render();
    };

    obj.stop = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
        if (s.nodeid) meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'stop', nodeid: s.nodeid });
        try { if (s.ctx) s.ctx.close(); } catch (e) { }
        s.ctx = null; s.gain = null; s.active = false; s.statusText = 'Остановлено';
        P.render();
    };

    obj.setVolume = function (val) {
        var s = pluginHandler.deskaudio._s || {};
        if (s.gain) s.gain.gain.value = val / 100;
        try { localStorage.setItem('deskaudio_vol', String(val)); } catch (e) { }
    };

    // Remembered per-browser default: auto-listen when connecting to the desktop.
    obj.setAuto = function (on) { try { localStorage.setItem('deskaudio_auto', on ? '1' : '0'); } catch (e) { } };

    // Remembered per-browser default: compress audio (ADPCM) vs. raw PCM. Takes
    // effect on the next start (stop and start again to switch mid-listen).
    obj.setCompress = function (on) { try { localStorage.setItem('deskaudio_compress', on ? '1' : '0'); } catch (e) { } };

    // More remembered settings (all apply on the next start).
    obj.setRate = function (v) { try { localStorage.setItem('deskaudio_rate', String(v)); } catch (e) { } };
    obj.setSilence = function (on) { try { localStorage.setItem('deskaudio_silence', on ? '1' : '0'); } catch (e) { } };
    obj.setBuffer = function (v) { try { localStorage.setItem('deskaudio_buffer', String(v)); } catch (e) { } };

    // Called by MeshCentral when the remote desktop disconnects. Audio is tied to
    // the desktop session, so stop listening whenever the desktop is closed.
    obj.onDesktopDisconnect = function () {
        if ((pluginHandler.deskaudio._s || {}).active) pluginHandler.deskaudio.stop();
    };

    obj.onStatus = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;     // handler signature differs between MeshCentral versions
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (!m || m.nodeid !== s.nodeid) return;
        if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }  // agent responded
        if (m.state === 'started') s.statusText = 'Идёт передача звука' + (m.rate ? ' (' + (m.rate / 1000) + ' кГц)' : '');
        else if (m.state === 'error' || m.state === 'stopped') {
            try { if (s.ctx) s.ctx.close(); } catch (e) { }
            s.ctx = null; s.gain = null; s.active = false;
            s.statusText = (m.state === 'error' ? 'Ошибка: ' : 'Остановлено. ') + (m.msg || '');
        }
        P.render();
    };

    // IMA ADPCM decoder — mirrors modules_meshcore/deskaudio.js adpcmEncode().
    obj._adpcmDecode = function (bin) {
        var STEP = [
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
            50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
            253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
            1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
            3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
            11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
        var IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
        var len = bin.length;
        if (len < 4) return new Float32Array(0);
        var predictor = bin.charCodeAt(0) | (bin.charCodeAt(1) << 8);
        if (predictor & 0x8000) predictor -= 0x10000;
        var index = bin.charCodeAt(2);
        if (index < 0) index = 0; else if (index > 88) index = 88;
        var pad = bin.charCodeAt(3) ? 1 : 0;   // drop the trailing padding nibble if present
        var total = 1 + (len - 4) * 2 - pad;
        var out = new Float32Array(total > 0 ? total : 0), oi = 0;
        out[oi++] = predictor / 32768;
        for (var b = 4; b < len && oi < total; b++) {
            var byte = bin.charCodeAt(b);
            for (var half = 0; half < 2 && oi < total; half++) {
                var code = (half === 0) ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
                var step = STEP[index], vpdiff = step >> 3;
                if (code & 4) vpdiff += step;
                if (code & 2) vpdiff += step >> 1;
                if (code & 1) vpdiff += step >> 2;
                if (code & 8) predictor -= vpdiff; else predictor += vpdiff;
                if (predictor > 32767) predictor = 32767; else if (predictor < -32768) predictor = -32768;
                index += IDX[code];
                if (index < 0) index = 0; else if (index > 88) index = 88;
                out[oi++] = predictor / 32768;
            }
        }
        return out;
    };

    obj.onChunk = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;
        var s = (pluginHandler.deskaudio._s || {});
        if (!s.active || !s.ctx || !m || m.nodeid !== s.nodeid || typeof m.d !== 'string') return;
        var bin = atob(m.d);
        var f, sum = 0, i;
        if (m.codec === 'adpcm') {
            f = pluginHandler.deskaudio._adpcmDecode(bin);
            if (!f || f.length === 0) return;
            for (i = 0; i < f.length; i++) sum += f[i] * f[i];
        } else {
            var n0 = bin.length >> 1;
            if (n0 === 0) return;
            f = new Float32Array(n0);
            for (i = 0; i < n0; i++) {
                var v = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i);
                if (v & 0x8000) v -= 0x10000;
                f[i] = v / 32768;
                sum += f[i] * f[i];
            }
        }
        var n = f.length;
        var jit = s.jitter || 0.15;                          // jitter buffer from the Буфер setting
        var ctx = s.ctx, now = ctx.currentTime;
        if (s.next - now > jit * 2 + 0.45) return;           // too far behind real time: drop
        var buf = ctx.createBuffer(1, n, m.rate || 16000);
        buf.copyToChannel(f, 0);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(s.gain);
        if (s.next < now + 0.02) s.next = now + jit;         // (re)start with the chosen jitter buffer
        src.start(s.next);
        s.next += buf.duration;
        if (!s.gotAudio) { s.gotAudio = true; if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; } s.statusText = 'Идёт передача звука (' + ((m.rate || 16000) / 1000) + ' кГц)'; pluginHandler.deskaudio.render(); }
        var bar = document.getElementById('da_bar');
        if (bar) bar.style.width = Math.min(100, Math.round(Math.sqrt(sum / n) * 300)) + '%';
    };

    return obj;
};
