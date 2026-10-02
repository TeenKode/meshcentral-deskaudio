// Interface language: Russian or English following MeshCentral's page language
// (<html lang>) or the browser's; server/agent errors are translated by code.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require("./helpers");

function withLang(lang, fn) {
    const { obj } = loadPlugin();
    delete obj._langCache;
    const saved = { document: global.document, pluginHandler: global.pluginHandler };
    global.pluginHandler = { deskaudio: obj };
    global.document = { documentElement: { lang }, getElementById: () => null };
    try { return fn(obj); } finally { Object.assign(global, saved); }
}

test("an English MeshCentral page gets an English interface", () => {
    withLang("en", (obj) => {
        assert.strictEqual(obj._t("tab"), "Audio");
        assert.strictEqual(obj._t("desk_btn"), "Audio");
        assert.strictEqual(obj._t("kbps", 32), "32 kbit/s");
        assert.strictEqual(obj._statusText({ code: "offline", msg: "Устройство не в сети" }), "The device is offline");
    });
});

test("a Russian page gets Russian; unknown codes fall back to the sent text", () => {
    withLang("ru-RU", (obj) => {
        assert.strictEqual(obj._t("tab"), "Звук");
        assert.strictEqual(obj._t("l_first", "Opus", 48000), "первый звук: Opus, 48000 Гц");
        assert.strictEqual(obj._statusText({ code: "helper_failed", msg: "audio device unavailable: Initialize failed (0x88890008)\n" }),
            "audio device unavailable: Initialize failed (0x88890008)");
    });
});

test("every error code the server or agent sends has both translations", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "deskaudio.js"), "utf8") +
                fs.readFileSync(path.join(__dirname, "..", "modules_meshcore", "deskaudio.js"), "utf8");
    const codes = new Set();
    for (const m of src.matchAll(/sendStatus\([^,]+,[^,]+,\s*'(?:error|stopped|info)',\s*'([a-z_]+)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/state: '(?:error|stopped)', code: '([a-z_]+)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/fail\([^)]*?,\s*'([a-z_]+)'\)/g)) codes.add(m[1]);
    // Diagnostic codes whose text is the helper's own message (shown as is).
    for (const c of ["helper_failed", "helper_exit", "stopped"]) codes.delete(c);
    assert.ok(codes.size >= 10, "found the codes: " + [...codes].join(", "));
    for (const lang of ["ru", "en"]) withLang(lang, (obj) => {
        for (const c of codes) assert.ok(obj._t("code_" + c), lang + ": no translation for code " + c);
    });
});

test("the tab is built in the page language", () => {
    withLang("en", (obj) => {
        let html = "";
        global.QH = (id, h) => { html = h; };
        global.pluginHandler.registerPluginTab = (t) => { assert.strictEqual(t.tabTitle, "Audio"); };
        global.localStorage = { getItem: () => null, setItem() {} };
        global.currentNode = { _id: "node//pc1" };
        try {
            obj.onDeviceRefreshEnd();
            assert.match(html, /Desktop audio/);
            assert.match(html, /Don't send silence/);
            assert.doesNotMatch(html, /[А-Яа-яЁё]/, "no Russian left in the English tab");
        } finally { delete global.QH; delete global.localStorage; delete global.currentNode; }
    });
});
