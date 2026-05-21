import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianKbPlugin from "./main";
import type { SearchMode } from "./types";

export class ObsidianKbSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianKbPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Setup").setHeading();

    new Setting(containerEl)
      .setName("obsidian-kb binary")
      .setDesc("Command name or absolute path. Homebrew paths such as /opt/homebrew/bin are checked automatically.")
      .addText((text) =>
        text
          .setPlaceholder("obsidian-kb")
          .setValue(this.plugin.settings.executablePath)
          .onChange(async (value) => {
            this.plugin.settings.executablePath = value.trim() || "obsidian-kb";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Configuration file")
      .setDesc("Optional path passed as `--config` to init, serve, and doctor. Leave empty to use obsidian-kb defaults.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian-kb.toml")
          .setValue(this.plugin.settings.configPath)
          .onChange(async (value) => {
            this.plugin.settings.configPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Index directory")
      .setDesc("Optional sidecar index directory passed to `obsidian-kb init --index-dir`. Leave empty for `<vault>/.obsidian-kb`.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian-kb")
          .setValue(this.plugin.settings.indexDir)
          .onChange(async (value) => {
            this.plugin.settings.indexDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Vault path")
      .setDesc("Leave empty to use the current desktop vault path.")
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.processManager.resolveVaultPath())
          .setValue(this.plugin.settings.vaultPath)
          .onChange(async (value) => {
            this.plugin.settings.vaultPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Initialize vault config")
      .setDesc("Runs `obsidian-kb init --vault` for the configured vault path, using the configured config file and index directory when provided.")
      .addButton((button) =>
        button.setButtonText("Initialize").onClick(async () => {
          try {
            const output = await this.plugin.processManager.runInit();
            new Notice(output || "obsidian-kb config initialized");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }),
      );

    new Setting(containerEl).setName("Service").setHeading();

    new Setting(containerEl)
      .setName("Host")
      .addText((text) =>
        text.setValue(this.plugin.settings.host).onChange(async (value) => {
          this.plugin.settings.host = value.trim() || "127.0.0.1";
          await this.plugin.saveSettings();
          this.plugin.recreateClient();
        }),
      );

    new Setting(containerEl)
      .setName("Port")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.port)).onChange(async (value) => {
          const port = Number(value);
          if (Number.isInteger(port) && port > 0) {
            this.plugin.settings.port = port;
            await this.plugin.saveSettings();
            this.plugin.recreateClient();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Start service automatically")
      .setDesc("Launch `obsidian-kb serve` when the plugin loads if no service is reachable.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Preload embedder")
      .setDesc("Warm the local embedding model when the service starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.preloadEmbedder)
          .onChange(async (value) => {
            this.plugin.settings.preloadEmbedder = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Service process")
      .setDesc("Start or stop the local `obsidian-kb serve` process managed by this plugin.")
      .addButton((button) =>
        button.setButtonText("Start").onClick(async () => {
          await this.plugin.ensureService();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Stop").onClick(async () => {
          await this.plugin.stopManagedService();
          new Notice("obsidian-kb service stopped");
        }),
      );

    new Setting(containerEl)
      .setName("Doctor")
      .setDesc("Runs `obsidian-kb doctor --json` and shows a short result.")
      .addButton((button) =>
        button.setButtonText("Run doctor").onClick(async () => {
          try {
            const output = await this.plugin.processManager.runDoctor();
            new Notice(output ? "obsidian-kb doctor completed" : "obsidian-kb doctor completed");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }),
      );

    new Setting(containerEl).setName("Search").setHeading();

    new Setting(containerEl)
      .setName("Default search mode")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hybrid", "Hybrid")
          .addOption("bm25", "Lexical")
          .addOption("vector", "Semantic")
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultMode = value as SearchMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default result count")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.defaultTop))
          .onChange(async (value) => {
            const top = Number(value);
            if (Number.isInteger(top) && top >= 1) {
              this.plugin.settings.defaultTop = top;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Include chunk text")
      .setDesc("Return chunk text in search results. Snippets remain available when disabled.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeText).onChange(async (value) => {
          this.plugin.settings.includeText = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Use graph expansion by default")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.expandGraph).onChange(async (value) => {
          this.plugin.settings.expandGraph = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
