// Shared mocks for exercising the server side of the Desktop Audio plugin.
//
// The plugin's server module exports a factory: module.exports.deskaudio(parent).
// `parent` is the pluginHandler; `parent.parent` is the MeshCentral server.
// Each call to the factory returns a fresh instance with its own closure state
// (listeners, keepalive timer), so tests get full isolation without touching the
// require cache.
"use strict";

const path = require("path");

const PLUGIN_SERVER = path.join(__dirname, "..", "deskaudio.js");
const MESHRIGHT_REMOTECONTROL = 0x00000008;

function makeMeshServer() {
    return {
        events: [],
        config: { domains: {} },
        webserver: { wsagents: {} },
        debug() {},
        DispatchEvent(ids, source, event) { this.events.push(event); }
    };
}

// A minimal stand-in for a MeshCentral websocket connection.
function makeWs() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        sent: [],
        _closeCbs: [],
        send(str) { this.sent.push(JSON.parse(str)); },
        on(ev, cb) { if (ev === "close") this._closeCbs.push(cb); },
        triggerClose() { this._closeCbs.forEach((cb) => cb()); }
    };
}

// A browser user session as MeshCentral passes it to serveraction (the `obj`
// argument on the user path): it carries `.user` and `.ws`.
function makeUserSession(opts) {
    opts = opts || {};
    const ws = opts.ws || makeWs();
    return {
        user: { _id: opts.userid || "user//alice", name: opts.name || "alice", domain: "" },
        domain: { id: "" },
        ws
    };
}

// An authenticated agent connection (the `obj` argument on the agent path):
// MeshCentral stamps dbNodeKey from the agent's own identity, never the message.
function makeAgent(nodeid) {
    return {
        dbNodeKey: nodeid,
        sent: [],
        send(str) { this.sent.push(JSON.parse(str)); }
    };
}

// The `grandparent` (web server) argument on the user path. The plugin calls
// web.GetNodeWithRights(domain, user, nodeid, cb). We let tests dictate the
// answer with node/rights fields.
function makeWeb(opts) {
    opts = opts || {};
    return {
        node: opts.node === undefined
            ? { _id: "node//pc1", meshid: "mesh//m1", domain: "" }
            : opts.node,
        rights: opts.rights === undefined ? MESHRIGHT_REMOTECONTROL : opts.rights,
        GetNodeWithRights(domain, user, nodeid, cb) { cb(this.node, this.rights); }
    };
}

function loadPlugin() {
    delete require.cache[require.resolve(PLUGIN_SERVER)];
    const mod = require(PLUGIN_SERVER);
    const meshServer = makeMeshServer();
    const obj = mod.deskaudio({ parent: meshServer });
    // The browser UI follows the page/browser language; tests pin Russian
    // (Node 22 has a navigator.language, Node 20 does not).
    obj._langCache = "ru";
    return { obj, meshServer };
}

// Connect an agent for `nodeid` so agentOf() can find it.
function connectAgent(meshServer, nodeid) {
    const agent = makeAgent(nodeid);
    meshServer.webserver.wsagents[nodeid] = agent;
    return agent;
}

module.exports = {
    MESHRIGHT_REMOTECONTROL,
    makeMeshServer,
    makeWs,
    makeUserSession,
    makeAgent,
    makeWeb,
    loadPlugin,
    connectAgent
};
