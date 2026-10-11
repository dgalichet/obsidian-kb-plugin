import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Keep the production plugin lifecycle and publisher. Replace only external
// effects and panel UI: this test must never read a real vault or start a process.
const substitutes = {
  "./client": `export class ObsidianKbClient {
    constructor(url) {
      this.url = url; this.healthy = true; this.healthCalls = 0;
      this.updates = []; this.cleared = []; this.shutdowns = 0;
      __lifecycle.clients.push(this);
    }
    async health() {
      this.healthCalls += 1;
      if (!this.healthy) throw new Error("Service offline");
      return {};
    }
    async publishWorkspaceContext(update) { this.updates.push(update); }
    async clearWorkspaceContext(identity) { this.cleared.push(identity); }
    async shutdown() { this.shutdowns += 1; }
  }`,
  "./process": `export class ObsidianKbProcessManager {
    constructor(app, settings) {
      this.settings = settings; this.starts = 0; this.stops = 0;
      this.isManagedProcessRunning = false;
    }
    resolveConfigPath() { return "/fixture/config.toml"; }
    async startServe() {
      this.starts += 1;
      this.isManagedProcessRunning = true;
      __lifecycle.clients.at(-1).healthy = true;
    }
    async stopServe() { this.stops += 1; this.isManagedProcessRunning = false; }
    stopServeNow() { this.stops += 1; }
  }`,
  "./kb-config": `export async function readKbConfigDraft() { return null; }
    export async function writeKbConfigDraft() { throw new Error("Unexpected config write"); }`,
  "./settings": `export class ObsidianKbSettingTab {}`,
  "./view": `export const VIEW_TYPE_OBSIDIAN_KB = "obsidian-kb-view";
    export class ObsidianKbView {
      constructor() { throw new Error("The panel must remain closed in this test"); }
    }`,
};
const bundle = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["obsidian"],
  write: false,
  plugins: [{
    name: "lifecycle-fixtures",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(client|process|kb-config|settings|view)$/ }, (args) => ({
        path: args.path, namespace: "lifecycle-fixtures",
      }));
      builder.onLoad({ filter: /.*/, namespace: "lifecycle-fixtures" }, (args) => ({
        contents: substitutes[args.path], loader: "js",
      }));
    },
  }],
});

class EventSource {
  subscriptions = new Set();
  on(name, callback) {
    const ref = { source: this, name, callback };
    this.subscriptions.add(ref);
    return ref;
  }
  offref(ref) { this.subscriptions.delete(ref); }
  emit(name) {
    for (const ref of this.subscriptions) {
      if (ref.name === name) ref.callback();
    }
  }
}
class FileSystemAdapter {
  getBasePath() { return "/fixture/actual-vault"; }
}
class MarkdownView {
  constructor(file) { this.file = file; }
}
class PluginHost {
  eventRefs = [];
  viewFactories = [];
  async loadData() { return this.savedData; }
  registerEvent(ref) { this.eventRefs.push(ref); }
  registerView(...args) { this.viewFactories.push(args); }
  registerHoverLinkSource() {}
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  // Obsidian removes registerEvent subscriptions as part of unloading a plugin.
  unload() {
    this.onunload();
    for (const ref of this.eventRefs) ref.source.offref(ref);
  }
}

const timers = new Map();
const windowListeners = new Map();
let timerId = 0;
const lifecycle = { clients: [] };
const module = { exports: {} };
const require = createRequire(import.meta.url);
const sandbox = {
  module,
  exports: module.exports,
  __lifecycle: lifecycle,
  require: (name) => name === "obsidian" ? {
    Plugin: PluginHost,
    FileSystemAdapter,
    MarkdownView,
    Platform: { isDesktopApp: true, isWin: false },
    Notice: class { constructor(message) { assert.fail(`Unexpected notice: ${message}`); } },
    addIcon() {},
  } : require(name),
  console,
  setTimeout(callback, delay) {
    const id = ++timerId;
    timers.set(id, { callback, delay, interval: false });
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
  setInterval(callback, delay) {
    const id = ++timerId;
    timers.set(id, { callback, delay, interval: true });
    return id;
  },
  clearInterval: (id) => timers.delete(id),
  addEventListener(name, callback) {
    if (!windowListeners.has(name)) windowListeners.set(name, new Set());
    windowListeners.get(name).add(callback);
  },
  removeEventListener(name, callback) { windowListeners.get(name)?.delete(callback); },
};
sandbox.window = sandbox;
runInNewContext(bundle.outputFiles[0].text, sandbox);
const ActualPlugin = module.exports.default;
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function tick(delay) {
  for (const [id, timer] of [...timers]) {
    if (timer.delay !== delay) continue;
    if (!timer.interval) timers.delete(id);
    timer.callback();
  }
  await settle();
}

const workspace = new EventSource();
const vault = new EventSource();
const layoutReady = [];
let activeFile;
let leaves;
function openNote(path) {
  activeFile = { path, extension: "md", basename: path.split("/").at(-1).slice(0, -3) };
  leaves = [{ view: new MarkdownView(activeFile) }];
}
openNote("Projects/First.md");
Object.assign(workspace, {
  onLayoutReady(callback) { layoutReady.push(callback); },
  getActiveFile: () => activeFile,
  getLeavesOfType(type) {
    assert.equal(type, "markdown", "The plugin must not depend on an open OKB panel");
    return leaves;
  },
});
vault.adapter = new FileSystemAdapter();
vault.read = () => assert.fail("Current-note publication must not read vault content");
const plugin = new ActualPlugin();
plugin.app = { workspace, vault };
plugin.savedData = { autoStart: false, vaultPath: "/fixture/retrieval-override" };
await plugin.onload();

assert.deepEqual(plugin.eventRefs.map((ref) => ref.name), [
  "file-open", "active-leaf-change", "layout-change", "rename", "delete",
]);
assert.equal(plugin.viewFactories.length, 1, "Registering the panel must not open it");
assert.equal(layoutReady.length, 1);
assert.equal(lifecycle.clients.length, 1);
const firstClient = lifecycle.clients[0];
assert.equal(firstClient.updates.length, 0, "Publish only after workspace layout is ready");
layoutReady[0]();
await tick(150);
assert.equal(firstClient.updates.length, 1);
assert.equal(firstClient.updates[0].vault_path, "/fixture/actual-vault");
assert.equal(plugin.settings.vaultPath, "/fixture/retrieval-override");
assert.deepEqual(plain(firstClient.updates[0].note), { path: "Projects/First.md", title: "First" });

// Every registered navigation/vault callback must reach the real publisher,
// including closing the final note without opening another one.
for (const [source, event, path] of [
  [workspace, "file-open", "Second.md"],
  [workspace, "active-leaf-change", "Third.md"],
  [vault, "rename", "Renamed.md"],
]) {
  const previous = firstClient.updates.length;
  openNote(path);
  source.emit(event);
  await tick(150);
  assert.equal(firstClient.updates.length, previous + 1, event);
  assert.equal(firstClient.updates.at(-1).note.path, path, event);
}
leaves = [];
workspace.emit("layout-change");
await tick(150);
assert.equal(firstClient.updates.at(-1).note, null);
openNote("Deleted.md");
workspace.emit("file-open");
await tick(150);
leaves = [];
vault.emit("delete");
await tick(150);
assert.equal(firstClient.updates.at(-1).note, null);

// Service readiness and endpoint changes republish without requiring navigation.
openNote("Current.md");
let previous = firstClient.updates.length;
await plugin.ensureService();
await settle();
assert.equal(firstClient.updates.length, previous + 1);
assert.equal(firstClient.updates.at(-1).note.path, "Current.md");
assert.equal(plugin.processManager.starts, 0);
firstClient.healthy = false;
previous = firstClient.updates.length;
await plugin.ensureService();
await settle();
assert.equal(plugin.processManager.starts, 1);
assert.equal(firstClient.updates.length, previous + 1, "Republish when a started service becomes ready");
plugin.settings.port += 1;
plugin.recreateClient();
await settle();
const replacementClient = lifecycle.clients.at(-1);
assert.notEqual(replacementClient, firstClient);
assert.equal(firstClient.cleared.length, 1, "The old endpoint must lose the session");
assert.equal(replacementClient.updates.length, 1);
assert.equal(replacementClient.updates[0].session_id, firstClient.updates[0].session_id);
assert.equal(replacementClient.updates[0].vault_path, "/fixture/actual-vault");
assert.equal(replacementClient.updates[0].note.path, "Current.md");

plugin.unload();
await settle();
assert.equal(replacementClient.cleared.length, 1, "Unloading must remove current-note context");
assert.equal(replacementClient.shutdowns, 1);
assert.equal(plugin.processManager.stops, 1);
assert.equal(timers.size, 0, "No publisher heartbeat/debounce may survive unloading");
assert.equal(workspace.subscriptions.size, 0);
assert.equal(vault.subscriptions.size, 0);
assert.ok([...windowListeners.values()].every((listeners) => listeners.size === 0));
// A layout callback already queued before unload cannot restart publication.
layoutReady[0]();
workspace.emit("file-open");
await settle();
assert.equal(timers.size, 0);
assert.equal(replacementClient.updates.length, 1);
console.log("Current note integration with actual plugin startup, events, reconnect, and unload passed.");
