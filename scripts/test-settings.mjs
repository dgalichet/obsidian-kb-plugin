import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Exercise the actual plugin callbacks with two API hosts. The legacy host
// intentionally has no declarative methods or SettingGroup class.
const result = await build({
  stdin: {
    contents: `export { default as Plugin } from "./src/main";
      export { ObsidianKbSettingTab as SettingTab } from "./src/settings";`,
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
const expectedNames = [
  "Setup assistant", "obsidian-kb binary", "Configuration file", "Index directory",
  "Vault path", "Initialize vault config", "Host", "Port",
  "Start service automatically", "Preload embedder", "Service process", "Doctor",
  "Default search mode", "Default result count", "Lexical candidate count",
  "Semantic candidate count", "Include chunk text", "Use graph expansion by default",
  "Graph expansion weight", "Graph expansion depth", "Graph max neighbors",
  "Exclude headings from index", "Index PDF attachments", "Maximum PDF size",
  "Apply search and indexing config",
];

class Element {
  children = [];
  rows = [];
  dataset = {};
  classes = new Set();
  listeners = new Map();
  constructor(options = {}) {
    this.text = options.text ?? "";
  }
  empty() { this.children = []; this.rows = []; }
  createEl(tag, options) {
    const element = new Element(options);
    element.tag = tag;
    this.children.push(element);
    return element;
  }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  setText(text) { this.text = text; }
  removeClass(cls) { this.classes.delete(cls); }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  find(text, tag) {
    if (this.text === text && (!tag || this.tag === tag)) return this;
    for (const child of this.children) {
      const match = child.find(text, tag);
      if (match) return match;
    }
  }
  async click() {
    await this.listeners.get("click")?.();
    // Setup assistant event handlers dispatch asynchronous work with void.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class Control {
  inputEl = {};
  options = {};
  setValue(value) { this.value = value; return this; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  onChange(callback) { this.change = callback; return this; }
  addOption(value, label) { this.options[value] = label; return this; }
  addOptions(options) { Object.assign(this.options, options); return this; }
  setButtonText(text) { this.text = text; return this; }
  setCta() { this.cta = true; return this; }
  onClick(callback) { this.click = callback; return this; }
}

class Setting {
  controls = [];
  constructor(container) {
    this.settingEl = container.createDiv();
    container.rows.push(this);
  }
  setName(name) { this.name = name; return this; }
  setDesc(desc) { this.desc = desc; return this; }
  setHeading() { this.heading = true; return this; }
  add(type, callback) {
    const control = new Control();
    control.type = type;
    this.controls.push(control);
    callback(control);
    return this;
  }
  addText(callback) { return this.add("text", callback); }
  addTextArea(callback) { return this.add("textarea", callback); }
  addToggle(callback) { return this.add("toggle", callback); }
  addDropdown(callback) { return this.add("dropdown", callback); }
  addButton(callback) { return this.add("button", callback); }
}

function loadPlugin(modern) {
  const notices = [];
  const copied = [];
  class Plugin {
    async loadData() { return this.savedData; }
    async saveData(data) { this.savedData = structuredClone(data); this.saves = (this.saves ?? 0) + 1; }
  }
  class LegacySettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = new Element();
    }
  }
  class ModernSettingTab extends LegacySettingTab {
    getControlValue(key) { return this.plugin.settings[key]; }
    async setControlValue(key, value) {
      this.plugin.settings[key] = value;
      await this.plugin.saveData(this.plugin.settings);
    }
  }
  const obsidian = {
    Plugin,
    PluginSettingTab: modern ? ModernSettingTab : LegacySettingTab,
    Setting,
    ItemView: class {},
    HoverPopover: class {},
    Platform: { isWin: false },
    Notice: class { constructor(message) { notices.push(message); } },
  };
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (name) => name === "obsidian" ? obsidian : require(name),
    console,
    Error,
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
  });
  return { ...module.exports, notices, copied };
}

function renderModern(tab, items) {
  tab.containerEl.empty();
  for (const item of items) {
    if (item.type === "group") {
      new Setting(tab.containerEl).setName(item.heading).setHeading();
      renderModernRows(tab, item.items);
    } else {
      renderModernRows(tab, [item]);
    }
  }
}

function renderModernRows(tab, rows) {
  for (const row of rows) {
    const setting = new Setting(tab.containerEl).setName(row.name).setDesc(row.desc ?? "");
    if (row.render) {
      row.render(setting);
    } else {
      const { control } = row;
      const configure = (component) => {
        if (control.options) component.addOptions(control.options);
        component.setValue(tab.getControlValue(control.key));
        component.onChange((value) => tab.setControlValue(control.key, value));
      };
      if (control.type === "toggle") setting.addToggle(configure);
      else if (control.type === "dropdown") setting.addDropdown(configure);
      else assert.fail(`Unhandled declarative control: ${control.type}`);
    }
  }
}

const snapshots = [];
for (const modern of [false, true]) {
  const { Plugin, SettingTab, notices, copied } = loadPlugin(modern);
  const plugin = new Plugin();
  await plugin.loadSettings();
  const calls = [];
  const count = (name) => calls.filter((call) => call === name).length;
  const report = {
    summary: "Setup ready", passedChecks: 4, totalChecks: 4,
    checks: ["initialize-config", "start-service", "refresh-index", "rebuild-index"].map((action) => ({
      label: action, detail: "Fixture check", state: "attention", action, actionLabel: action,
    })),
    mcpEndpoint: "http://127.0.0.1:27124/mcp", serviceOutput: "Local service log",
  };
  plugin.processManager = {
    resolveVaultPath: () => { calls.push("vault-path"); return "/fixture/vault"; },
    runInit: async () => { calls.push("init"); return "Initialized"; },
    runDoctor: async () => { calls.push("doctor"); return "{}"; },
  };
  plugin.getSetupReport = async () => { calls.push("report"); return report; };
  plugin.recreateClient = () => {
    assert.equal(plugin.savedData.host, plugin.settings.host);
    assert.equal(plugin.savedData.port, plugin.settings.port);
    calls.push("client");
  };
  plugin.ensureService = async () => { calls.push("start"); };
  plugin.stopManagedService = async () => { calls.push("stop"); };
  plugin.applyKbConfigDraft = async () => { calls.push("apply"); };
  plugin.client = { refreshIndex: async (options) => { calls.push(options?.rebuild ? "rebuild" : "refresh"); } };
  const tab = new SettingTab({}, plugin);
  const items = tab.getSettingDefinitions();
  const definitions = items.flatMap((item) => item.items ?? [item]);
  assert.deepEqual(calls, [], "Registration and search indexing must not run I/O or actions");
  assert.equal(plugin.saves, undefined);
  assert.deepEqual(Array.from(definitions, (row) => row.name), expectedNames);
  assert.ok(definitions.every((row) => row.searchable !== false));
  assert.deepEqual(Array.from(items.filter((item) => item.type === "group"), (item) => item.heading),
    ["Setup", "Service", "Search", "Indexing"]);
  assert.ok(definitions[0].aliases.includes("Copy endpoint"));

  const render = () => modern ? renderModern(tab, tab.getSettingDefinitions()) : tab.display();
  if (modern) tab.display = () => assert.fail("The modern host must bypass the legacy display()");
  else assert.equal(tab.setControlValue, undefined, "Legacy host must not expose the new API");
  render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count("report"), 1);
  assert.equal(count("vault-path"), 1);
  const rows = () => tab.containerEl.rows.filter((row) => !row.heading);
  assert.deepEqual(rows().map((row) => row.name), expectedNames);
  const row = (name) => rows().find((entry) => entry.name === name);
  const control = (name) => row(name).controls[0];
  const change = (name, value) => control(name).change(value);
  const button = (name, text) => row(name).controls.find((entry) => entry.text === text);

  for (const [name, key, value, expected] of [
    ["obsidian-kb binary", "executablePath", "  /fixture/bin/obsidian-kb  ", "/fixture/bin/obsidian-kb"],
    ["obsidian-kb binary", "executablePath", " ", "obsidian-kb"],
    ["Configuration file", "configPath", "  /fixture/config.toml  ", "/fixture/config.toml"],
    ["Index directory", "indexDir", "  /fixture/index  ", "/fixture/index"],
    ["Vault path", "vaultPath", "  /fixture/other-vault  ", "/fixture/other-vault"],
    ["Host", "host", "  localhost  ", "localhost"],
    ["Host", "host", " ", "127.0.0.1"],
    ["Port", "port", "12345", 12345],
    ["Default result count", "defaultTop", "15", 15],
    ["Lexical candidate count", "searchBm25Candidates", "90", 90],
    ["Semantic candidate count", "searchVectorCandidates", "100", 100],
    ["Graph expansion weight", "searchGraphWeight", "0.5", 0.5],
    ["Graph expansion depth", "searchGraphDepth", "0", 0],
    ["Graph max neighbors", "searchGraphMaxNeighbors", "25", 25],
    ["Maximum PDF size", "indexPdfMaxFileSizeMb", "60", 60],
    ["Start service automatically", "autoStart", false, false],
    ["Preload embedder", "preloadEmbedder", true, true],
    ["Include chunk text", "includeText", true, true],
    ["Use graph expansion by default", "expandGraph", false, false],
    ["Index PDF attachments", "indexPdfEnabled", true, true],
    ["Default search mode", "defaultMode", "vector", "vector"],
    ["Exclude headings from index", "indexExcludeHeadings", "  Relations  \n\nSources\nRelations", ["Relations", "Sources"]],
  ]) {
    const saves = plugin.saves ?? 0;
    await change(name, value);
    assert.deepEqual(structuredClone(plugin.settings[key]), expected, name);
    assert.deepEqual(plugin.savedData[key], expected, `${name} must persist`);
    assert.equal(plugin.saves, saves + 1);
  }
  assert.equal(count("client"), 3, "Host and valid port changes must recreate the client after saving");

  for (const name of ["Port", "Default result count", "Lexical candidate count",
    "Semantic candidate count", "Graph expansion depth", "Graph max neighbors", "Maximum PDF size"]) {
    for (const value of ["invalid", "-1", "1.5", "Infinity", ...(name === "Graph expansion depth" ? [] : ["0", ""])]) {
      const saved = structuredClone(plugin.savedData);
      const saves = plugin.saves;
      const clients = count("client");
      await change(name, value);
      assert.deepEqual(plugin.savedData, saved, `${name} must reject ${value}`);
      assert.equal(plugin.saves, saves);
      assert.equal(count("client"), clients);
    }
  }
  for (const value of ["invalid", "-0.1", "Infinity"]) {
    const saves = plugin.saves;
    await change("Graph expansion weight", value);
    assert.equal(plugin.settings.searchGraphWeight, 0.5);
    assert.equal(plugin.saves, saves);
  }

  await button("Initialize vault config", "Initialize").click();
  await button("Service process", "Start").click();
  await button("Service process", "Stop").click();
  await button("Doctor", "Run doctor").click();
  assert.equal(button("Apply search and indexing config", "Apply config").cta, true);
  await button("Apply search and indexing config", "Apply config").click();
  assert.equal(count("init"), 1);
  assert.equal(count("start"), 1);
  assert.equal(count("stop"), 1);
  assert.equal(count("doctor"), 1);
  assert.equal(count("apply"), 1);

  const assistant = row("Setup assistant").settingEl;
  await assistant.find("Run checks").click();
  await assistant.find("Copy endpoint").click();
  assert.deepEqual(copied, [report.mcpEndpoint]);
  await assistant.find("Run doctor").click();
  for (const action of ["initialize-config", "start-service", "refresh-index", "rebuild-index"]) {
    await assistant.find(action, "button").click();
  }
  assert.equal(count("init"), 2);
  assert.equal(count("start"), 2);
  assert.equal(count("doctor"), 2);
  assert.equal(count("refresh"), 1);
  assert.equal(count("rebuild"), 1);
  assert.equal(count("report"), 7, "Setup actions must refresh the assistant after completion");
  assert.ok(assistant.find("Service logs"));

  plugin.processManager.runDoctor = async () => { throw new Error("Doctor failed"); };
  await button("Doctor", "Run doctor").click();
  await assistant.find("Run doctor").click();
  assert.ok(notices.includes("Doctor failed"));
  assert.equal(count("report"), 8, "A failed setup action must still refresh the assistant");

  // Use the production loadSettings/saveSettings methods to check reloads and
  // preservation of settings that are not exposed in this tab.
  const reloaded = new Plugin();
  reloaded.savedData = plugin.savedData;
  await reloaded.loadSettings();
  assert.deepEqual(structuredClone(reloaded.settings), structuredClone(plugin.settings));
  plugin.settings = reloaded.settings;
  render();
  assert.equal(control("Default search mode").value, "vector");
  assert.equal(control("Include chunk text").value, true);
  assert.equal(control("Port").value, "12345");
  assert.equal(control("Exclude headings from index").value, "Relations\nSources");
  assert.equal(plugin.settings.maxChars, 1200);
  assert.equal(plugin.settings.idleUnloadSeconds, 600);
  snapshots.push(structuredClone(plugin.savedData));
  console.log(`Settings tests passed for the ${modern ? "1.13+ declarative" : "pre-1.13 legacy"} API host.`);
}
assert.deepEqual(snapshots[0], snapshots[1], "Both interfaces must produce identical persisted settings");
