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
