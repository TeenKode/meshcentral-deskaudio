// Tests for the server side of the Desktop Audio plugin: the serveraction
// router, rights enforcement, listener bookkeeping, agent<->browser relaying,
// keepalive, and cleanup. No network, no MeshCentral runtime — just the mocks
// in helpers.js.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const {
    loadPlugin,
    makeWs,
    makeUserSession,
    makeWeb,
    connectAgent
} = require("./helpers");

const NODE = "node//pc1";

// Drive a browser "start" through serveraction (user path: myparent has .user).
function userStart(obj, sess, web, command) {
    obj.serveraction(Object.assign({ pluginaction: "start", nodeid: NODE }, command || {}), sess, web);
}
function userStop(obj, sess, web) {
    obj.serveraction({ pluginaction: "stop", nodeid: NODE }, sess, web);
}
// Drive an agent message through serveraction (agent path: myparent has dbNodeKey).
function agentMsg(obj, agent, command) {
    obj.serveraction(command, agent, undefined);
}

function lastStatus(ws) {
    for (let i = ws.sent.length - 1; i >= 0; i--) if (ws.sent[i].method === "onStatus") return ws.sent[i];
    return null;
}

test("first listener with rights starts capture on the agent", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    const web = makeWeb();

    userStart(obj, sess, web, { rate: 24000 });

    assert.strictEqual(agent.sent.length, 1, "one command sent to agent");
    const cmd = agent.sent[0];
    assert.strictEqual(cmd.action, "plugin");
    assert.strictEqual(cmd.plugin, "deskaudio");
    assert.strictEqual(cmd.pluginaction, "start");
    assert.strictEqual(cmd.rate, 24000);
    assert.ok(typeof cmd.script === "string" && cmd.script.length > 0, "linux helper script included");
    assert.ok(typeof cmd.exe64 === "string" && cmd.exe64.length > 0, "windows x64 native helper included");
    assert.ok(typeof cmd.exe32 === "string" && cmd.exe32.length > 0, "windows x86 native helper included");
    assert.ok(typeof cmd.ver64 === "string" && cmd.ver64.length > 0, "x64 helper version hash included");
    assert.ok(typeof cmd.ver32 === "string" && cmd.ver32.length > 0, "x86 helper version hash included");
    assert.strictEqual(cmd.source, undefined, "no C# fallback source is sent");
    assert.strictEqual(typeof cmd.sid, "number", "capture carries a session id");
    // Start is logged to the device event log.
    assert.strictEqual(meshServer.events.length, 1);
    assert.strictEqual(meshServer.events[0].action, "deskaudio");
});

test("an invalid sample rate is clamped to 16000", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    userStart(obj, makeUserSession(), makeWeb(), { rate: 99999 });
    assert.strictEqual(agent.sent[0].rate, 16000);
});

test("start is rejected without Remote Control rights", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();

    userStart(obj, sess, makeWeb({ rights: 0 }));

    assert.strictEqual(agent.sent.length, 0, "agent not contacted");
    const st = lastStatus(sess.ws);
    assert.ok(st && st.state === "error", "user told it was an error");
    assert.strictEqual(meshServer.events.length, 0, "nothing logged");
});

test("start is rejected when the device is offline", () => {
    const { obj } = loadPlugin();            // no agent connected
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());
    const st = lastStatus(sess.ws);
    assert.ok(st && st.state === "error");
    assert.match(st.msg, /не в сети/i);
});

test("start is ignored for a non-node id", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    obj.serveraction({ pluginaction: "start", nodeid: "mesh//x" }, sess, makeWeb());
    assert.strictEqual(agent.sent.length, 0);
    assert.strictEqual(sess.ws.sent.length, 0);
});

test("a second listener attaches without restarting capture", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });

    userStart(obj, a, web);
    userStart(obj, b, web);

    assert.strictEqual(agent.sent.length, 1, "agent started only once");
    const st = lastStatus(b.ws);
    assert.ok(st && st.state === "started", "second listener gets 'started' immediately");
});

test("the same session starting twice is a no-op", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const sess = makeUserSession();
    userStart(obj, sess, web);
    const eventsAfterFirst = meshServer.events.length;
    userStart(obj, sess, web);
    assert.strictEqual(agent.sent.length, 1);
    assert.strictEqual(meshServer.events.length, eventsAfterFirst, "no duplicate log entry");
});

test("listeners beyond the cap are rejected", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const CAP = 10;   // MAX_LISTENERS_PER_NODE
    for (let i = 0; i < CAP; i++) userStart(obj, makeUserSession({ userid: "user//" + i }), web);
    const overflow = makeUserSession({ userid: "user//over" });
    userStart(obj, overflow, web);
    const st = lastStatus(overflow.ws);
    assert.ok(st && st.state === "error");
    assert.match(st.msg, /слишком много/i);
});

test("agent audio chunks are relayed to every listener", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });
    userStart(obj, a, web);
    userStart(obj, b, web);

    agentMsg(obj, agent, { pluginaction: "chunk", rate: 16000, d: "QUJD" });

    for (const ws of [a.ws, b.ws]) {
        const chunk = ws.sent.filter((m) => m.method === "onChunk").pop();
        assert.ok(chunk, "listener received a chunk");
        assert.strictEqual(chunk.d, "QUJD");
        assert.strictEqual(chunk.rate, 16000);
    }
});

test("an oversized chunk is dropped", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());
    const before = sess.ws.sent.length;
    agentMsg(obj, agent, { pluginaction: "chunk", rate: 16000, d: "A".repeat(262145) });
    const chunks = sess.ws.sent.slice(before).filter((m) => m.method === "onChunk");
    assert.strictEqual(chunks.length, 0);
});

test("chunks for an unknown node are ignored", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    // No listener registered: agentAction returns early on missing list.
    assert.doesNotThrow(() => agentMsg(obj, agent, { pluginaction: "chunk", rate: 16000, d: "QUJD" }));
});

test("an agent 'error' status ends the stream for all listeners", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });
    userStart(obj, a, web);
    userStart(obj, b, web);

    agentMsg(obj, agent, { pluginaction: "status", state: "error", msg: "boom" });

    for (const ws of [a.ws, b.ws]) {
        const st = lastStatus(ws);
        assert.strictEqual(st.state, "error");
        assert.strictEqual(st.msg, "boom");
    }
    // Stream is cleared: a later chunk reaches nobody.
    const before = a.ws.sent.length;
    agentMsg(obj, agent, { pluginaction: "chunk", rate: 16000, d: "QUJD" });
    assert.strictEqual(a.ws.sent.length, before, "no chunks after the stream ended");
});

test("a non-terminal agent status is relayed, not terminal", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());

    agentMsg(obj, agent, { pluginaction: "status", state: "started", rate: 24000 });
    const st = lastStatus(sess.ws);
    assert.strictEqual(st.state, "started");
    assert.strictEqual(st.rate, 24000);

    // Still live: a following chunk is delivered.
    agentMsg(obj, agent, { pluginaction: "chunk", rate: 24000, d: "QUJD" });
    assert.ok(sess.ws.sent.some((m) => m.method === "onChunk"));
});

test("the last listener leaving stops the agent", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });
    userStart(obj, a, web);
    userStart(obj, b, web);

    userStop(obj, a, web);
    assert.ok(!agent.sent.some((m) => m.pluginaction === "stop"), "not stopped while a listener remains");

    userStop(obj, b, web);
    assert.ok(agent.sent.some((m) => m.pluginaction === "stop"), "stopped once the last listener leaves");
});

test("closing the browser socket removes the listener and stops the agent", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());

    sess.ws.triggerClose();

    assert.ok(agent.sent.some((m) => m.pluginaction === "stop"), "agent told to stop on disconnect");
});

test("keepalive ends the stream when the agent has disconnected", () => {
    // Capture the keepalive interval callback instead of waiting on real time.
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    let captured = null;
    global.setInterval = (fn) => { captured = fn; return { unref() {} }; };
    global.clearInterval = () => {};
    try {
        const { obj, meshServer } = loadPlugin();
        const agent = connectAgent(meshServer, NODE);
        const sess = makeUserSession();
        userStart(obj, sess, makeWeb());
        assert.ok(captured, "keepalive timer was armed");

        // Agent drops off the server, then keepalive fires.
        delete meshServer.webserver.wsagents[NODE];
        captured();

        const st = lastStatus(sess.ws);
        assert.strictEqual(st.state, "stopped");
        assert.match(st.msg, /отключил/i);
    } finally {
        global.setInterval = realSet;
        global.clearInterval = realClear;
    }
});

test("backpressure drops audio but never status", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());

    sess.ws.bufferedAmount = 2 * 1048576;        // browser is 2 MB behind
    const before = sess.ws.sent.length;
    agentMsg(obj, agent, { pluginaction: "chunk", rate: 16000, d: "QUJD" });
    assert.strictEqual(sess.ws.sent.length, before, "audio dropped under backpressure");

    agentMsg(obj, agent, { pluginaction: "status", state: "started" });
    assert.ok(lastStatus(sess.ws), "status still delivered under backpressure");
});

test("audio from an agent with no listeners tells the agent to stop", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    // No listeners registered (e.g. server restarted while the agent captured).
    agentMsg(obj, agent, { pluginaction: "chunk", rate: 16000, d: "QUJD" });
    assert.strictEqual(agent.sent.length, 1, "agent told to stop");
    assert.strictEqual(agent.sent[0].pluginaction, "stop");
});

test("a terminal status from an agent with no listeners does not loop a stop", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    agentMsg(obj, agent, { pluginaction: "status", state: "stopped" });
    assert.strictEqual(agent.sent.length, 0, "no stop sent for an already-stopped agent");
});

test("a new stream beyond the server-wide cap is rejected", () => {
    const { obj, meshServer } = loadPlugin();
    const web = makeWeb();
    const TOTAL_CAP = 50;   // MAX_TOTAL_STREAMS
    for (let i = 0; i < TOTAL_CAP; i++) {
        const nid = "node//s" + i;
        connectAgent(meshServer, nid);
        obj.serveraction({ pluginaction: "start", nodeid: nid, rate: 16000 }, makeUserSession({ userid: "u//" + i }), web);
    }
    const nid = "node//over";
    connectAgent(meshServer, nid);
    const over = makeUserSession({ userid: "u//over" });
    obj.serveraction({ pluginaction: "start", nodeid: nid, rate: 16000 }, over, web);
    const st = lastStatus(over.ws);
    assert.ok(st && st.state === "error");
    assert.match(st.msg, /слишком много одновременных/i);
});

// ---------- session ids, races, rights, consent ----------

function agentStarts(agent) { return agent.sent.filter((m) => m.pluginaction === "start"); }

test("a stale 'stopped' from the previous capture does not end a new one", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const sess = makeUserSession();

    userStart(obj, sess, web);
    const sid1 = agentStarts(agent)[0].sid;
    userStop(obj, sess, web);
    const stop = agent.sent.filter((m) => m.pluginaction === "stop").pop();
    assert.strictEqual(stop.sid, sid1, "stop names the capture it ends");
    userStart(obj, sess, web);
    const sid2 = agentStarts(agent)[1].sid;
    assert.notStrictEqual(sid1, sid2, "a new capture gets a new session id");

    // The agent's answer to the first stop arrives after the new start.
    agentMsg(obj, agent, { pluginaction: "status", sid: sid1, state: "stopped" });
    agentMsg(obj, agent, { pluginaction: "chunk", sid: sid1, rate: 16000, d: "T0xE" });
    agentMsg(obj, agent, { pluginaction: "status", sid: sid2, state: "started", proto: 2, rate: 16000 });
    agentMsg(obj, agent, { pluginaction: "chunk", sid: sid2, rate: 16000, d: "TkVX" });

    const chunks = sess.ws.sent.filter((m) => m.method === "onChunk");
    assert.deepStrictEqual(chunks.map((c) => c.d), ["TkVX"], "only the new capture's audio is relayed");
    assert.strictEqual(lastStatus(sess.ws).state, "started", "the new session was not ended");
});

test("a stop that arrives before the rights check finishes cancels the start", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    let pendingCb = null;
    web.GetNodeWithRights = function (domain, user, nodeid, cb) { pendingCb = () => cb(this.node, this.rights); };
    const sess = makeUserSession();

    userStart(obj, sess, web);
    userStop(obj, sess, web);
    pendingCb();

    assert.strictEqual(agentStarts(agent).length, 0, "no capture started after the user stopped");
});

test("NODESKTOP denies audio, full administrator rights allow it", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const denied = makeUserSession({ userid: "user//d" });
    userStart(obj, denied, makeWeb({ rights: 0x8 | 0x10000 }));
    assert.strictEqual(lastStatus(denied.ws).code, "no_rights");
    assert.strictEqual(agentStarts(agent).length, 0);

    userStart(obj, makeUserSession({ userid: "user//admin" }), makeWeb({ rights: 0xFFFFFFFF }));
    assert.strictEqual(agentStarts(agent).length, 1, "full rights include remote control");
});

function consentWeb(consent, domain) {
    const web = makeWeb();
    web.meshes = { "mesh//m1": { consent } };
    return web;
}

test("device-group consent flags are passed to the agent", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession({ name: "bob" });
    sess.domain = { id: "", userconsentflags: 1, consentmessages: { title: "Corp", consenttimeout: 15 } };
    userStart(obj, sess, consentWeb(8));
    const c = agentStarts(agent)[0].consent;
    assert.strictEqual(c.prompt, true, "group asks for consent");
    assert.strictEqual(c.notify, true, "server-wide notify flag added");
    assert.strictEqual(c.title, "Corp");
    assert.strictEqual(c.timeout, 15);
    assert.match(c.msg, /bob/);
});

test("with consent required, audio flows only after the agent confirms", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, consentWeb(8));
    const sid = agentStarts(agent)[0].sid;

    agentMsg(obj, agent, { pluginaction: "status", sid, state: "waiting", code: "consent_wait", timeout: 30 });
    assert.strictEqual(lastStatus(sess.ws).state, "waiting");
    assert.strictEqual(lastStatus(sess.ws).timeout, 30);
    agentMsg(obj, agent, { pluginaction: "chunk", sid, rate: 16000, d: "QUJD" });
    assert.ok(!sess.ws.sent.some((m) => m.method === "onChunk"), "no audio before consent");

    agentMsg(obj, agent, { pluginaction: "status", sid, state: "started", proto: 2, rate: 16000 });
    agentMsg(obj, agent, { pluginaction: "chunk", sid, rate: 16000, d: "QUJD" });
    assert.ok(sess.ws.sent.some((m) => m.method === "onChunk"), "audio after consent");
});

test("an outdated agent core is refused where consent is required", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, consentWeb(1));
    // Old cores answer without sid/proto.
    agentMsg(obj, agent, { pluginaction: "status", state: "started", rate: 16000 });
    assert.strictEqual(lastStatus(sess.ws).code, "agent_outdated");
    assert.ok(agent.sent.some((m) => m.pluginaction === "stop"), "the capture is stopped");
});

test("a further listener on a consent device is asked for separately", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = consentWeb(8);
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });
    const c = makeUserSession({ userid: "user//c" });
    userStart(obj, a, web);
    const sid = agentStarts(agent)[0].sid;
    agentMsg(obj, agent, { pluginaction: "status", sid, state: "started", proto: 2, rate: 16000 });

    userStart(obj, b, web);
    userStart(obj, c, web);
    const asks = agent.sent.filter((m) => m.pluginaction === "consent");
    assert.strictEqual(asks.length, 2, "the agent is asked once per new user");
    assert.strictEqual(lastStatus(b.ws).state, "waiting");

    agentMsg(obj, agent, { pluginaction: "consentresult", sid, reqid: asks[0].reqid, ok: true });
    agentMsg(obj, agent, { pluginaction: "consentresult", sid, reqid: asks[1].reqid, ok: false });
    assert.strictEqual(lastStatus(b.ws).state, "started");
    assert.strictEqual(lastStatus(c.ws).code, "consent_denied");

    agentMsg(obj, agent, { pluginaction: "chunk", sid, rate: 16000, d: "QUJD" });
    assert.ok(b.ws.sent.some((m) => m.method === "onChunk"), "approved listener hears audio");
    assert.ok(!c.ws.sent.some((m) => m.method === "onChunk"), "denied listener hears nothing");
});

test("a further listener on a notify-only device triggers a notification", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = consentWeb(1);
    userStart(obj, makeUserSession({ userid: "user//a" }), web);
    userStart(obj, makeUserSession({ userid: "user//b" }), web);
    assert.strictEqual(agent.sent.filter((m) => m.pluginaction === "notify").length, 1);
});

test("chunks with an invalid rate are dropped", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());
    agentMsg(obj, agent, { pluginaction: "chunk", rate: 1, d: "QUJD" });
    agentMsg(obj, agent, { pluginaction: "chunk", rate: "x", d: "QUJD" });
    assert.ok(!sess.ws.sent.some((m) => m.method === "onChunk"));
});

test("server-generated errors carry a stable code", () => {
    const { obj } = loadPlugin();
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());
    assert.strictEqual(lastStatus(sess.ws).code, "offline");
});

// ---------- codec negotiation (Opus) ----------

test("browser-listed codecs are honored: opus is offered to the agent", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb(), { codecs: ["opus", "adpcm", "pcm"], bitrate: 24 });
    const start = agent.sent.find((m) => m.pluginaction === "start");
    assert.strictEqual(start.codec, "opus");
    assert.strictEqual(start.bitrate, 24);
});

test("without opus in the browser list the agent stays on adpcm", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb(), { codecs: ["adpcm", "pcm"] });
    const start = agent.sent.find((m) => m.pluginaction === "start");
    assert.strictEqual(start.codec, null);
});

test("the bitrate is clamped to 24/32/48", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb(), { codecs: ["opus"], bitrate: 99 });
    const start = agent.sent.find((m) => m.pluginaction === "start");
    assert.strictEqual(start.bitrate, 32);
});

test("opus chunks are relayed with their codec field", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb(), { codecs: ["opus"] });
    agentMsg(obj, agent, { pluginaction: "status", sid: 1, state: "started", proto: 2, codec: "opus", rate: 16000 });
    agentMsg(obj, agent, { pluginaction: "chunk", sid: 1, rate: 16000, codec: "opus", d: "AAECAw==" });
    const chunk = sess.ws.sent.find((m) => m.method === "onChunk");
    assert.strictEqual(chunk.codec, "opus");
    assert.strictEqual(chunk.d, "AAECAw==");
});

// ---------- codec negotiation ----------

test("an explicit PCM choice starts the agent uncompressed", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    // Even a browser that still sends the legacy compress=true flag.
    userStart(obj, makeUserSession(), makeWeb(), { codecs: ["pcm"], compress: true });
    const st = agentStarts(agent)[0];
    assert.strictEqual(st.compress, false);
    assert.strictEqual(st.codec, null);
});

test("opus is negotiated when the browser can decode it", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    userStart(obj, makeUserSession(), makeWeb(), { codecs: ["opus", "adpcm", "pcm"], bitrate: 48 });
    const st = agentStarts(agent)[0];
    assert.strictEqual(st.codec, "opus");
    assert.strictEqual(st.bitrate, 48);
});

test("a listener that cannot decode Opus is not attached to an Opus stream", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });
    userStart(obj, a, web, { codecs: ["opus", "adpcm", "pcm"] });
    const sid = agentStarts(agent)[0].sid;
    agentMsg(obj, agent, { pluginaction: "status", sid, state: "started", proto: 2, rate: 16000, codec: "opus" });
    userStart(obj, b, web, { codecs: ["adpcm", "pcm"] });
    assert.strictEqual(lastStatus(b.ws).code, "codec_mismatch");
    agentMsg(obj, agent, { pluginaction: "chunk", sid, rate: 16000, codec: "opus2", d: "QUJD" });
    assert.ok(!b.ws.sent.some((m) => m.method === "onChunk"), "no undecodable audio for the second browser");
    assert.strictEqual(a.ws.sent.filter((m) => m.method === "onChunk").pop().codec, "opus2", "opus2 chunks are relayed");
});

test("an agent that fell back from Opus (Linux) lets ADPCM-only listeners join", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    userStart(obj, makeUserSession({ userid: "user//a" }), web, { codecs: ["opus", "adpcm", "pcm"] });
    const sid = agentStarts(agent)[0].sid;
    agentMsg(obj, agent, { pluginaction: "status", sid, state: "started", proto: 2, rate: 16000, codec: "adpcm" });
    const b = makeUserSession({ userid: "user//b" });
    userStart(obj, b, web, { codecs: ["adpcm", "pcm"] });
    assert.strictEqual(lastStatus(b.ws).state, "started");
});

test("agent log lines are relayed to the listeners' log windows", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession();
    userStart(obj, sess, makeWeb());
    const sid = agentStarts(agent)[0].sid;
    agentMsg(obj, agent, { pluginaction: "log", sid, msg: "capture: 48000 Hz, 2 ch" + "x".repeat(400) });
    agentMsg(obj, agent, { pluginaction: "log", sid: sid + 99, msg: "stale" });
    const logs = sess.ws.sent.filter((m) => m.method === "onLog");
    assert.strictEqual(logs.length, 1, "stale-session lines are dropped");
    assert.ok(logs[0].msg.startsWith("capture: 48000 Hz") && logs[0].msg.length === 300, "truncated to 300 chars");
});

// ---------- helper delivery on demand ----------

test("helper bytes are sent until the agent shows it fetches them on demand", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const sess = makeUserSession();

    userStart(obj, sess, web);
    let st = agentStarts(agent)[0];
    assert.ok(st.exe64 && st.exe32, "unknown agent core: full bytes");
    assert.match(st.helper.x64.sha, /^[0-9a-f]{96}$/, "SHA-384 of the x64 build");
    assert.ok(st.helper.x86.size > 100000);

    agentMsg(obj, agent, { pluginaction: "status", sid: st.sid, state: "started", proto: 3, rate: 16000 });
    userStop(obj, sess, web);
    userStart(obj, sess, web);
    st = agentStarts(agent)[1];
    assert.strictEqual(st.exe64, undefined, "proto 3 agent: no helper bytes in start");
    assert.strictEqual(st.exe32, undefined);
    assert.ok(JSON.stringify(st).length < 10000, "start message is small (was ~1.2 MB): " + JSON.stringify(st).length + " bytes");

    agentMsg(obj, agent, { pluginaction: "need", sid: st.sid, proto: 3, arch: "x86" });
    const h = agent.sent.filter((m) => m.pluginaction === "helper").pop();
    assert.strictEqual(h.arch, "x86");
    assert.strictEqual(h.sid, st.sid);
    const bytes = Buffer.from(h.data, "base64");
    assert.strictEqual(require("crypto").createHash("sha384").update(bytes).digest("hex"), st.helper.x86.sha);
});

test("a reconnected agent (new connection) is sent the bytes again", () => {
    const { obj, meshServer } = loadPlugin();
    let agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const sess = makeUserSession();
    userStart(obj, sess, web);
    const sid = agentStarts(agent)[0].sid;
    agentMsg(obj, agent, { pluginaction: "status", sid, state: "started", proto: 3, rate: 16000 });
    userStop(obj, sess, web);
    agent = connectAgent(meshServer, NODE);          // new core, new connection object
    userStart(obj, sess, web);
    assert.ok(agentStarts(agent)[0].exe64, "unknown again: full bytes");
});

// ---------- settings from MeshCentral's config.json ----------

function withSettings(meshServer, d) { meshServer.config.settings = { plugins: { enabled: true, deskaudio: d } }; }

test("listener and stream limits come from config.json (keys are lower-cased by MeshCentral)", () => {
    const { obj, meshServer } = loadPlugin();
    withSettings(meshServer, { maxlistenerspernode: 2, maxstreams: 1 });
    connectAgent(meshServer, NODE);
    const web = makeWeb();
    userStart(obj, makeUserSession({ userid: "u//1" }), web);
    userStart(obj, makeUserSession({ userid: "u//2" }), web);
    const third = makeUserSession({ userid: "u//3" });
    userStart(obj, third, web);
    assert.strictEqual(lastStatus(third.ws).code, "too_many_listeners");

    connectAgent(meshServer, "node//pc2");
    const other = makeUserSession({ userid: "u//4" });
    obj.serveraction({ pluginaction: "start", nodeid: "node//pc2" }, other, web);
    assert.strictEqual(lastStatus(other.ws).code, "too_many_streams");
});

test("invalid limits fall back to the defaults", () => {
    const { obj, meshServer } = loadPlugin();
    withSettings(meshServer, { maxListenersPerNode: "lots", maxStreams: -5 });
    connectAgent(meshServer, NODE);
    const web = makeWeb();
    for (let i = 0; i < 10; i++) userStart(obj, makeUserSession({ userid: "u//" + i }), web);
    const over = makeUserSession({ userid: "u//over" });
    userStart(obj, over, web);
    assert.strictEqual(lastStatus(over.ws).code, "too_many_listeners", "default cap of 10 applies");
});

test("spawnAsUser and custom consent texts are passed to the agent", () => {
    const { obj, meshServer } = loadPlugin();
    withSettings(meshServer, { spawnAsUser: true, consentMessage: "Можно послушать, {0}?" });
    const agent = connectAgent(meshServer, NODE);
    const sess = makeUserSession({ name: "bob" });
    userStart(obj, sess, consentWeb(8));
    const st = agentStarts(agent)[0];
    assert.strictEqual(st.spawnAsUser, true);
    assert.strictEqual(st.consent.msg, "Можно послушать, bob?");
});

test("the end of listening is logged with its duration", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    const b = makeUserSession({ userid: "user//b" });
    const realNow = Date.now;
    try {
        Date.now = () => 1000000;
        userStart(obj, a, web);
        userStart(obj, b, web);
        Date.now = () => 1000000 + 125000;          // 2 min 5 s later
        userStop(obj, a, web);
        let ends = meshServer.events.filter((e) => /конец/.test(e.msg));
        assert.strictEqual(ends.length, 1);
        assert.strictEqual(ends[0].userid, "user//a");
        assert.match(ends[0].msg, /конец, 2 мин 5 с$/);

        const sid = agent.sent.find((m) => m.pluginaction === "start").sid;
        agentMsg(obj, agent, { pluginaction: "status", sid, state: "error", code: "helper_failed", msg: "boom" });
        ends = meshServer.events.filter((e) => /конец/.test(e.msg));
        assert.strictEqual(ends.length, 2, "a stream ended by the agent is logged for the remaining listener");
        assert.match(ends[1].msg, /\(boom\)$/);
        userStop(obj, b, web);
        assert.strictEqual(meshServer.events.filter((e) => /конец/.test(e.msg)).length, 2, "never logged twice");
    } finally { Date.now = realNow; }
});

// ---------- live settings (reconfigure) ----------

test("the sole listener can change the stream live: new capture, no new consent prompt", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = consentWeb(8);
    const sess = makeUserSession();
    userStart(obj, sess, web, { codecs: ["adpcm", "pcm"], rate: 16000 });
    const sid1 = agentStarts(agent)[0].sid;
    agentMsg(obj, agent, { pluginaction: "status", sid: sid1, state: "started", proto: 3, rate: 16000 });

    obj.serveraction({ pluginaction: "reconfigure", nodeid: NODE, codecs: ["opus", "adpcm", "pcm"], rate: 24000, bitrate: 48 }, sess, web);
    const st2 = agentStarts(agent)[1];
    assert.ok(st2, "capture restarted on the agent");
    assert.notStrictEqual(st2.sid, sid1);
    assert.strictEqual(st2.codec, "opus");
    assert.strictEqual(st2.rate, 24000);
    assert.strictEqual(st2.bitrate, 48);
    assert.strictEqual(st2.consent.prompt, false, "consent already given: not asked again");

    agentMsg(obj, agent, { pluginaction: "chunk", sid: sid1, rate: 16000, d: "T0xE" });
    agentMsg(obj, agent, { pluginaction: "status", sid: st2.sid, state: "started", proto: 3, rate: 24000, codec: "opus" });
    agentMsg(obj, agent, { pluginaction: "chunk", sid: st2.sid, rate: 24000, codec: "opus2", d: "TkVX" });
    assert.deepStrictEqual(sess.ws.sent.filter((m) => m.method === "onChunk").map((m) => m.d), ["TkVX"], "only the new capture is heard");
    assert.strictEqual(meshServer.events.filter((e) => /конец/.test(e.msg)).length, 0, "still listening: no end logged");
});

test("a shared stream is not reconfigured by one of its listeners", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    const a = makeUserSession({ userid: "user//a" });
    userStart(obj, a, web);
    userStart(obj, makeUserSession({ userid: "user//b" }), web);
    obj.serveraction({ pluginaction: "reconfigure", nodeid: NODE, codecs: ["pcm"] }, a, web);
    assert.strictEqual(agentStarts(agent).length, 1, "agent untouched");
    assert.strictEqual(lastStatus(a.ws).code, "shared_stream");
});

test("reconfigure from a session that is not listening is ignored", () => {
    const { obj, meshServer } = loadPlugin();
    const agent = connectAgent(meshServer, NODE);
    const web = makeWeb();
    userStart(obj, makeUserSession({ userid: "user//a" }), web);
    obj.serveraction({ pluginaction: "reconfigure", nodeid: NODE, codecs: ["pcm"] }, makeUserSession({ userid: "user//x" }), web);
    assert.strictEqual(agentStarts(agent).length, 1);
});
