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
    obj.exports = ['onDeviceRefreshEnd', 'render', 'toggle', 'start', 'stop', 'setVolume', 'setAuto', 'setCompress', 'setRate', 'setCodec', 'setBitrate', 'setSilence', 'setBuffer', 'onChunk', 'onStatus', 'onDesktopDisconnect', '_adpcmDecode', '_ringNew', '_ringPush', 'probeCodecs', '_ensureCtx', '_ensureOpusDecoder', '_pushDecoded', '_opusChunk'];

    var fs = require('fs');
    var path = require('path');
    var crypto = require('crypto');

    var MESHRIGHT_REMOTECONTROL = 0x00000008;
    var MESHRIGHT_NODESKTOP = 0x00010000;
    var USERCONSENT_DesktopNotifyUser = 1;
    var USERCONSENT_DesktopPromptUser = 8;
    var MAX_LISTENERS_PER_NODE = 10;
    var MAX_TOTAL_STREAMS = 50;   // server-wide cap on simultaneously captured devices
    var KEEPALIVE_MS = 15000;
    var DEFAULT_CONSENT_MSG = 'Пользователь {0} запрашивает прослушивание звука этого компьютера. Разрешить?';
    var DEFAULT_NOTIFY_MSG = 'Пользователь {0} слушает звук этого компьютера.';

    // nodeid -> stream: { sid, listeners: [sess], users: {userid: true}, pending: {reqid: sess},
    //                     consent, ready, rate }
    // `sid` identifies one capture on the agent. The agent echoes it in every
    // status and chunk, so messages from an earlier capture (e.g. the "stopped"
    // of a stop that raced a new start) can never end or feed a newer one.
    var streams = {};
    var nextSid = 1;
    var nextReq = 1;
    var sessState = new WeakMap();   // user session -> { hooked, gen: {nodeid: n} }
    var keepTimer = null;
    var helperCache = null;

    // ---------- helpers ----------
    function log(msg) { try { obj.meshServer.debug('deskaudio: ' + msg); } catch (e) { } }

    function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex').substring(0, 8); }

    function loadHelpers() {
        if (helperCache) return helperCache;
        var sh = fs.readFileSync(path.join(__dirname, 'helpers', 'linux-capture.sh'));
        var exe64 = fs.readFileSync(path.join(__dirname, 'helpers', 'deskaudio-x64.exe'));
        var exe32 = fs.readFileSync(path.join(__dirname, 'helpers', 'deskaudio-x86.exe'));
        helperCache = {
            script: sh.toString('base64'),
            // Windows: prebuilt native helpers (no .NET required). 32-bit build runs
            // on 32- and 64-bit Windows; 64-bit build runs natively on x64.
            exe64: exe64.toString('base64'), ver64: md5(exe64),
            exe32: exe32.toString('base64'), ver32: md5(exe32)
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

    // Status to one browser. `code` is a stable identifier the browser can
    // translate; `msg` is the Russian fallback text.
    function sendStatus(sess, nodeid, state, code, msg, extra) {
        var m = { method: 'onStatus', nodeid: nodeid, state: state, code: code || '', msg: msg || '' };
        if (extra) for (var k in extra) m[k] = extra[k];
        sendUser(sess, m);
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

    function stateOf(sess) {
        var s = sessState.get(sess);
        if (!s) { s = { hooked: false, gen: {} }; sessState.set(sess, s); }
        return s;
    }

    function ensureKeepalive() {
        if (keepTimer) return;
        keepTimer = setInterval(function () {
            var ids = Object.keys(streams);
            if (ids.length === 0) { clearInterval(keepTimer); keepTimer = null; return; }
            ids.forEach(function (nodeid) {
                var agent = agentOf(nodeid);
                if (!agent) { endStream(nodeid, 'stopped', 'agent_offline', 'Агент отключился'); return; }
                sendAgent(agent, { pluginaction: 'keepalive', sid: streams[nodeid].sid });
            });
        }, KEEPALIVE_MS);
        if (keepTimer.unref) keepTimer.unref();
    }

    function endStream(nodeid, state, code, msg) {
        var st = streams[nodeid];
        delete streams[nodeid];
        if (!st) return;
        st.listeners.forEach(function (s) { sendStatus(s, nodeid, state, code, msg); });
        Object.keys(st.pending).forEach(function (r) { sendStatus(st.pending[r], nodeid, state, code, msg); });
    }

    function removeListener(nodeid, sess) {
        var st = streams[nodeid];
        if (!st) return;
        st.listeners = st.listeners.filter(function (s) { return s !== sess; });
        Object.keys(st.pending).forEach(function (r) { if (st.pending[r] === sess) delete st.pending[r]; });
        if (st.listeners.length > 0 || Object.keys(st.pending).length > 0) return;
        delete streams[nodeid];
        var agent = agentOf(nodeid);
        if (agent) sendAgent(agent, { pluginaction: 'stop', sid: st.sid });
    }

    function removeSession(sess) {
        Object.keys(streams).forEach(function (nodeid) { removeListener(nodeid, sess); });
    }

    // Effective user-consent flags for the desktop, combined exactly like
    // MeshCentral's relay does: server-wide | device group | device | user.
    function consentFlags(web, domain, node, user) {
        var c = 0;
        if (domain && typeof domain.userconsentflags === 'number') c |= domain.userconsentflags;
        var mesh = (web && web.meshes) ? web.meshes[node.meshid] : null;
        if (mesh && typeof mesh.consent === 'number') c |= mesh.consent;
        if (typeof node.consent === 'number') c |= node.consent;
        if (user && typeof user.consent === 'number') c |= user.consent;
        return c & (USERCONSENT_DesktopNotifyUser | USERCONSENT_DesktopPromptUser);
    }

    // What the agent needs to ask (or notify) the local user for one listener.
    function consentInfo(flags, domain, user) {
        var cm = (domain && typeof domain.consentmessages === 'object' && domain.consentmessages) || {};
        var who = user.realname || user.name;
        return {
            prompt: (flags & USERCONSENT_DesktopPromptUser) !== 0,
            notify: (flags & USERCONSENT_DesktopNotifyUser) !== 0,
            title: (typeof cm.title === 'string') ? cm.title : 'MeshCentral',
            msg: DEFAULT_CONSENT_MSG.replace(/\{0\}/g, who),
            notifyMsg: DEFAULT_NOTIFY_MSG.replace(/\{0\}/g, who),
            timeout: (typeof cm.consenttimeout === 'number' && cm.consenttimeout > 0) ? cm.consenttimeout : 30,
            autoAcceptNoUser: cm.autoacceptifdesktopnouser === true
        };
    }

    function attach(st, sess) {
        st.listeners.push(sess);
        st.users[sess.user._id] = true;
    }

    // ---------- user (browser) -> server ----------
    function userAction(command, sess, web) {
        var nodeid = command.nodeid;
        if (typeof nodeid !== 'string' || nodeid.indexOf('node/') !== 0) return;
        var ss = stateOf(sess);
        // Every start/stop bumps the per-node generation, so a start whose rights
        // check completes after a later stop (or a newer start) is discarded.
        var gen = ss.gen[nodeid] = (ss.gen[nodeid] || 0) + 1;

        if (command.pluginaction === 'stop') { removeListener(nodeid, sess); return; }
        if (command.pluginaction !== 'start') return;

        var domain = sess.domain || obj.meshServer.config.domains[sess.user.domain];
        web.GetNodeWithRights(domain, sess.user, nodeid, function (node, rights) {
            if (ss.gen[nodeid] !== gen) return;
            if (!node || (rights & MESHRIGHT_REMOTECONTROL) === 0 ||
                (rights !== 0xFFFFFFFF && (rights & MESHRIGHT_NODESKTOP) !== 0))
                return sendStatus(sess, nodeid, 'error', 'no_rights', 'Нет права «удалённое управление» (рабочий стол) на это устройство');
            var agent = agentOf(nodeid);
            if (!agent) return sendStatus(sess, nodeid, 'error', 'offline', 'Устройство не в сети');

            var st = streams[nodeid];
            if (st && (st.listeners.indexOf(sess) >= 0 || Object.keys(st.pending).some(function (r) { return st.pending[r] === sess; }))) return;
            if (st && st.listeners.length + Object.keys(st.pending).length >= MAX_LISTENERS_PER_NODE)
                return sendStatus(sess, nodeid, 'error', 'too_many_listeners', 'Слишком много слушателей');
            // Server-wide cap: a brand-new capture counts against the total number
            // of simultaneous streams.
            if (!st && Object.keys(streams).length >= MAX_TOTAL_STREAMS)
                return sendStatus(sess, nodeid, 'error', 'too_many_streams', 'Сервер: слишком много одновременных аудиопотоков');

            if (!ss.hooked && sess.ws) {
                ss.hooked = true;
                sess.ws.on('close', function () { removeSession(sess); });
            }
            ensureKeepalive();
            logEvent(sess, node, 'Прослушивание звука рабочего стола: начало');
            var consent = consentInfo(consentFlags(web, domain, node, sess.user), domain, sess.user);

            if (st) {
                // Joining a running capture. If the device requires consent, the
                // local user is asked again for this new listener.
                if (consent.prompt && !st.users[sess.user._id]) {
                    var reqid = nextReq++;
                    st.pending[reqid] = sess;
                    sendStatus(sess, nodeid, 'waiting', 'consent_wait', 'Ожидание разрешения пользователя…', { timeout: consent.timeout });
                    sendAgent(agent, { pluginaction: 'consent', sid: st.sid, reqid: reqid, consent: consent });
                    return;
                }
                attach(st, sess);
                if (consent.notify) sendAgent(agent, { pluginaction: 'notify', sid: st.sid, consent: consent });
                return sendStatus(sess, nodeid, 'started', '', '', { rate: st.rate });
            }

            var rate = parseInt(command.rate, 10);
            if ([8000, 16000, 24000].indexOf(rate) < 0) rate = 16000;
            var h;
            try { h = loadHelpers(); } catch (e) { return sendStatus(sess, nodeid, 'error', 'no_helpers', 'Не найдены файлы helpers/ плагина'); }
            st = streams[nodeid] = {
                sid: nextSid++, listeners: [], users: {}, pending: {},
                // With consent required, no audio is relayed until the agent
                // confirms (in 'started') that it understood the consent request.
                consent: consent.prompt || consent.notify, ready: false, rate: rate
            };
            attach(st, sess);
            // Codec negotiation: the browser lists what it can decode
            // (WebCodecs AudioDecoder for opus, else adpcm/pcm always work).
            // The agent confirms what it actually started in its 'started'
            // status, and every chunk carries its codec, so the browser
            // always decodes what it receives.
            var codec = (command.codecs && command.codecs.indexOf('opus') >= 0) ? 'opus' : null;
            var st2 = streams[nodeid];
            st2.codec = codec;
            var bitrate = parseInt(command.bitrate, 10);
            if ([24, 32, 48].indexOf(bitrate) < 0) bitrate = 32;
            sendAgent(agent, {
                pluginaction: 'start', sid: st.sid, rate: rate,
                compress: command.compress !== false, silence: command.silence !== false,
                codec: codec, bitrate: bitrate,
                consent: consent, script: h.script,
                exe64: h.exe64, ver64: h.ver64, exe32: h.exe32, ver32: h.ver32
            });
        });
    }

    // ---------- agent -> server ----------
    function agentAction(command, agent) {
        var nodeid = agent.dbNodeKey;   // taken from the authenticated agent, never from the message
        var st = streams[nodeid];
        var sid = (typeof command.sid === 'number') ? command.sid : null;
        if (st && sid !== null && sid !== st.sid) return;   // stale message from an earlier capture
        if (!st) {
            // No listeners (e.g. the server restarted while the agent was still
            // capturing, or the last listener just left): tell the agent to stop
            // so it does not keep an orphaned capture running.
            if (command.pluginaction === 'chunk' || (command.pluginaction === 'status' && command.state !== 'stopped' && command.state !== 'error')) {
                sendAgent(agent, { pluginaction: 'stop', sid: sid });
            }
            return;
        }
        switch (command.pluginaction) {
            case 'chunk':
                if (typeof command.d !== 'string' || command.d.length > 262144) return;
                if (st.consent && !st.ready) return;
                var rate = parseInt(command.rate, 10);
                if ([8000, 16000, 24000].indexOf(rate) < 0) return;
                var codec = (command.codec === 'adpcm' || command.codec === 'opus') ? command.codec : undefined;
                st.listeners.forEach(function (s) { sendUser(s, { method: 'onChunk', nodeid: nodeid, rate: rate, codec: codec, d: command.d }); });
                break;
            case 'status':
                var state = String(command.state || '');
                var code = String(command.code || '').substring(0, 40);
                var msg = String(command.msg || '').substring(0, 500);
                if (state === 'stopped' || state === 'error') { endStream(nodeid, state, code, msg); break; }
                if (state === 'started') {
                    // An agent core that predates consent support would capture
                    // without asking: refuse it where consent is required.
                    if (st.consent && !command.proto) {
                        sendAgent(agent, { pluginaction: 'stop', sid: sid });
                        endStream(nodeid, 'error', 'agent_outdated', 'На устройстве требуется согласие пользователя, а ядро агента устарело — обновите ядро агента');
                        break;
                    }
                    st.ready = true;
                    if (command.rate) st.rate = command.rate;
                }
                st.listeners.forEach(function (s) { sendStatus(s, nodeid, state, code, msg, { rate: command.rate, timeout: command.timeout }); });
                break;
            case 'consentresult':
                var sess = st.pending[command.reqid];
                if (!sess) return;
                delete st.pending[command.reqid];
                if (command.ok) {
                    attach(st, sess);
                    sendStatus(sess, nodeid, 'started', '', '', { rate: st.rate });
                } else {
                    sendStatus(sess, nodeid, 'error', 'consent_denied', 'Пользователь не разрешил прослушивание');
                    if (st.listeners.length === 0 && Object.keys(st.pending).length === 0) removeListener(nodeid, sess);
                }
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
            '<legend style="opacity:.7;font-size:12px;padding:0 4px">Настройки (применятся при следующем запуске)</legend>' +
            '<div style="margin:5px 0">Кодек: <select id="da_codec" onchange="' + H + '.setCodec(this.value)">' +
            '<option value="auto">Авто — Opus, если браузер умеет</option>' +
            '<option value="opus">Opus — лучшее качество (48 кГц)</option>' +
            '<option value="adpcm">ADPCM — совместимость</option>' +
            '<option value="pcm">PCM без сжатия</option></select>' +
            ' <span id="da_br" style="opacity:.6;font-size:11px">битрейт: <select id="da_bitrate" onchange="' + H + '.setBitrate(this.value)">' +
            '<option value="24">24 кбит/с</option><option value="32">32 кбит/с</option><option value="48">48 кбит/с</option></select></span></div>' +
            '<div id="da_rate_row" style="margin:5px 0">Частота (для ADPCM/PCM): <select id="da_rate" onchange="' + H + '.setRate(this.value)">' +
            '<option value="8000">8 кГц — экономно</option>' +
            '<option value="16000">16 кГц — речь</option>' +
            '<option value="24000">24 кГц — лучше</option></select></div>' +
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
        setSel('da_codec', pref('codec', 'auto'));
        setSel('da_bitrate', pref('bitrate', '32'));
        var prefC = pref('codec', 'auto');
        var bri = document.getElementById('da_br');
        if (bri) bri.style.display = (prefC === 'opus') ? '' : 'none';
        var rr = document.getElementById('da_rate_row');
        if (rr) rr.style.display = (prefC === 'opus') ? 'none' : '';
        setSel('da_buffer', pref('buffer', 'med'));
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
                // The same button also disconnects: only start if, after MeshCentral
                // handled the click, a desktop session is actually connecting/connected.
                if (auto && !s2.active) setTimeout(function () {
                    if (typeof desktop === 'undefined' || desktop == null || !desktop.State) return;
                    if ((pluginHandler.deskaudio._s || {}).active) return;
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

    // Which codecs this browser can decode. Opus via WebCodecs AudioDecoder
    // (probe once and cache; the probe is async, so the first start falls
    // back to adpcm/pcm and later starts can use opus), plus the always-
    // available software paths.
    obj.probeCodecs = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.codecCache) return s.codecCache;
        var list = ['adpcm', 'pcm'];
        try {
            if (typeof AudioDecoder !== 'undefined' && AudioDecoder.isConfigSupported) {
                AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })
                    .then(function (r) {
                        if (r && r.supported) {
                            s.codecCache = ['opus', 'adpcm', 'pcm'];
                            // remember for the next start; the current one
                            // already went out with adpcm-level support
                        }
                    }).catch(function () { });
            }
        } catch (e) { }
        return list;
    }

    obj.start = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.active || typeof currentNode === 'undefined' || !currentNode) return;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { s.statusText = 'Браузер не поддерживает Web Audio'; P.render(); return; }
        // The AudioContext is created lazily in _ensureCtx() on the first
        // chunk, once the agent's actual sample rate is known: new AC({sampleRate})
        // then makes the browser run at the agent's rate, so chunks are never
        // resampled individually (the per-chunk resampling is what clicked at
        // chunk boundaries).
        var v = document.getElementById('da_vol');
        s.vol = v ? (v.value / 100) : 0.8;
        s.next = 0;
        s.pending = [];
        s.workletReady = false;
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
        var compress = (g('compress', null) !== '0');   // legacy key; codec='pcm' forces raw anyway
        var silence = (g('silence', '1') !== '0');
        var jit = { low: 0.08, med: 0.15, high: 0.30 }[g('buffer', 'med')] || 0.15;
        s.jitter = jit;
        var pref2 = g('codec', 'auto');
        var adv = P.probeCodecs();
        if (pref2 === 'opus') { adv = ['opus']; }
        else if (pref2 === 'adpcm') { adv = ['adpcm']; }
        else if (pref2 === 'pcm') { adv = ['pcm']; }
        s.codecs = adv;
        var br = parseInt(g('bitrate', '32'), 10);
        meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'start', nodeid: s.nodeid, rate: rate, compress: compress, silence: silence, codecs: s.codecs, bitrate: br });
        P.render();
    };

    obj.stop = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
        if (s.nodeid) meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'stop', nodeid: s.nodeid });
        try { if (s.node) { s.node.disconnect(); s.node.port.onmessage = null; } } catch (e) { }
        try { if (s.workletUrl) URL.revokeObjectURL(s.workletUrl); } catch (e) { }
        try { if (s.ctx) s.ctx.close(); } catch (e) { }
        s.node = null; s.workletUrl = null; s.pending = null; s.workletReady = false;
        s.ctx = null; s.gain = null; s.active = false; s.statusText = 'Остановлено';
        P.render();
    };

    obj.setVolume = function (val) {
        var s = pluginHandler.deskaudio._s || {};
        s.vol = val / 100;
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
    obj.setCodec = function (v) {
        try { localStorage.setItem('deskaudio_codec', String(v)); } catch (e) { }
        var bri = document.getElementById('da_br');
        if (bri) bri.style.display = (v === 'opus') ? '' : 'none';
        var rr = document.getElementById('da_rate_row');
        if (rr) rr.style.display = (v === 'opus') ? 'none' : '';   // opus is always 48 kHz
    };
    obj.setBitrate = function (v) { try { localStorage.setItem('deskaudio_bitrate', String(v)); } catch (e) { } };
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
        else if (m.state === 'waiting') {
            // The local user is being asked for consent: wait for their answer
            // (plus a margin) instead of the usual connect timeout.
            s.statusText = 'Ожидание разрешения пользователя…';
            var wt = ((m.timeout > 0 ? m.timeout : 30) + 10) * 1000;
            s.connectTimer = setTimeout(function () {
                var Pt = pluginHandler.deskaudio, st2 = Pt._s || {};
                if (st2.active && !st2.gotAudio) { Pt.stop(); st2.statusText = 'Нет ответа от агента'; Pt.render(); }
            }, wt);
        }
        else if (m.state === 'error' || m.state === 'stopped') {
            try { if (s.ctx) s.ctx.close(); } catch (e) { }
            s.ctx = null; s.gain = null; s.active = false;
            s.statusText = (m.state === 'error' ? 'Ошибка: ' : 'Остановлено. ') + (m.msg || '');
        }
        P.render();
    };

    // ---- Ring buffer (pure functions; the worklet mirrors this logic) ----
    // One producer (network chunks) and one consumer (the audio thread) at a
    // fixed sample rate. `buf` is a Float32Array used as a circular queue.
    // Drift: when the consumer runs dry it repeats the last sample (keeps the
    // stream continuous when the agent is marginally slower); overflow drops
    // the oldest samples (never the newest).
    obj._ringNew = function (capacitySamples) {
        return { buf: new Float32Array(capacitySamples), cap: capacitySamples, r: 0, w: 0, used: 0, last: 0 };
    };

    // Push floats onto the ring. If they do not fit, the OLDEST samples are
    // overwritten. Returns the number of samples dropped.
    obj._ringPush = function (ring, samples) {
        var dropped = 0;
        for (var i = 0; i < samples.length; i++) {
            if (ring.used === ring.cap) {           // full: drop the oldest
                ring.r = (ring.r + 1) % ring.cap; ring.used--;
                dropped++;
            }
            ring.buf[ring.w] = samples[i];
            ring.w = (ring.w + 1) % ring.cap; ring.used++;
        }
        return dropped;
    };

    // Pull up to `n` samples; returns a Float32Array (possibly shorter).
    function ringPull(ring, n) {
        var take = Math.min(n, ring.used);
        var out = new Float32Array(take);
        for (var i = 0; i < take; i++) { out[i] = ring.buf[ring.r]; ring.r = (ring.r + 1) % ring.cap; }
        ring.used -= take;
        return out;
    }

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

    // Create the AudioContext at the agent's actual rate on the first chunk,
    // then wire up the worklet (or the fallback scheduler). The rate is known
    // only here, not in start(). Exported: serialized browser code (onChunk)
    // calls it via pluginHandler.deskaudio._ensureCtx.
    obj._ensureCtx = function (s, rate) {
        if (s.ctx) return;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        // 7a: ask for the agent's rate. If the browser refuses (or silently
        // clamps to its hardware rate), fall back to the default context —
        // the browser then resamples each createBuffer() internally, which is
        // the old behavior, still click-free at chunk boundaries because the
        // fallback scheduler is sample-continuous.
        try {
            s.ctx = new AC({ sampleRate: rate });
            if (s.ctx.sampleRate && Math.abs(s.ctx.sampleRate - rate) > 1) {
                try { s.ctx.close(); } catch (e) { }
                s.ctx = null;
            }
        } catch (e) { s.ctx = null; }
        if (!s.ctx) { try { s.ctx = new AC(); } catch (e) { return; } }
        if (s.ctx.resume) s.ctx.resume();       // allowed: a user gesture started this
        s.gain = s.ctx.createGain();
        s.gain.gain.value = (s.vol !== undefined) ? s.vol : 0.8;
        s.gain.connect(s.ctx.destination);

        // 7b: AudioWorklet + ring buffer — seamless chunk boundaries and
        // clock-drift absorption. Blob URL because the plugin cannot serve
        // its own files.
        var cap = Math.max(128, Math.round((s.jitter || 0.15) * rate * 4));   // ~4x the jitter buffer
        var code = ("class DeskAudioProcessor extends AudioWorkletProcessor {" +
        "  constructor() {" +
        "    super();" +
        "    this.ring = new Float32Array(RCAP);" +
        "    this.r = 0; this.w = 0; this.used = 0; this.last = 0; this.fill = 0;" +
        "    this.port.onmessage = (e) => {" +
        "      const d = e.data;" +
        "      if (d.cmd === 'push') { const s = d.s;" +
        "        for (let i = 0; i < s.length; i++) {" +
        "          if (this.used === RCAP) { this.r = (this.r + 1) % RCAP; this.used--; }" +
        "          this.ring[this.w] = s[i]; this.w = (this.w + 1) % RCAP; this.used++;" +
        "        }" +
        "        this.fill = this.used / RCAP;" +
        "        this.port.postMessage({ fill: this.fill });" +
        "      }" +
        "    };" +
        "  }" +
        "  process(inputs, outputs) {" +
        "    const out = outputs[0][0];" +
        "    for (let i = 0; i < out.length; i++) {" +
        "      if (this.used > 0) {" +
        "        out[i] = this.ring[this.r]; this.last = out[i];" +
        "        this.r = (this.r + 1) % RCAP; this.used--;" +
        "      } else { out[i] = this.last; }" +
        "    }" +
        "    this.fill = this.used / RCAP;" +
        "    return true;" +
        "  }" +
        "}" +
        "registerProcessor('deskaudio-processor', DeskAudioProcessor);").replace(/RCAP/g, String(cap));
        if (!s.pending) s.pending = [];
        if (s.ctx.audioWorklet && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
            try {
                var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
                s.workletUrl = url;
                s.ctx.audioWorklet.addModule(url).then(function () {
                    if (!s.ctx) return;
                    s.node = new AudioWorkletNode(s.ctx, 'deskaudio-processor');
                    s.node.port.onmessage = function (e) { if (s.node && e.data && e.data.fill !== undefined) s.fill = e.data.fill; };
                    s.node.connect(s.gain);
                    s.workletReady = true;
                    // Audio decoded before the module finished loading: flush it.
                    if (s.pending && s.pending.length) {
                        for (var i = 0; i < s.pending.length; i++) {
                            var cp = Float32Array.from(s.pending[i]);
                            s.node.port.postMessage({ cmd: 'push', s: cp });
                        }
                    }
                    s.pending = null;
                }).catch(function () { s.workletReady = false; s.pending = null; });
            } catch (e) { s.workletReady = false; s.pending = null; }
        } else {
            s.workletReady = false;
            s.pending = null;
        }
        s.next = 0;
    }

    // Opus decode path: WebCodecs AudioDecoder. The frame payload is
    // [dur:2 LE][opus packet]; decoded 48 kHz mono PCM goes into the same
    // worklet ring buffer as ADPCM/PCM (the worklet is rate-agnostic - it
    // just plays what arrives at the context's rate).
    obj._ensureOpusDecoder = function (s) {
        if (s.opusDec || s.opusDecFailed) return s.opusDec;
        try {
            if (typeof AudioDecoder === 'undefined') { s.opusDecFailed = true; return null; }
            s.opusChunks = [];
            s.opusDec = new AudioDecoder({
                output: function (frame) {
                    // f32-planar mono is what our configure() requests; copy
                    // plane 0 and push it into the ring.
                    var st = (pluginHandler.deskaudio._s || {});
                    try {
                        var plane = new Float32Array(frame.allocationSize({ planeIndex: 0, format: 'f32-planar' }));
                        frame.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
                        pluginHandler.deskaudio._pushDecoded(st, plane, 48000);
                    } catch (e) { }
                    try { frame.close(); } catch (e) { }
                },
                error: function (e) {
                    var P = pluginHandler.deskaudio, st = P._s || {};
                    st.opusDecFailed = true;
                    try { if (st.opusDec) st.opusDec.close(); } catch (e2) { }
                    st.opusDec = null;
                    // The stream keeps flowing: the agent is asked (via the
                    // next start) to fall back... for now, stop cleanly.
                    try { P.stop(); } catch (e2) { }
                }
            });
            s.opusDec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
        } catch (e) { s.opusDecFailed = true; return null; }
        return s.opusDec;
    }

    // Decoded PCM from any codec goes to the worklet ring (or the fallback
    // scheduler) at its own rate.
    obj._pushDecoded = function (s, f32, rate) {
        var sum = 0;
        for (var i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
        if (!s.gotAudio) {
            s.gotAudio = true;
            if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
            s.statusText = 'Идёт передача звука (Opus 48 кГц)';
            pluginHandler.deskaudio.render();
        }
        if (s.workletReady && s.node) {
            var cp = Float32Array.from(f32);
            s.node.port.postMessage({ cmd: 'push', s: cp }, [cp.buffer]);
        } else if (s.ctx.audioWorklet && s.pending !== null) {
            if (!s.pending) s.pending = [];
            s.pending.push(f32);
        } else {
            var jit = s.jitter || 0.15;
            var ctx = s.ctx, now = ctx.currentTime;
            if (s.next - now > jit * 2 + 0.45) return;
            var buf = ctx.createBuffer(1, f32.length, rate);
            buf.copyToChannel(f32, 0);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(s.gain);
            if (s.next < now + 0.02) s.next = now + jit;
            src.start(s.next);
            s.next += buf.duration;
        }
        var bar = document.getElementById('da_bar');
        if (bar) bar.style.width = Math.min(100, Math.round(Math.sqrt(sum / f32.length) * 300)) + '%';
    }

    // One opus chunk from the agent: [dur:2][packet] -> AudioDecoder.
    obj._opusChunk = function (s, bin) {
        var dec = pluginHandler.deskaudio._ensureOpusDecoder(s);
        if (!dec) {
            // Opus was negotiated but this browser cannot decode it (no
            // WebCodecs): say so instead of hanging on "Подключение…".
            s.active = false;
            s.statusText = 'Браузер не поддерживает декодирование Opus — выберите ADPCM в настройках';
            pluginHandler.deskaudio.render();
            return;
        }
        if (bin.length < 2) return;
        var dur = bin.charCodeAt(0) | (bin.charCodeAt(1) << 8);
        var pkt = bin.substring(2);
        if (dur <= 0 || pkt.length === 0) return;
        var u8 = new Uint8Array(pkt.length);
        for (var i = 0; i < pkt.length; i++) u8[i] = pkt.charCodeAt(i) & 0xFF;
        // Opus packets are not AudioData (that is a PCM container): they go
        // in as EncodedAudioChunk. timestamp must be monotonically increasing
        // (in microseconds), or decoders drop or reorder the chunks.
        if (s.opusTs === undefined) s.opusTs = 0;
        try {
            dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.opusTs, duration: dur * 1000000 / 48000, data: u8 }));
            s.opusTs += dur * 1000000 / 48000;
        } catch (e) { }
    }

    obj.onChunk = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;
        var s = (pluginHandler.deskaudio._s || {});
        if (!s.active || !m || m.nodeid !== s.nodeid || typeof m.d !== 'string') return;
        var rate = m.rate || 16000;
        if (m.codec === 'opus') rate = 48000;    // opus packets are 48 kHz native
        pluginHandler.deskaudio._ensureCtx(s, rate);
        if (!s.ctx) return;
        var bin = atob(m.d);
        var f, sum = 0, i;
        if (m.codec === 'opus') { pluginHandler.deskaudio._opusChunk(s, bin); return; }
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
        if (!s.gotAudio) {
            s.gotAudio = true;
            if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
            s.statusText = 'Идёт передача звука (' + (rate / 1000) + ' кГц)';
            pluginHandler.deskaudio.render();
        }

        if (s.workletReady && s.node) {
            // Seamless path: push into the worklet's ring buffer.
            var cp = Float32Array.from(f);   // copy: the posted buffer may be transferred
            s.node.port.postMessage({ cmd: 'push', s: cp }, [cp.buffer]);
        } else if (s.ctx.audioWorklet && s.pending !== null) {
            // Module still loading: hold the decoded audio until it is ready.
            s.pending.push(f);
        } else {
            // Fallback (old scheduler) when AudioWorklet is unavailable.
            var jit = s.jitter || 0.15;
            var ctx = s.ctx, now = ctx.currentTime;
            if (s.next - now > jit * 2 + 0.45) return;   // too far behind real time: drop
            var buf = ctx.createBuffer(1, n, rate);
            buf.copyToChannel(f, 0);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(s.gain);
            if (s.next < now + 0.02) s.next = now + jit;
            src.start(s.next);
            s.next += buf.duration;
        }
        var bar = document.getElementById('da_bar');
        if (bar) bar.style.width = Math.min(100, Math.round(Math.sqrt(sum / n) * 300)) + '%';
    };

    return obj;
};
