// The listening bar (consent flag "connection toolbar"): the agent side shows
// MeshAgent's notifybar-desktop, and the browser side passes the open desktop
// session's consent options. Runs on any platform: the agent modules are mocked.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const EventEmitter = require("node:events");
const Module = require("node:module");
const { loadPlugin } = require("./helpers");

const AGENT = path.join(__dirname, "..", "modules_meshcore", "deskaudio.js");

// Fresh agent module with notifybar-desktop / user-sessions mocked.
function withAgent(opts, fn) {
    const bars = [];
    const sent = [];
    const realLoad = Module._load;
    Module._load = function (req) {
        if (req === "notifybar-desktop") {
            if (opts.noBar) throw new Error("no such module");
            return function (title, tsid, colors) {
                const b = new EventEmitter();
                b.title = title; b.tsid = tsid; b.colors = colors; b.closed = false;
                b.close = () => { b.closed = true; };
                bars.push(b);
                return b;
            };
        }
        if (req === "user-sessions") return { consoleUid: () => 3 };
        if (req === "MeshAgent") return { SendCommand(o) { sent.push(JSON.parse(JSON.stringify(o))); } };
        return realLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(AGENT)];
    try { return fn({ ag: require(AGENT), bars, sent }); } finally { Module._load = realLoad; }
}

test("the agent shows the bar in the console session and replaces it when the text changes", () => {
    withAgent({}, ({ ag, bars }) => {
        ag._showBar("Desktop audio is being listened to by: alice");
        assert.strictEqual(bars.length, 1);
        assert.strictEqual(bars[0].title, "Desktop audio is being listened to by: alice");
        assert.strictEqual(bars[0].tsid, 3, "shown in the console session");
        assert.ok(bars[0].colors && bars[0].colors.background, "MeshCentral's bar colours");

        ag._showBar("Desktop audio is being listened to by: alice");
        assert.strictEqual(bars.length, 1, "same text: the bar is kept");

        ag._showBar("Desktop audio is being listened to by: alice, bob");
        assert.strictEqual(bars.length, 2);
        assert.ok(bars[0].closed, "the old bar is closed");
        assert.strictEqual(bars[0].listenerCount("close"), 0, "closing it ourselves does not count as the user closing it");

        ag._showBar("");
        assert.ok(bars[1].closed, "empty text removes the bar");
    });
});

test("closing the bar on the remote computer stops listening and tells the server", () => {
    withAgent({}, ({ ag, bars, sent }) => {
        ag._showBar("Desktop audio is being listened to by: alice");
        bars[0].emit("close");
        const st = sent.find((m) => m.pluginaction === "status");
        assert.ok(st, "a status is sent");
        assert.strictEqual(st.state, "stopped");
        assert.strictEqual(st.code, "bar_closed");
    });
});

test("without notifybar-desktop the capture goes on and the browser log says why", () => {
    withAgent({ noBar: true }, ({ ag, sent }) => {
        assert.doesNotThrow(() => ag._showBar("x"));
        assert.ok(sent.some((m) => m.pluginaction === "log" && /listening bar not available/.test(m.msg)));
        assert.ok(!sent.some((m) => m.pluginaction === "status"), "listening is not stopped");
    });
});

test("a user name cannot break out of the bar's script string", () => {
    withAgent({}, ({ ag }) => {
        const t = ag._barSafe("x'); require('child_process').execFile('calc'); ('\\\n\u2028");
        assert.doesNotMatch(t, /['\\\n\r\u2028\u2029]/);
        assert.ok(ag._barSafe("a".repeat(500)).length <= 200, "length capped");
        assert.strictEqual(ag._barSafe("Алиса, bob"), "Алиса, bob", "ordinary names are kept");
    });
});

// ---------- browser: the desktop session's consent options ----------

function withDesktop(desktop, desktopNode, fn) {
    const saved = { desktop: global.desktop, desktopNode: global.desktopNode, pluginHandler: global.pluginHandler };
    const { obj } = loadPlugin();
    global.pluginHandler = { deskaudio: obj };
    global.desktop = desktop;
    global.desktopNode = desktopNode;
    try { return fn(obj); } finally { Object.assign(global, saved); }
}

test("the browser reads the Connect-menu consent of this device's open desktop session", () => {
    const node = { _id: "node//pc1" };
    withDesktop({ State: 3, options: { consent: 0x40 } }, node, (obj) => {
        assert.strictEqual(obj._deskConsent("node//pc1"), 0x40, "Privacy Bar");
        assert.strictEqual(obj._deskConsent("node//other"), 0, "another device's desktop does not count");
    });
    withDesktop({ State: 3, options: { consent: 0x08 + 0x40 + 0x1000 } }, node, (obj) => {
        assert.strictEqual(obj._deskConsent("node//pc1"), 0x48, "only the desktop consent bits");
    });
    withDesktop({ State: 0, options: { consent: 0x40 } }, node, (obj) => {
        assert.strictEqual(obj._deskConsent("node//pc1"), 0, "a closed desktop does not count");
    });
    withDesktop(null, null, (obj) => {
        assert.strictEqual(obj._deskConsent("node//pc1"), 0, "no desktop");
    });
});
