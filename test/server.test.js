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
    assert.ok(typeof cmd.source === "string" && cmd.source.length > 0, "windows helper source (fallback) included");
    assert.ok(typeof cmd.ver === "string" && cmd.ver.length > 0, "helper version hash included");
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
