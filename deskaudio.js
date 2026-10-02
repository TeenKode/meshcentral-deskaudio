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
    obj.exports = ['onDeviceRefreshEnd', 'render', 'toggle', 'start', 'stop', 'setVolume', 'setAuto', 'setRate', 'setCodec', 'setBitrate', 'setSilence', 'setBuffer', 'onChunk', 'onStatus', 'onDesktopDisconnect', '_adpcmDecode', '_playerCore', 'probeCodecs', '_params', '_apply', '_ensureCtx', '_ensureOpusDecoder', '_pushDecoded', '_opusChunk', '_teardown', 'log', 'onLog', 'copyLog', 'clearLog', 'toggleLog', '_stats', '_t', '_statusText'];

    var fs = require('fs');
    var path = require('path');
    var crypto = require('crypto');

    var MESHRIGHT_REMOTECONTROL = 0x00000008;
    var MESHRIGHT_NODESKTOP = 0x00010000;
    var USERCONSENT_DesktopNotifyUser = 1;
    var USERCONSENT_DesktopPromptUser = 8;
    var MAX_LISTENERS_PER_NODE = 10;
    var MAX_TOTAL_STREAMS = 50;   // server-wide cap on simultaneously captured devices

    // Optional settings in MeshCentral's config.json:
    //   "settings": { "plugins": { "enabled": true,
    //     "deskaudio": { "maxListenersPerNode": 10, "maxStreams": 50, "spawnAsUser": false,
    //                    "consentMessage": "...{0}...", "notifyMessage": "...{0}..." } } }
    // MeshCentral lower-cases config keys on load, so keys are matched
    // case-insensitively. Read on every use: no restart needed after a reload.
    function settings() {
        var out = {};
        try {
            var p = obj.meshServer.config.settings.plugins, d = null;
            for (var k in p) if (k.toLowerCase() === 'deskaudio') d = p[k];
            if (d && typeof d === 'object') for (var j in d) out[j.toLowerCase()] = d[j];
        } catch (e) { }
        return out;
    }
    function intSetting(v, def, min, max) {
        v = parseInt(v, 10);
        return (isNaN(v) || v < min || v > max) ? def : v;
    }
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
    // agent connection -> protocol version it reported. From 3 on, the agent
    // keeps the helper and asks for it only when its copy is missing or stale
    // ('need'), so a start no longer carries ~1 MB of helper bytes. A reconnect
    // is a new connection object, so an updated (or downgraded) core is
    // re-learned on its first start.
    var agentProto = new WeakMap();
    var keepTimer = null;
    var helperCache = null;

    // ---------- helpers ----------
    function log(msg) { try { obj.meshServer.debug('deskaudio: ' + msg); } catch (e) { } }

    function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex').substring(0, 8); }

    // Set one Windows helper build in the cache: bytes (base64) plus the
    // identity an agent checks its local copy against (SHA-384 and size).
    // `key` is 'exe64' or 'exe32'.
    function setExe(h, key, buf) {
        var arch = (key === 'exe64') ? '64' : '32';
        h[key] = buf.toString('base64');
        h['ver' + arch] = md5(buf);
        h['sha' + arch] = crypto.createHash('sha384').update(buf).digest('hex');
        h['size' + arch] = buf.length;
    }

    function loadHelpers() {
        if (helperCache) return helperCache;
        var sh = fs.readFileSync(path.join(__dirname, 'helpers', 'linux-capture.sh'));
        var exe64 = fs.readFileSync(path.join(__dirname, 'helpers', 'deskaudio-x64.exe'));
        var exe32 = fs.readFileSync(path.join(__dirname, 'helpers', 'deskaudio-x86.exe'));
        // Windows: prebuilt native helpers (no .NET required). 32-bit build runs
        // on 32- and 64-bit Windows; 64-bit build runs natively on x64.
        helperCache = { script: sh.toString('base64') };
        setExe(helperCache, 'exe64', exe64);
        setExe(helperCache, 'exe32', exe32);
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
                    setExe(h, f[1], cached);
                    return;
                }
                var hnd = authenticode.createAuthenticodeHandler(inPath);
                if (!hnd) return;
                hnd.sign(certInfo, { hash: 'sha384', out: outPath, desc: 'Desktop Audio helper' }, function (err) {
                    try {
                        if (!err) {
                            var signed = fs.readFileSync(outPath);
                            setExe(h, f[1], signed);
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
        st.listeners.forEach(function (s) { logEnd(st, s, msg || code); sendStatus(s, nodeid, state, code, msg); });
        Object.keys(st.pending).forEach(function (r) { sendStatus(st.pending[r], nodeid, state, code, msg); });
    }

    function removeListener(nodeid, sess) {
        var st = streams[nodeid];
        if (!st) return;
        logEnd(st, sess);
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
        var cfg = settings();
        var cmsg = (typeof cfg.consentmessage === 'string' && cfg.consentmessage) ? cfg.consentmessage : DEFAULT_CONSENT_MSG;
        var nmsg = (typeof cfg.notifymessage === 'string' && cfg.notifymessage) ? cfg.notifymessage : DEFAULT_NOTIFY_MSG;
        return {
            prompt: (flags & USERCONSENT_DesktopPromptUser) !== 0,
            notify: (flags & USERCONSENT_DesktopNotifyUser) !== 0,
            title: (typeof cm.title === 'string') ? cm.title : 'MeshCentral',
            msg: cmsg.replace(/\{0\}/g, who),
            notifyMsg: nmsg.replace(/\{0\}/g, who),
            timeout: (typeof cm.consenttimeout === 'number' && cm.consenttimeout > 0) ? cm.consenttimeout : 30,
            autoAcceptNoUser: cm.autoacceptifdesktopnouser === true
        };
    }

    function attach(st, sess) {
        st.listeners.push(sess);
        st.users[sess.user._id] = true;
        st.since.set(sess, Date.now());
    }

    // Device event log: the end of a listener's session, with its duration.
    function logEnd(st, sess, why) {
        var t0 = st.since.get(sess);
        if (t0 === undefined) return;
        st.since.delete(sess);
        var sec = Math.round((Date.now() - t0) / 1000);
        var dur = (sec >= 60 ? Math.floor(sec / 60) + ' мин ' : '') + (sec % 60) + ' с';
        logEvent(sess, st.node, 'Прослушивание звука рабочего стола: конец, ' + dur + (why ? ' (' + why + ')' : ''));
    }

    // Tell the agent to (re)start capturing for stream `st` with the browser's
    // requested parameters. Used for a new stream and for a live change of
    // settings (reconfigure); a new sid makes any message of the previous
    // capture stale.
    function startAgent(agent, st, command, consent, h) {
        var rate = parseInt(command.rate, 10);
        if ([8000, 16000, 24000].indexOf(rate) < 0) rate = 16000;
        st.rate = rate;
        st.ready = false;
        // Codec negotiation: the browser lists what it can decode (opus via
        // WebCodecs; adpcm/pcm always). The agent confirms what it actually
        // started in its 'started' status, and every chunk carries its
        // codec, so the browser always decodes what it receives.
        var codecs = Array.isArray(command.codecs) ? command.codecs : null;
        st.codec = (codecs && codecs.indexOf('opus') >= 0) ? 'opus' : null;
        // An explicit ['pcm'] means uncompressed, whatever `compress` says.
        var compress = command.compress !== false &&
            !(codecs && codecs.indexOf('pcm') >= 0 && codecs.indexOf('adpcm') < 0 && codecs.indexOf('opus') < 0);
        var bitrate = parseInt(command.bitrate, 10);
        if ([24, 32, 48].indexOf(bitrate) < 0) bitrate = 32;
        var startMsg = {
            pluginaction: 'start', sid: st.sid, rate: rate,
            compress: compress, silence: command.silence !== false,
            codec: st.codec, bitrate: bitrate,
            consent: consent, script: h.script, spawnAsUser: settings().spawnasuser === true,
            helper: { x64: { sha: h.sha64, size: h.size64 }, x86: { sha: h.sha32, size: h.size32 } }
        };
        // An agent not yet known to fetch helpers on demand gets the bytes.
        if (!(agentProto.get(agent) >= 3)) {
            startMsg.exe64 = h.exe64; startMsg.ver64 = h.ver64;
            startMsg.exe32 = h.exe32; startMsg.ver32 = h.ver32;
        }
        sendAgent(agent, startMsg);
    }

    // Live change of codec / rate / bitrate / silence by a listener. Only the
    // sole listener of a stream may change it (it is shared); the capture is
    // restarted on the agent with a new sid while the listener stays attached.
    // Consent was already given for this user, so it is not asked again.
    function reconfigure(nodeid, sess, command) {
        var st = streams[nodeid];
        if (!st || st.listeners.indexOf(sess) < 0) return;
        if (st.listeners.length > 1 || Object.keys(st.pending).length > 0)
            return sendStatus(sess, nodeid, 'info', 'shared_stream', 'Звук этого устройства слушают и другие — параметры общего потока не изменены');
        var agent = agentOf(nodeid);
        if (!agent) return;
        var h;
        try { h = loadHelpers(); } catch (e) { return; }
        st.sid = nextSid++;
        st.consent = false;
        startAgent(agent, st, command, { prompt: false, notify: false }, h);
        sendStatus(sess, nodeid, 'info', 'reconfigured', 'Параметры изменены');
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
        if (command.pluginaction === 'reconfigure') { reconfigure(nodeid, sess, command); return; }
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
            var cfg = settings();
            if (st && st.listeners.length + Object.keys(st.pending).length >= intSetting(cfg.maxlistenerspernode, MAX_LISTENERS_PER_NODE, 1, 100))
                return sendStatus(sess, nodeid, 'error', 'too_many_listeners', 'Слишком много слушателей');
            // Server-wide cap: a brand-new capture counts against the total number
            // of simultaneous streams.
            if (!st && Object.keys(streams).length >= intSetting(cfg.maxstreams, MAX_TOTAL_STREAMS, 1, 10000))
                return sendStatus(sess, nodeid, 'error', 'too_many_streams', 'Сервер: слишком много одновременных аудиопотоков');

            if (!ss.hooked && sess.ws) {
                ss.hooked = true;
                sess.ws.on('close', function () { removeSession(sess); });
            }
            ensureKeepalive();
            logEvent(sess, node, 'Прослушивание звука рабочего стола: начало');
            var consent = consentInfo(consentFlags(web, domain, node, sess.user), domain, sess.user);

            if (st && st.codec === 'opus' && Array.isArray(command.codecs) && command.codecs.indexOf('opus') < 0)
                return sendStatus(sess, nodeid, 'error', 'codec_mismatch', 'Звук этого устройства уже передаётся в Opus, а этот браузер (или выбранный кодек) его не поддерживает');

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
                sid: nextSid++, listeners: [], users: {}, pending: {}, since: new Map(),
                node: { _id: node._id, meshid: node.meshid, domain: node.domain },
                // With consent required, no audio is relayed until the agent
                // confirms (in 'started') that it understood the consent request.
                consent: consent.prompt || consent.notify, ready: false, rate: rate
            };
            attach(st, sess);
            startAgent(agent, st, command, consent, h);
        });
    }

    // ---------- agent -> server ----------
    function agentAction(command, agent) {
        var nodeid = agent.dbNodeKey;   // taken from the authenticated agent, never from the message
        if (typeof command.proto === 'number') agentProto.set(agent, command.proto);
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
                var codec = (command.codec === 'adpcm' || command.codec === 'opus' || command.codec === 'opus2') ? command.codec : undefined;
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
                    if (command.codec) st.codec = (command.codec === 'opus') ? 'opus' : null;   // what the agent really runs
                }
                st.listeners.forEach(function (s) { sendStatus(s, nodeid, state, code, msg, { rate: command.rate, timeout: command.timeout }); });
                break;
            case 'need':
                // The agent has no (or a stale) copy of the helper: send it once.
                var hh;
                try { hh = loadHelpers(); } catch (e) { return; }
                var arch = (command.arch === 'x64') ? 'x64' : 'x86';
                sendAgent(agent, { pluginaction: 'helper', sid: st.sid, arch: arch,
                                   data: (arch === 'x64') ? hh.exe64 : hh.exe32, sha: (arch === 'x64') ? hh.sha64 : hh.sha32 });
                break;
            case 'log':
                var line = String(command.msg || '').substring(0, 300);
                if (line) st.listeners.forEach(function (s) { sendUser(s, { method: 'onLog', nodeid: nodeid, msg: line }); });
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

    // ---- Interface language -------------------------------------------
    // Russian or English, following MeshCentral's page language (<html lang>),
    // else the browser's. _t(key, a, b, ...) fills {0}, {1}, ... Server and
    // agent errors carry a stable code that is translated here (code_<code>);
    // their Russian text is only the fallback for an unknown code.
    obj._t = function (key) {
        var P = (typeof pluginHandler !== 'undefined' && pluginHandler.deskaudio) || {};
        if (!P._langCache) {
            var l = '';
            try { l = (document.documentElement && document.documentElement.lang) || ''; } catch (e) { }
            if (!l) try { l = navigator.language || ''; } catch (e) { }
            P._langCache = (!l || /^ru|^uk|^be/i.test(l)) ? 'ru' : 'en';
        }
        var D = {
            tab: ['Звук', 'Audio'],
            title: ['Звук рабочего стола', 'Desktop audio'],
            intro: ['Передаётся то, что воспроизводится на динамики удалённого компьютера. Нужно право «удалённое управление». Действие записывается в журнал событий устройства.',
                    'Streams what plays on the remote computer\'s speakers. Requires the "remote control" right. Every session is recorded in the device event log.'],
            listen: ['Слушать', 'Listen'], stop: ['Остановить', 'Stop'], volume: ['Громкость', 'Volume'],
            settings: ['Настройки', 'Settings'], codec: ['Кодек:', 'Codec:'],
            codec_auto: ['Авто — Opus, если браузер умеет', 'Auto — Opus if the browser supports it'],
            codec_opus: ['Opus — лучшее качество (48 кГц)', 'Opus — best quality (48 kHz)'],
            codec_adpcm: ['ADPCM — совместимость', 'ADPCM — compatibility'],
            codec_pcm: ['PCM без сжатия', 'PCM, uncompressed'],
            bitrate: ['битрейт:', 'bitrate:'], kbps: ['{0} кбит/с', '{0} kbit/s'], khz: ['{0} кГц', '{0} kHz'],
            rate: ['Частота (для ADPCM/PCM):', 'Sample rate (ADPCM/PCM):'],
            rate8: ['8 кГц — экономно', '8 kHz — economical'], rate16: ['16 кГц — речь', '16 kHz — speech'],
            rate24: ['24 кГц — лучше', '24 kHz — better'],
            silence: ['Не передавать тишину (экономит трафик, когда ничего не играет)', 'Don\'t send silence (saves traffic while nothing plays)'],
            buffer: ['Буфер / задержка:', 'Buffer / latency:'],
            buf_low: ['Низкий — меньше задержка', 'Low — less latency'], buf_med: ['Средний', 'Medium'],
            buf_high: ['Высокий — стабильнее при рывках', 'High — steadier on a jittery network'],
            auto: ['Слушать звук при подключении к рабочему столу', 'Listen when connecting to the desktop'],
            log: ['Журнал', 'Log'], copy: ['Копировать', 'Copy'], clear: ['Очистить', 'Clear'],
            desk_btn: ['Звук', 'Audio'], desk_btn_stop: ['Стоп звук', 'Stop audio'],
            desk_title: ['Слушать звук рабочего стола', 'Listen to the desktop audio'],
            desk_ind: ['Идёт прослушивание звука рабочего стола', 'Desktop audio is being listened to'],
            st_no_webaudio: ['Браузер не поддерживает Web Audio', 'This browser does not support Web Audio'],
            st_no_opus: ['Браузер не поддерживает декодирование Opus — выберите ADPCM в настройках', 'This browser cannot decode Opus — choose ADPCM in the settings'],
            st_opus_err: ['Ошибка декодирования Opus — выберите ADPCM в настройках', 'Opus decoding failed — choose ADPCM in the settings'],
            st_connecting: ['Подключение…', 'Connecting…'], st_no_answer: ['Нет ответа от агента', 'No answer from the agent'],
            st_stopped: ['Остановлено', 'Stopped'], st_streaming: ['Идёт передача звука', 'Receiving audio'],
            st_waiting: ['Ожидание разрешения пользователя…', 'Waiting for the user\'s permission…'],
            st_error: ['Ошибка: {0}', 'Error: {0}'], st_stopped_why: ['Остановлено. {0}', 'Stopped. {0}'],
            code_no_rights: ['Нет права «удалённое управление» (рабочий стол) на это устройство', 'No "remote control" (desktop) right on this device'],
            code_offline: ['Устройство не в сети', 'The device is offline'],
            code_too_many_listeners: ['Слишком много слушателей', 'Too many listeners'],
            code_too_many_streams: ['Сервер: слишком много одновременных аудиопотоков', 'Server: too many simultaneous audio streams'],
            code_no_helpers: ['Не найдены файлы helpers/ плагина', 'The plugin\'s helpers/ files are missing'],
            code_agent_offline: ['Агент отключился', 'The agent disconnected'],
            code_consent_denied: ['Пользователь не разрешил прослушивание', 'The user did not allow listening'],
            code_agent_outdated: ['На устройстве требуется согласие пользователя, а ядро агента устарело — обновите ядро агента', 'This device requires user consent, but its agent core is outdated — update the agent core'],
            code_codec_mismatch: ['Звук этого устройства уже передаётся в Opus, а этот браузер (или выбранный кодек) его не поддерживает', 'This device\'s audio is already streamed as Opus, which this browser (or the chosen codec) does not support'],
            code_shared_stream: ['Звук этого устройства слушают и другие — параметры общего потока не изменены', 'Others are listening to this device too — the shared stream was not changed'],
            code_reconfigured: ['Параметры изменены', 'Settings applied'],
            code_helper_write: ['Не удалось записать хелпер в папку агента', 'Cannot write the helper into the agent folder'],
            code_unsupported: ['Платформа не поддерживается', 'This platform is not supported'],
            l_start: ['старт: {0}, кодек «{1}», {2} кГц, буфер {3} мс, {4}', 'start: {0}, codec "{1}", {2} kHz, buffer {3} ms, {4}'],
            l_reconf: ['изменение настроек на лету: кодек «{0}», {1} кГц, {2}', 'live settings change: codec "{0}", {1} kHz, {2}'],
            l_sil_on: ['тишина не передаётся', 'silence not sent'], l_sil_off: ['тишина передаётся', 'silence sent'],
            l_opus_br: [', Opus {0} кбит/с', ', Opus {0} kbit/s'],
            l_codecs: ['браузер умеет: {0} — запрос отправлен', 'browser decodes: {0} — request sent'],
            l_stopped: ['остановлено', 'stopped'], l_status: ['статус: {0}', 'status: {0}'],
            l_codec: [', кодек {0}', ', codec {0}'],
            l_ctx: ['AudioContext: {0} Гц (запрошено {1})', 'AudioContext: {0} Hz (requested {1})'],
            l_ctx_err: ['ошибка: не удалось создать AudioContext: {0}', 'error: cannot create an AudioContext: {0}'],
            l_worklet: ['плеер: AudioWorklet (джиттер-буфер {0} мс)', 'player: AudioWorklet (jitter buffer {0} ms)'],
            l_worklet_fail: ['плеер: AudioWorklet не загрузился ({0}) — простой планировщик', 'player: AudioWorklet failed to load ({0}) — simple scheduler'],
            l_worklet_none: ['плеер: AudioWorklet недоступен — простой планировщик', 'player: no AudioWorklet — simple scheduler'],
            l_first: ['первый звук: {0}, {1} Гц', 'first audio: {0}, {1} Hz'],
            l_opus_err: ['ошибка декодера Opus: {0}', 'Opus decoder error: {0}'],
            l_no_webcodecs: ['ошибка: пришёл Opus, а WebCodecs AudioDecoder недоступен', 'error: Opus received, but WebCodecs AudioDecoder is unavailable'],
            l_agent: ['агент: {0}', 'agent: {0}'],
            l_stats: ['поток: {0} кбит/с, {1} сообщ./с', 'stream: {0} kbit/s, {1} msg/s'],
            l_stats_player: [', в буфере {0} мс, опустошений {1}, сбросов {2}', ', buffered {0} ms, underruns {1}, skips {2}'],
            l_stats_silence: [' (тишина — агент не передаёт)', ' (silence — the agent sends nothing)'],
            l_stats_nodata: [' (данных ещё нет)', ' (no data yet)']
        };
        var e = D[key];
        if (!e) return '';
        var str = e[P._langCache === 'ru' ? 0 : 1], args = arguments;
        return str.replace(/\{(\d)\}/g, function (m0, i) { var v = args[1 + parseInt(i, 10)]; return (v === undefined) ? '' : String(v); });
    };

    // A status message for the user: the translation of its code when known,
    // otherwise the text the server/agent sent.
    obj._statusText = function (m) {
        var T = pluginHandler.deskaudio._t;
        return (m.code && T('code_' + m.code)) || String(m.msg || '').trim();
    };

    obj.onDeviceRefreshEnd = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        var T = P._t;
        pluginHandler.registerPluginTab({ tabId: 'pluginDeskAudio', tabTitle: T('tab') });
        if (s.active && typeof currentNode !== 'undefined' && currentNode && s.nodeid !== currentNode._id) P.stop();
        function pref(k, d) { try { var v = localStorage.getItem('deskaudio_' + k); return (v === null) ? d : v; } catch (e) { return d; } }
        var H = 'pluginHandler.deskaudio';
        QH('pluginDeskAudio',
            '<div style="padding:10px;max-width:560px">' +
            '<b>' + T('title') + '</b>' +
            '<p style="opacity:.7;font-size:12px;margin:6px 0">' + T('intro') + '</p>' +
            '<div style="margin:6px 0"><input type="button" id="da_btn" value="' + T('listen') + '" onclick="' + H + '.toggle()"> ' +
            ' ' + T('volume') + ' <input type="range" id="da_vol" min="0" max="100" value="80" style="vertical-align:middle" oninput="' + H + '.setVolume(this.value)"></div>' +
            '<div style="height:8px;background:rgba(128,128,128,.25);border-radius:4px;overflow:hidden;margin:6px 0">' +
            '<div id="da_bar" style="height:100%;width:0;background:#4a9;"></div></div>' +
            '<div id="da_status" style="font-size:12px;opacity:.8;min-height:16px"></div>' +
            '<fieldset style="margin:10px 0 0;border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:8px 10px">' +
            '<legend style="opacity:.7;font-size:12px;padding:0 4px">' + T('settings') + '</legend>' +
            '<div style="margin:5px 0">' + T('codec') + ' <select id="da_codec" onchange="' + H + '.setCodec(this.value)">' +
            '<option value="auto">' + T('codec_auto') + '</option>' +
            '<option value="opus">' + T('codec_opus') + '</option>' +
            '<option value="adpcm">' + T('codec_adpcm') + '</option>' +
            '<option value="pcm">' + T('codec_pcm') + '</option></select>' +
            ' <span id="da_br" style="opacity:.6;font-size:11px">' + T('bitrate') + ' <select id="da_bitrate" onchange="' + H + '.setBitrate(this.value)">' +
            '<option value="24">' + T('kbps', 24) + '</option><option value="32">' + T('kbps', 32) + '</option><option value="48">' + T('kbps', 48) + '</option></select></span></div>' +
            '<div id="da_rate_row" style="margin:5px 0">' + T('rate') + ' <select id="da_rate" onchange="' + H + '.setRate(this.value)">' +
            '<option value="8000">' + T('rate8') + '</option>' +
            '<option value="16000">' + T('rate16') + '</option>' +
            '<option value="24000">' + T('rate24') + '</option></select></div>' +
            '<div style="margin:5px 0"><label><input type="checkbox" id="da_silence" onchange="' + H + '.setSilence(this.checked)"> ' +
            T('silence') + '</label></div>' +
            '<div style="margin:5px 0">' + T('buffer') + ' <select id="da_buffer" onchange="' + H + '.setBuffer(this.value)">' +
            '<option value="low">' + T('buf_low') + '</option>' +
            '<option value="med">' + T('buf_med') + '</option>' +
            '<option value="high">' + T('buf_high') + '</option></select></div>' +
            '<div style="margin:5px 0"><label><input type="checkbox" id="da_auto" onchange="' + H + '.setAuto(this.checked)"> ' +
            T('auto') + '</label></div>' +
            '</fieldset>' +
            '<details id="da_logbox" style="margin:10px 0 0" ontoggle="' + H + '.toggleLog(this.open)">' +
            '<summary style="cursor:pointer;opacity:.8;font-size:12px">' + T('log') + '</summary>' +
            '<div style="margin:6px 0 4px"><input type="button" id="da_logcopy" value="' + T('copy') + '" onclick="' + H + '.copyLog()"> ' +
            '<input type="button" id="da_logclear" value="' + T('clear') + '" onclick="' + H + '.clearLog()"></div>' +
            '<pre id="da_log" style="margin:0;max-height:240px;overflow:auto;font-size:11px;line-height:1.35;white-space:pre-wrap;' +
            'background:rgba(128,128,128,.12);border-radius:4px;padding:6px"></pre></details></div>');
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
        var lb = document.getElementById('da_logbox');
        if (lb && pref('logopen', '0') === '1') lb.open = true;
        P.log(null);                                            // fill the (re)built log view
        try { var vv = document.getElementById('da_vol'); var sv = pref('vol', null); if (sv !== null && vv) vv.value = sv; } catch (e) { }

        // Button in the Desktop tab's official custom-UI slot (survives version changes).
        // It takes its look from MeshCentral's own «Actions» button, so it matches
        // whichever UI is in use (classic: class "mR"; modern: "btn btn-primary
        // btn-sm me-1") and any custom theme.
        var ref = document.getElementById('deskActionsBtn') || document.getElementById('deskActionsSettings');
        // The tab's own buttons get the same look.
        if (ref && ref.className) ['da_btn', 'da_logcopy', 'da_logclear'].forEach(function (id) {
            var e = document.getElementById(id); if (e) e.className = ref.className;
        });
        var slot = document.getElementById('desktopCustomUiButtons');
        if (slot && !document.getElementById('da_deskbtn')) {
            var db = document.createElement('input');
            db.type = 'button'; db.id = 'da_deskbtn';
            db.title = T('desk_title');
            if (ref && ref.className) db.className = ref.className;
            db.style.cssText = 'float:left';
            db.onkeypress = function () { return false; };      // like MeshCentral's buttons: keys go to the desktop
            db.onkeydown = function () { return false; };
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
            ind.title = T('desk_ind');
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
        P.probeCodecs();
        P.render();
    };

    obj.render = function () {
        var s = pluginHandler.deskaudio._s || {}, T = pluginHandler.deskaudio._t;
        var b = document.getElementById('da_btn');
        if (b) b.value = s.active ? T('stop') : T('listen');
        var st = document.getElementById('da_status');
        if (st) st.textContent = s.statusText || '';
        var db = document.getElementById('da_deskbtn');
        if (db) db.value = s.active ? T('desk_btn_stop') : T('desk_btn');
        var ind = document.getElementById('da_deskind');
        if (ind) ind.style.display = s.active ? '' : 'none';
        if (!s.active) { var bar = document.getElementById('da_bar'); if (bar) bar.style.width = '0'; }
    };

    obj.toggle = function () {
        var P = pluginHandler.deskaudio;
        if ((P._s || {}).active) P.stop(); else P.start();
    };

    // Which codecs this browser can decode: opus via WebCodecs AudioDecoder,
    // plus the always-available software paths. The probe is asynchronous, so
    // it is warmed up when the tab is built; cb(list) runs once it is known.
    obj.probeCodecs = function (cb) {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        var base = ['adpcm', 'pcm'];
        if (s.codecCache) { if (cb) cb(s.codecCache); return; }
        if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined' || !AudioDecoder.isConfigSupported) {
            s.codecCache = base; if (cb) cb(base); return;
        }
        if (cb) (s.codecWaiters = s.codecWaiters || []).push(cb);
        if (s.codecProbing) return;
        s.codecProbing = true;
        function done(list) {
            s.codecCache = list; s.codecProbing = false;
            var w = s.codecWaiters || []; s.codecWaiters = [];
            for (var i = 0; i < w.length; i++) w[i](list);
        }
        try {
            AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })
                .then(function (r) { done((r && r.supported) ? ['opus', 'adpcm', 'pcm'] : base); }, function () { done(base); });
        } catch (e) { done(base); }
    };

    obj.start = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.active || typeof currentNode === 'undefined' || !currentNode) return;
        var AC = window.AudioContext || window.webkitAudioContext;
        var T = P._t;
        if (!AC) { s.statusText = T('st_no_webaudio'); P.render(); return; }
        function g(k, d) { try { var v = localStorage.getItem('deskaudio_' + k); return (v === null) ? d : v; } catch (e) { return d; } }
        var r = document.getElementById('da_rate');
        var rate = r ? parseInt(r.value, 10) : parseInt(g('rate', '16000'), 10);
        if ([8000, 16000, 24000].indexOf(rate) < 0) rate = 16000;
        var codec = g('codec', 'auto');
        var webCodecs = (typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined');
        if (codec === 'opus' && !webCodecs) {
            s.statusText = T('st_no_opus');
            P.render(); return;
        }
        var v = document.getElementById('da_vol');
        s.vol = v ? (v.value / 100) : 0.8;
        s.jitter = { low: 0.08, med: 0.15, high: 0.30 }[g('buffer', 'med')] || 0.15;
        s.nodeid = currentNode._id;
        s.active = true;
        s.gotAudio = false;
        s.statusText = T('st_connecting');
        // Create the AudioContext now, inside the click: Safari only lets a
        // context start from a user gesture. Its rate is the expected stream
        // rate; if the agent ends up sending another rate, the player resamples.
        P._ensureCtx(s, (codec === 'opus' || (codec === 'auto' && webCodecs)) ? 48000 : rate);
        // Don't hang on "Подключение…": if the agent never responds, reset.
        if (s.connectTimer) { clearTimeout(s.connectTimer); }
        s.connectTimer = setTimeout(function () {
            var Pt = pluginHandler.deskaudio, st2 = Pt._s || {};
            if (st2.active && !st2.gotAudio) { Pt.stop(); st2.statusText = Pt._t('st_no_answer'); Pt.render(); }
        }, 10000);
        var msg = P._params('start');
        P.log(T('l_start', currentNode.name || s.nodeid, codec, rate / 1000, Math.round(s.jitter * 1000),
              T(msg.silence ? 'l_sil_on' : 'l_sil_off')) + (codec === 'opus' || codec === 'auto' ? T('l_opus_br', msg.bitrate) : ''));
        s.rxBytes = 0; s.rxMsgs = 0; s.statsAt = Date.now();
        function send(codecs) {
            if (!s.active || s.nodeid !== msg.nodeid) return;    // stopped while probing
            s.codecs = msg.codecs = codecs;
            P.log(T('l_codecs', codecs.join(', ')));
            meshserver.send(msg);
        }
        if (codec === 'opus' || codec === 'adpcm' || codec === 'pcm') send([codec]);
        else P.probeCodecs(send);
        P.render();
    };

    // The stream parameters from the saved settings, as a request to the
    // server ('start' or 'reconfigure'). codecs is filled in by the caller.
    obj._params = function (action) {
        var s = pluginHandler.deskaudio._s || {};
        function g(k, d) { try { var v = localStorage.getItem('deskaudio_' + k); return (v === null) ? d : v; } catch (e) { return d; } }
        var rate = parseInt(g('rate', '16000'), 10);
        if ([8000, 16000, 24000].indexOf(rate) < 0) rate = 16000;
        var codec = g('codec', 'auto');
        return { action: 'plugin', plugin: 'deskaudio', pluginaction: action, nodeid: s.nodeid, rate: rate,
                 compress: codec !== 'pcm', silence: g('silence', '1') !== '0', bitrate: parseInt(g('bitrate', '32'), 10) };
    };

    // A stream setting changed while listening: ask the server to restart the
    // capture with it (only possible when nobody else listens to the stream).
    obj._apply = function () {
        var P = pluginHandler.deskaudio, s = P._s || {};
        if (!s.active || !s.nodeid) return;
        var codec = (function () { try { return localStorage.getItem('deskaudio_codec') || 'auto'; } catch (e) { return 'auto'; } })();
        var webCodecs = (typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined');
        if (codec === 'opus' && !webCodecs) { s.statusText = P._t('st_no_opus'); P.render(); return; }
        var msg = P._params('reconfigure');
        P.probeCodecs(function (list) {
            msg.codecs = (codec === 'opus' || codec === 'adpcm' || codec === 'pcm') ? [codec] : list;
            P.log(P._t('l_reconf', codec, msg.rate / 1000, P._t(msg.silence ? 'l_sil_on' : 'l_sil_off')) + P._t('l_opus_br', msg.bitrate));
            meshserver.send(msg);
        });
    };

    obj.stop = function () {
        var P = pluginHandler.deskaudio;
        var s = P._s = P._s || {};
        if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
        if (s.nodeid && s.active) {
            meshserver.send({ action: 'plugin', plugin: 'deskaudio', pluginaction: 'stop', nodeid: s.nodeid });
            P.log(P._t('l_stopped'));
        }
        P._teardown(s);
        s.active = false; s.statusText = P._t('st_stopped');
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

    // More remembered settings (all apply on the next start).
    obj.setRate = function (v) { try { localStorage.setItem('deskaudio_rate', String(v)); } catch (e) { } pluginHandler.deskaudio._apply(); };
    obj.setCodec = function (v) {
        try { localStorage.setItem('deskaudio_codec', String(v)); } catch (e) { }
        var bri = document.getElementById('da_br');
        if (bri) bri.style.display = (v === 'opus') ? '' : 'none';
        var rr = document.getElementById('da_rate_row');
        if (rr) rr.style.display = (v === 'opus') ? 'none' : '';   // opus is always 48 kHz
        pluginHandler.deskaudio._apply();
    };
    obj.setBitrate = function (v) { try { localStorage.setItem('deskaudio_bitrate', String(v)); } catch (e) { } pluginHandler.deskaudio._apply(); };
    obj.setSilence = function (on) { try { localStorage.setItem('deskaudio_silence', on ? '1' : '0'); } catch (e) { } pluginHandler.deskaudio._apply(); };
    obj.setBuffer = function (v) {
        try { localStorage.setItem('deskaudio_buffer', String(v)); } catch (e) { }
        var s = pluginHandler.deskaudio._s || {};
        s.jitter = { low: 0.08, med: 0.15, high: 0.30 }[v] || 0.15;
        if (s.node) s.node.port.postMessage({ jitter: s.jitter });      // applies immediately
    };

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
        var T = P._t, text = P._statusText(m);
        P.log(T('l_status', m.state) + (m.codec ? T('l_codec', m.codec) : '') + (m.rate ? ', ' + T('khz', m.rate / 1000) : '') +
              (m.code ? ' [' + m.code + ']' : '') + (text ? ' — ' + text : ''));
        if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }  // agent responded
        if (m.state === 'started') s.statusText = T('st_streaming') + (m.rate ? ' (' + T('khz', m.rate / 1000) + ')' : '');
        else if (m.state === 'waiting') {
            // The local user is being asked for consent: wait for their answer
            // (plus a margin) instead of the usual connect timeout.
            s.statusText = T('st_waiting');
            var wt = ((m.timeout > 0 ? m.timeout : 30) + 10) * 1000;
            s.connectTimer = setTimeout(function () {
                var Pt = pluginHandler.deskaudio, st2 = Pt._s || {};
                if (st2.active && !st2.gotAudio) { Pt.stop(); st2.statusText = Pt._t('st_no_answer'); Pt.render(); }
            }, wt);
        }
        else if (m.state === 'info') {
            if (text) s.statusText = text;
        }
        else if (m.state === 'error' || m.state === 'stopped') {
            P._teardown(s);
            s.active = false;
            s.statusText = T(m.state === 'error' ? 'st_error' : 'st_stopped_why', text);
        }
        P.render();
    };

    // ---- Playback core -------------------------------------------------
    // One implementation, used twice: unit-tested in Node, and injected
    // verbatim (via toString) into the AudioWorklet. The worklet runs it on
    // the audio thread, so this must stay self-contained.
    //
    //  * jitter buffer: playback starts (and restarts after a gap) only once
    //    `jitter` seconds are queued, so network jitter doesn't underrun;
    //  * drift: the agent's clock and the browser's never match exactly; the
    //    read speed is nudged by at most +-0.5% to hold the fill near target
    //    (inaudible), and a backlog beyond the cap is skipped in one jump;
    //  * rate: input at any rate is played at the context rate (linear
    //    interpolation) - normally they are equal, but a browser may refuse
    //    AudioContext({sampleRate});
    //  * gaps (silence suppression, underrun): fade to zero, never hold the
    //    last sample (a held sample is a DC step = click).
    obj._playerCore = function () {
        function Player(outRate) {
            this.outRate = outRate;
            this.inRate = 0;
            this.jitter = 0.15;
            this.size = 1 << 18;                 // 262144 samples: 5.4 s at 48 kHz
            this.mask = this.size - 1;
            this.buf = new Float32Array(this.size);
            this.w = 0;                          // samples written (absolute)
            this.r = 0;                          // read position (absolute, fractional)
            this.playing = false;
            this.ratio = 1;
            this.last = 0;
            this.underruns = 0;
            this.skips = 0;
        }
        Player.prototype.setJitter = function (sec) { if (sec > 0) this.jitter = sec; };
        Player.prototype.fill = function () { return this.w - this.r; };
        Player.prototype.push = function (f, rate) {
            if (rate && rate !== this.inRate) {      // new stream format: start over
                this.inRate = rate; this.w = 0; this.r = 0; this.playing = false; this.ratio = 1;
            }
            if (!this.inRate) this.inRate = this.outRate;
            var n = f.length;
            if (n > this.size / 2) { f = f.subarray(n - this.size / 2); n = f.length; }
            // Too far behind real time (or about to overrun the ring): drop the
            // backlog and resume at the target latency.
            var maxFill = Math.min(this.size / 2, Math.round((this.jitter * 2 + 0.45) * this.inRate));
            if (this.fill() + n > maxFill) {
                this.r = Math.max(this.r, this.w + n - Math.round(this.jitter * this.inRate));
                this.skips++;
            }
            for (var i = 0; i < n; i++) this.buf[(this.w + i) & this.mask] = f[i];
            this.w += n;
        };
        Player.prototype.render = function (out) {
            var len = out.length, i = 0;
            if (!this.inRate) { for (; i < len; i++) out[i] = 0; return; }
            var target = this.jitter * this.inRate;
            if (!this.playing) {
                if (this.fill() >= target) { this.playing = true; this.ratio = 1; }
                else { this.fadeOut(out, 0); return; }
            }
            // Drift control: fill above target -> read slightly faster.
            var err = (this.fill() - target) / target;
            if (err > 1) err = 1; else if (err < -1) err = -1;
            this.ratio += ((1 + 0.005 * err) - this.ratio) * 0.01;
            var step = this.inRate / this.outRate * this.ratio;
            for (; i < len; i++) {
                if (this.w - this.r < 2) {                // ran dry: rebuffer
                    this.playing = false; this.underruns++;
                    this.fadeOut(out, i);
                    return;
                }
                var p = Math.floor(this.r), fr = this.r - p;
                var a = this.buf[p & this.mask], b = this.buf[(p + 1) & this.mask];
                var v = a + (b - a) * fr;
                out[i] = v; this.last = v;
                this.r += step;
            }
        };
        // Ramp from the last output to silence over ~2.7 ms, then zeros.
        Player.prototype.fadeOut = function (out, from) {
            for (var i = from; i < out.length; i++) {
                this.last *= 0.98;
                if (this.last > -1e-4 && this.last < 1e-4) this.last = 0;
                out[i] = this.last;
            }
        };
        return Player;
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

    // Create the AudioContext at the stream's rate on the first chunk (the
    // rate is known only then), and the worklet player. Exported: serialized
    // browser code calls it via pluginHandler.deskaudio._ensureCtx.
    obj._ensureCtx = function (s, rate) {
        if (s.ctx) return;
        var P = pluginHandler.deskaudio;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        // Ask for the stream's rate so nothing is resampled. A browser that
        // refuses keeps its own rate; the player then resamples.
        try { s.ctx = new AC({ sampleRate: rate }); } catch (e) { s.ctx = null; }
        if (!s.ctx) { try { s.ctx = new AC(); } catch (e) { P.log(P._t('l_ctx_err', e)); return; } }
        P.log(P._t('l_ctx', s.ctx.sampleRate, rate));
        if (s.ctx.resume) s.ctx.resume();
        s.gain = s.ctx.createGain();
        s.gain.gain.value = (s.vol !== undefined) ? s.vol : 0.8;
        s.gain.connect(s.ctx.destination);
        s.next = 0;
        s.pending = [];
        if (s.ctx.audioWorklet && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
            var code = 'var Player = (' + P._playerCore.toString() + ')();\n' +
                'class DeskAudioProcessor extends AudioWorkletProcessor {\n' +
                '  constructor() { super(); this.p = new Player(sampleRate); this.n = 0;\n' +
                '    this.port.onmessage = (e) => { const d = e.data;\n' +
                '      if (d.jitter) this.p.setJitter(d.jitter);\n' +
                '      if (d.s) this.p.push(d.s, d.rate); }; }\n' +
                '  process(inputs, outputs) { this.p.render(outputs[0][0]);\n' +
                '    if (++this.n >= 375) { this.n = 0; const p = this.p;\n' +
                '      this.port.postMessage({ stats: { fill: p.inRate ? p.fill() / p.inRate : 0, underruns: p.underruns, skips: p.skips } }); }\n' +
                '    return true; }\n' +
                '}\n' +
                "registerProcessor('deskaudio-processor', DeskAudioProcessor);\n";
            try {
                var ctx = s.ctx;
                var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
                s.workletUrl = url;
                ctx.audioWorklet.addModule(url).then(function () {
                    if (s.ctx !== ctx) return;              // stopped meanwhile
                    s.node = new AudioWorkletNode(ctx, 'deskaudio-processor', { numberOfInputs: 0, outputChannelCount: [1] });
                    s.node.connect(s.gain);
                    // The worklet reports about once a second, also during silence;
                    // that is the clock for the periodic log line (no timers).
                    s.node.port.onmessage = function (e) { if (e.data && e.data.stats) { s.player = e.data.stats; P._stats(); } };
                    s.node.port.postMessage({ jitter: s.jitter || 0.15 });
                    var q = s.pending || [];
                    s.pending = null;
                    for (var i = 0; i < q.length; i++) s.node.port.postMessage({ s: q[i].f, rate: q[i].rate }, [q[i].f.buffer]);
                    P.log(P._t('l_worklet', Math.round((s.jitter || 0.15) * 1000)));
                }).catch(function (e) {
                    if (s.ctx !== ctx) return;
                    s.pending = null;                                        // -> fallback scheduler
                    P.log(P._t('l_worklet_fail', e));
                });
                return;
            } catch (e) { }
        }
        s.pending = null;                               // no AudioWorklet: fallback scheduler
        P.log(P._t('l_worklet_none'));
    };

    // Decoded PCM from any codec, at its own rate: to the worklet player (or,
    // without AudioWorklet, the buffer-source scheduler) and the level meter.
    obj._pushDecoded = function (s, f32, rate) {
        var n = f32.length;
        if (!n || !s.ctx) return;
        var sum = 0;
        for (var i = 0; i < n; i++) sum += f32[i] * f32[i];
        if (!s.gotAudio) {
            s.gotAudio = true;
            if (s.connectTimer) { clearTimeout(s.connectTimer); s.connectTimer = null; }
            var T = pluginHandler.deskaudio._t;
            pluginHandler.deskaudio.log(T('l_first', s.codecName || '?', rate));
            s.statusText = T('st_streaming') + ' (' + (s.codecName ? s.codecName + ', ' : '') + T('khz', rate / 1000) + ')';
            pluginHandler.deskaudio.render();
        }
        if (s.node) {
            var cp = new Float32Array(f32);          // own copy: its buffer is transferred
            s.node.port.postMessage({ s: cp, rate: rate }, [cp.buffer]);
        } else if (s.pending) {
            s.pending.push({ f: new Float32Array(f32), rate: rate });   // worklet still loading
        } else {
            var jit = s.jitter || 0.15;
            var ctx = s.ctx, now = ctx.currentTime;
            if (s.next - now > jit * 2 + 0.45) return;  // too far behind real time: drop
            var buf = ctx.createBuffer(1, n, rate);
            buf.copyToChannel(f32, 0);
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

    // Opus decode path: WebCodecs AudioDecoder.
    obj._ensureOpusDecoder = function (s) {
        if (s.opusDec) return s.opusDec;
        if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return null;
        try {
            var dec = new AudioDecoder({
                output: function (frame) {
                    var st = pluginHandler.deskaudio._s || {};
                    try {
                        if (st.opusDec === dec) {
                            // NB: allocationSize() is in BYTES; the plane holds
                            // numberOfFrames float samples (mono).
                            var plane = new Float32Array(frame.numberOfFrames);
                            frame.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
                            pluginHandler.deskaudio._pushDecoded(st, plane, frame.sampleRate || 48000);
                        }
                    } catch (e) { }
                    try { frame.close(); } catch (e) { }
                },
                error: function (err) {
                    var P = pluginHandler.deskaudio, st = P._s || {};
                    if (st.opusDec !== dec) return;
                    P.log(P._t('l_opus_err', err && (err.message || err)));
                    P.stop();
                    st.statusText = P._t('st_opus_err');
                    P.render();
                }
            });
            dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
            s.opusDec = dec;
            s.opusTs = 0;
        } catch (e) { return null; }
        return s.opusDec;
    };

    // One opus chunk from the agent. Payload: a sequence of packets, each
    // [dur:2 LE][len:2 LE][packet] ('opus2'), or a single [dur:2 LE][packet]
    // ('opus', agents up to 1.0.3). dur is in 48 kHz samples.
    obj._opusChunk = function (s, bin, multi) {
        var P = pluginHandler.deskaudio;
        var dec = P._ensureOpusDecoder(s);
        if (!dec) {
            P.log(P._t('l_no_webcodecs'));
            P.stop();
            s.statusText = P._t('st_no_opus');
            P.render();
            return;
        }
        var pos = 0;
        while (pos + 2 <= bin.length) {
            var dur = bin.charCodeAt(pos) | (bin.charCodeAt(pos + 1) << 8);
            var len;
            if (multi) {
                if (pos + 4 > bin.length) return;
                len = bin.charCodeAt(pos + 2) | (bin.charCodeAt(pos + 3) << 8);
                pos += 4;
            } else { pos += 2; len = bin.length - pos; }
            if (len <= 0 || pos + len > bin.length || dur <= 0) return;
            var u8 = new Uint8Array(len);
            for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(pos + i) & 0xFF;
            pos += len;
            var us = dur * 1000000 / 48000;
            try { dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.opusTs, duration: us, data: u8 })); } catch (e) { }
            s.opusTs += us;
        }
    };

    obj.onChunk = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;
        var P = pluginHandler.deskaudio;
        var s = (P._s || {});
        if (!s.active || !m || m.nodeid !== s.nodeid || typeof m.d !== 'string') return;
        s.rxBytes = (s.rxBytes || 0) + m.d.length * 3 / 4; s.rxMsgs = (s.rxMsgs || 0) + 1;
        if (!s.node) P._stats();                // no worklet clock: the chunks drive the stats line
        var opus = (m.codec === 'opus' || m.codec === 'opus2');
        var rate = opus ? 48000 : (m.rate || 16000);
        P._ensureCtx(s, rate);
        if (!s.ctx) return;
        var bin = atob(m.d);
        if (opus) { s.codecName = 'Opus'; P._opusChunk(s, bin, m.codec === 'opus2'); return; }
        var f, i;
        if (m.codec === 'adpcm') {
            s.codecName = 'ADPCM';
            f = P._adpcmDecode(bin);
        } else {
            s.codecName = 'PCM';
            var n0 = bin.length >> 1;
            f = new Float32Array(n0);
            for (i = 0; i < n0; i++) {
                var v = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i);
                if (v & 0x8000) v -= 0x10000;
                f[i] = v / 32768;
            }
        }
        if (!f || f.length === 0) return;
        P._pushDecoded(s, f, rate);
    };

    // Release everything playback-related (worklet, decoder, context).
    obj._teardown = function (s) {
        try { if (s.node) { s.node.disconnect(); s.node.port.onmessage = null; } } catch (e) { }
        try { if (s.workletUrl) URL.revokeObjectURL(s.workletUrl); } catch (e) { }
        try { if (s.opusDec && s.opusDec.state !== 'closed') s.opusDec.close(); } catch (e) { }
        try { if (s.ctx) s.ctx.close(); } catch (e) { }
        s.player = null;
        s.node = null; s.workletUrl = null; s.pending = null; s.opusDec = null; s.opusTs = 0;
        s.ctx = null; s.gain = null; s.codecName = '';
    };

    // ---- Log window ----------------------------------------------------
    // A per-page diagnostic log shown in the «Журнал» box of the tab: what was
    // requested, what the agent answered, helper messages (device, format,
    // reopen), and periodic stream statistics. log(null) only redraws.
    obj.log = function (text) {
        // Diagnostics must never break audio: tolerate a missing page context.
        if (typeof pluginHandler === 'undefined' || !pluginHandler.deskaudio) return;
        var P = pluginHandler.deskaudio;
        var L = P._log = P._log || [];
        if (text !== null && text !== undefined) {
            var d = new Date();
            function two(n) { return (n < 10 ? '0' : '') + n; }
            L.push(two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '  ' + text);
            if (L.length > 300) L.splice(0, L.length - 300);
        }
        var el = (typeof document !== 'undefined') ? document.getElementById('da_log') : null;
        if (el) { el.textContent = L.join('\n'); el.scrollTop = el.scrollHeight; }
    };

    // Agent-side lines (helper launch, capture format, device changes).
    obj.onLog = function (a, b) {
        var m = (b !== undefined && b !== null) ? b : a;
        var P = pluginHandler.deskaudio, s = P._s || {};
        if (!m || m.nodeid !== s.nodeid || typeof m.msg !== 'string') return;
        P.log(P._t('l_agent', m.msg));
    };

    // Every 5 s while listening: received bitrate and the player's state.
    obj._stats = function () {
        var P = pluginHandler.deskaudio, s = P._s || {};
        if (!s.active) return;
        var now = Date.now(), dt = (now - (s.statsAt || now)) / 1000;
        if (dt < 5) return;
        var T = P._t;
        var line = T('l_stats', Math.round((s.rxBytes || 0) * 8 / 1000 / dt), Math.round((s.rxMsgs || 0) / dt * 10) / 10);
        if (s.player) line += T('l_stats_player', Math.round(s.player.fill * 1000), s.player.underruns, s.player.skips);
        if (!s.rxMsgs) line += T(s.gotAudio ? 'l_stats_silence' : 'l_stats_nodata');
        P.log(line);
        s.rxBytes = 0; s.rxMsgs = 0; s.statsAt = now;
    };

    obj.copyLog = function () {
        var text = (pluginHandler.deskaudio._log || []).join('\n');
        try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; } } catch (e) { }
        var el = document.getElementById('da_log');
        if (el && window.getSelection) { var r = document.createRange(); r.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        try { document.execCommand('copy'); } catch (e) { }
    };

    obj.clearLog = function () { pluginHandler.deskaudio._log = []; pluginHandler.deskaudio.log(null); };

    obj.toggleLog = function (open) { try { localStorage.setItem('deskaudio_logopen', open ? '1' : '0'); } catch (e) { } };

    return obj;
};
