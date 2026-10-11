import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export * from "./src/current-note";
      export { ObsidianKbClient } from "./src/client";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["obsidian"],
  write: false,
});
const require = createRequire(import.meta.url);
const timers = new Map();
let timerId = 0;
class MarkdownView {
  constructor(file) { this.file = file; }
}
const module = { exports: {} };
const sandbox = {
  module,
  exports: module.exports,
  require: (name) => name === "obsidian"
    ? { MarkdownView, requestUrl: () => { throw new Error("Unexpected vault read"); } }
    : require(name),
  Buffer,
  URL,
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
};
sandbox.window = sandbox;
runInNewContext(bundle.outputFiles[0].text, sandbox);
const { currentNoteIdentity, CurrentNotePublisher, ObsidianKbClient } = module.exports;
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
function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}
function transport() {
  return {
    updates: [],
    cleared: [],
    async publishWorkspaceContext(context) { this.updates.push(plain(context)); },
    async clearWorkspaceContext(identity) { this.cleared.push(plain(identity)); },
  };
}

// Sidebars retain the last file, but closed notes and non-Markdown files
// cannot become editable agent targets. No note content is read.
const first = { path: "Projects/First.md", basename: "First", extension: "md" };
let activeFile = first;
let openLeaves = [{ view: new MarkdownView(first) }];
const app = { workspace: {
  getActiveFile: () => activeFile,
  getLeavesOfType: () => openLeaves,
} };
assert.deepEqual(plain(currentNoteIdentity(app)), { path: first.path, title: "First" });
assert.deepEqual(plain(currentNoteIdentity(app)), { path: first.path, title: "First" });
openLeaves = [];
assert.equal(currentNoteIdentity(app), null);
activeFile = { ...first, extension: "pdf" };
assert.equal(currentNoteIdentity(app), null);
activeFile = null;
assert.equal(currentNoteIdentity(app), null);

let note = { path: first.path, title: "First" };
let client = transport();
const originalClient = client;
const publisher = new CurrentNotePublisher("/vault", () => note, () => client);
publisher.start();
publisher.start();
await tick(150);
assert.equal(client.updates.length, 1);
assert.equal(client.updates[0].context_version, 1);
assert.equal(client.updates[0].vault_path, "/vault");
assert.match(client.updates[0].session_id, /^[0-9a-f-]{36}$/);
assert.equal([...timers.values()].filter((timer) => timer.interval).length, 1);
const sessionId = client.updates[0].session_id;
await tick(20_000);
assert.equal(client.updates[1].context_version, 1);

note = { path: "Second.md", title: "Second" };
publisher.refresh();
note = { path: "Third.md", title: "Third" };
publisher.refresh();
await tick(150);
assert.equal(client.updates.length, 3);
assert.equal(client.updates[2].note.path, "Third.md");
assert.equal(client.updates[2].context_version, 3);
assert.equal(client.updates[2].session_id, sessionId);
note = { path: "Renamed.md", title: "Renamed" };
publisher.refresh(true);
await settle();
assert.equal(client.updates.at(-1).context_version, 4);
note = null;
publisher.refresh(true);
await settle();
assert.equal(client.updates.at(-1).note, null);
assert.equal(client.updates.at(-1).context_version, 5);

// Reconnect after failures and service restarts without navigation.
client.publishWorkspaceContext = async () => { throw new Error("Service offline"); };
publisher.refresh(true);
await settle();
client.publishWorkspaceContext = transport().publishWorkspaceContext;
await tick(20_000);
assert.equal(client.updates.at(-1).context_version, 5);

// Changing the service clears the old endpoint before publishing on the new one.
client = transport();
publisher.refresh(true);
await settle();
assert.equal(originalClient.cleared.length, 1);
assert.equal(client.updates.length, 1);
assert.equal(client.updates[0].session_id, sessionId);
await publisher.stop();
assert.equal(client.cleared.length, 1);
assert.equal(timers.size, 0);
publisher.refresh(true);
publisher.start();
assert.equal(timers.size, 0);

// Slow requests remain ordered; a shutdown cannot be followed by a late POST.
note = { path: "First.md", title: "First" };
const gate = deferred();
const actions = [];
client = {
  async publishWorkspaceContext(update) {
    actions.push(["publish", update.note?.path]);
    if (actions.length === 1) await gate.promise;
  },
  async clearWorkspaceContext() { actions.push(["clear"]); },
};
const slow = new CurrentNotePublisher("/vault", () => note, () => client);
slow.refresh(true);
note = { path: "Latest.md", title: "Latest" };
slow.refresh(true);
assert.deepEqual(actions, [["publish", "First.md"]]);
gate.resolve();
await settle();
assert.deepEqual(actions, [["publish", "First.md"], ["publish", "Latest.md"]]);
await slow.stop();
assert.equal(actions.at(-1)[0], "clear");

const stopGate = deferred();
actions.length = 0;
client.publishWorkspaceContext = async () => {
  actions.push(["publish"]);
  await stopGate.promise;
};
const stopping = new CurrentNotePublisher("/vault", () => note, () => client);
stopping.refresh(true);
stopping.refresh(true);
const stopped = stopping.stop();
assert.deepEqual(actions, [["publish"]]);
stopGate.resolve();
await stopped;
assert.deepEqual(actions, [["publish"], ["clear"]]);

// Exercise the real transport against a local HTTP endpoint.
const requests = [];
let responseStatus = 200;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ method: request.method, path: request.url, body: JSON.parse(body) });
  response.writeHead(responseStatus, { "Content-Type": "application/json" });
  response.end("{}");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const httpClient = new ObsidianKbClient(`http://127.0.0.1:${server.address().port}`);
  const update = { vault_path: "/vault", session_id: sessionId, context_version: 1, note };
  await httpClient.publishWorkspaceContext(update);
  await httpClient.clearWorkspaceContext({ vault_path: "/vault", session_id: sessionId });
  assert.deepEqual(requests, [
    { method: "POST", path: "/workspace/context", body: update },
    { method: "DELETE", path: "/workspace/context", body: { vault_path: "/vault", session_id: sessionId } },
  ]);
  const localhostClient = new ObsidianKbClient(`http://localhost:${server.address().port}`);
  await localhostClient.publishWorkspaceContext(update);
  assert.equal(requests.at(-1).method, "POST");
  responseStatus = 404;
  await assert.rejects(httpClient.publishWorkspaceContext(update), /HTTP 404/);
  const remote = new ObsidianKbClient("http://example.com:27124");
  await assert.rejects(remote.publishWorkspaceContext(update), /loopback/);

  // Trigger the actual client deadline against an endpoint that stays silent.
  server.removeAllListeners("request");
  server.on("request", () => {});
  const blocked = httpClient.publishWorkspaceContext(update);
  const rejected = assert.rejects(blocked, /timed out/);
  await settle();
  await tick(3000);
  await rejected;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
assert.equal(timers.size, 0);
console.log("Current note identity, publication lifecycle, and local HTTP tests passed.");
