// Tests for the browser UI wiring in onDeviceRefreshEnd: the auto-listen hook on
// the desktop Connect/Disconnect button, with a minimal DOM stand-in.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./helpers");

function el(id) {
    return {
        id, value: "", style: {}, checked: false, disabled: false, _listeners: {},
        addEventListener(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); },
        click() { (this._listeners.click || []).forEach((cb) => cb()); }
    };
}

// Install the page globals the plugin expects, run `fn`, restore.
function withPage(obj, opts, fn) {
    const names = ["document", "pluginHandler", "QH", "localStorage", "currentNode", "desktop", "setTimeout"];
    const saved = {};
    names.forEach((n) => { saved[n] = global[n]; });
    const button = el("connectbutton1");
    const els = { connectbutton1: button };
    global.document = { getElementById: (id) => els[id] || null, createElement: () => el("x") };
    global.pluginHandler = { deskaudio: obj, registerPluginTab() {} };
    global.QH = () => {};
    const store = Object.assign({}, opts.storage);
    global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
    global.currentNode = { _id: "node//pc1" };
    global.desktop = null;
    global.setTimeout = (cb) => { cb(); return 0; };   // run the 300 ms deferral immediately
    try { return fn({ button }); } finally { names.forEach((n) => { global[n] = saved[n]; }); }
}

function setup(storage) {
    const { obj } = loadPlugin();
    let starts = 0;
    obj.start = () => { starts++; };
    return { obj, starts: () => starts, storage };
}

test("auto-listen starts audio when Connect opens a desktop session", () => {
    const t = setup();
    withPage(t.obj, { storage: { deskaudio_auto: "1" } }, ({ button }) => {
        t.obj.onDeviceRefreshEnd();
        global.desktop = { State: 1 };          // MeshCentral created the session
        button.click();
    });
    assert.strictEqual(t.starts(), 1);
});

test("auto-listen does not start audio when the button disconnected the desktop", () => {
    const t = setup();
    withPage(t.obj, { storage: { deskaudio_auto: "1" } }, ({ button }) => {
        t.obj.onDeviceRefreshEnd();
        global.desktop = null;                  // MeshCentral tore the session down
        button.click();
        global.desktop = { State: 0 };
        button.click();
    });
    assert.strictEqual(t.starts(), 0);
});

test("auto-listen is off by default", () => {
    const t = setup();
    withPage(t.obj, { storage: {} }, ({ button }) => {
        t.obj.onDeviceRefreshEnd();
        global.desktop = { State: 3 };
        button.click();
    });
    assert.strictEqual(t.starts(), 0);
});

test("the desktop audio button copies the class of MeshCentral's Actions button", () => {
    const { obj } = loadPlugin();
    const saved = {};
    ["document", "pluginHandler", "QH", "localStorage", "currentNode"].forEach((n) => { saved[n] = global[n]; });
    const slot = { children: [], appendChild(c) { this.children.push(c); } };
    const actions = { className: "btn btn-primary btn-sm me-1" };
    global.document = {
        getElementById: (id) => ({ desktopCustomUiButtons: slot, deskActionsBtn: actions,
                                   da_deskbtn: slot.children[0] || null })[id] || null,
        createElement: () => ({ style: {} })
    };
    global.pluginHandler = { deskaudio: obj, registerPluginTab() {} };
    global.QH = () => {};
    global.localStorage = { getItem: () => null, setItem() {} };
    global.currentNode = { _id: "node//pc1" };
    try {
        obj.onDeviceRefreshEnd();
        const b = slot.children[0];
        assert.ok(b, "button added to the custom UI slot");
        assert.strictEqual(b.className, "btn btn-primary btn-sm me-1", "same look as Actions/Settings");
        assert.strictEqual(b.value, "Звук", "plain label like the other buttons");
        assert.strictEqual(b.onkeydown(), false, "keys are not swallowed by the button");
    } finally { Object.keys(saved).forEach((n) => { global[n] = saved[n]; }); }
});

test("the log window shows local and agent lines, newest last, capped at 300", () => {
    const { obj } = loadPlugin();
    const saved = { document: global.document, pluginHandler: global.pluginHandler };
    const pre = { textContent: "", scrollTop: 0, scrollHeight: 99 };
    global.document = { getElementById: (id) => (id === "da_log" ? pre : null) };
    global.pluginHandler = { deskaudio: obj };
    try {
        obj._s = { nodeid: "node//pc1", active: true };
        obj.log("старт");
        obj.onLog({ nodeid: "node//pc1", msg: "capture: 48000 Hz" });
        obj.onLog({ nodeid: "node//other", msg: "чужое" });
        const lines = pre.textContent.split("\n");
        assert.strictEqual(lines.length, 2);
        assert.match(lines[0], /^\d\d:\d\d:\d\d  старт$/);
        assert.match(lines[1], /агент: capture: 48000 Hz$/);
        assert.strictEqual(pre.scrollTop, 99, "scrolled to the newest line");
        for (let i = 0; i < 400; i++) obj.log("x" + i);
        assert.strictEqual(obj._log.length, 300);
        obj.clearLog();
        assert.strictEqual(pre.textContent, "");
    } finally { Object.assign(global, saved); }
});

test("the stats line reports bitrate and player state every 5 s", () => {
    const { obj } = loadPlugin();
    const saved = { pluginHandler: global.pluginHandler, document: global.document };
    global.pluginHandler = { deskaudio: obj };
    global.document = { getElementById: () => null };
    const realNow = Date.now;
    try {
        obj._log = [];
        obj._s = { active: true, gotAudio: true, rxBytes: 25000, rxMsgs: 125, statsAt: 1000,
                   player: { fill: 0.152, underruns: 1, skips: 0 } };
        Date.now = () => 3000;                 // 2 s: too early
        obj._stats();
        assert.strictEqual(obj._log.length, 0);
        Date.now = () => 6000;                 // 5 s
        obj._stats();
        assert.match(obj._log[0], /поток: 40 кбит\/с, 25 сообщ\.\/с, в буфере 152 мс, опустошений 1, сбросов 0/);
    } finally { Date.now = realNow; Object.assign(global, saved); }
});
