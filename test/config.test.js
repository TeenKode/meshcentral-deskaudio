// Validates the plugin manifest against what MeshCentral's pluginHandler expects:
// required metadata fields, a shortName that matches the folder and main file,
// and the presence of the files the plugin loads at runtime.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));

test("config.json has the fields MeshCentral requires", () => {
    for (const key of ["name", "shortName", "version", "description", "author", "repository", "meshCentralCompat"]) {
        assert.ok(config[key] !== undefined && config[key] !== "", "missing field: " + key);
    }
    assert.strictEqual(typeof config.repository, "object");
    assert.ok(typeof config.repository.url === "string");
});

test("shortName matches the folder and the main module filename", () => {
    assert.strictEqual(config.shortName, "deskaudio");
    assert.ok(fs.existsSync(path.join(DIR, config.shortName + ".js")), "main module present");
});

test("version is a plain semver string", () => {
    assert.match(config.version, /^\d+\.\d+\.\d+$/);
});

test("the files the plugin loads at runtime exist", () => {
    for (const rel of [
        "deskaudio.js",
        "modules_meshcore/deskaudio.js",
        "helpers/win-loopback.cs",
        "helpers/win-loopback-native.cpp",
        "helpers/deskaudio-x64.exe",
        "helpers/deskaudio-x86.exe",
        "helpers/linux-capture.sh"
    ]) {
        assert.ok(fs.existsSync(path.join(DIR, rel)), "missing: " + rel);
    }
});

test("the server module exports the deskaudio factory with the right browser exports", () => {
    const mod = require(path.join(DIR, "deskaudio.js"));
    assert.strictEqual(typeof mod.deskaudio, "function");
    const obj = mod.deskaudio({ parent: { webserver: {} } });
    for (const name of ["onDeviceRefreshEnd", "render", "toggle", "start", "stop", "onChunk", "onStatus"]) {
        assert.ok(obj.exports.indexOf(name) >= 0, "export missing from obj.exports: " + name);
        assert.strictEqual(typeof obj[name], "function", "export not implemented: " + name);
    }
    assert.strictEqual(typeof obj.serveraction, "function");
});

test("the agent module exports consoleaction", () => {
    const mod = require(path.join(DIR, "modules_meshcore", "deskaudio.js"));
    assert.strictEqual(typeof mod.consoleaction, "function");
});
