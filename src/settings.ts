import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
  type SettingDefinitionControl,
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
  type SettingDropdownControl,
  type SettingToggleControl,
} from "obsidian";
import { normalizeExcludeHeadings } from "./kb-config";
import type ObsidianKbPlugin from "./main";
import type { SetupActionId, SetupReport } from "./types";

// Restrict the shared fallback to the declarative controls used by this tab.
// Text inputs keep their existing normalization, numeric validation, and side effects.
type SimpleSettingKey =
  | "autoStart"
  | "preloadEmbedder"
  | "includeText"
  | "expandGraph"
  | "indexPdfEnabled"
  | "defaultMode";
type SimpleControl =
  | SettingToggleControl<SimpleSettingKey>
  | SettingDropdownControl<SimpleSettingKey>;
type SettingsRow =
  | (SettingDefinitionControl<SimpleSettingKey> & { control: SimpleControl })
  | (Omit<SettingDefinitionRender, "render"> & { render: (setting: Setting) => void });
type SettingsGroup = Omit<SettingDefinitionGroup<SimpleSettingKey>, "type" | "items"> & {
  type: "group";
  items: SettingsRow[];
};
type SettingsItem = SettingsRow | SettingsGroup;

export class ObsidianKbSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianKbPlugin,
  ) {
    super(app, plugin);
  }

  // Obsidian 1.13+ renders and indexes these definitions. The legacy renderer
  // below uses the same rows so both interfaces keep identical behavior.
  getSettingDefinitions(): SettingsItem[] {
    return [
      {
        name: "Setup assistant",
        desc: "Check local retrieval, service health, index readiness, and MCP access.",
        aliases: ["Run checks", "Copy endpoint", "MCP endpoint", "Agent access", "Service logs"],
        render: (setting) => {
          setting.settingEl.empty();
          setting.settingEl.removeClass("setting-item");
          this.renderSetupAssistant(setting.settingEl);
        },
      },
      {
        type: "group",
        heading: "Setup",
        items: [
          {
            name: "obsidian-kb binary",
            desc: "Command name or absolute path. Homebrew paths such as /opt/homebrew/bin are checked automatically.",
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder("obsidian-kb")
                    .setValue(this.plugin.settings.executablePath)
                    .onChange(async (value) => {
                      this.plugin.settings.executablePath = value.trim() || "obsidian-kb";
                      await this.plugin.saveSettings();
                    }),
                );
            },
          },
          {
            name: "Configuration file",
            desc: "Optional path passed as `--config` to init, serve, and doctor. Leave empty to use obsidian-kb defaults.",
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder(".obsidian-kb.toml")
                    .setValue(this.plugin.settings.configPath)
                    .onChange(async (value) => {
                      this.plugin.settings.configPath = value.trim();
                      await this.plugin.saveSettings();
                    }),
                );
            },
          },
          {
            name: "Index directory",
            desc: "Optional sidecar index directory passed to `obsidian-kb init --index-dir`. Leave empty for `<vault>/.obsidian-kb`.",
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder(".obsidian-kb")
                    .setValue(this.plugin.settings.indexDir)
                    .onChange(async (value) => {
                      this.plugin.settings.indexDir = value.trim();
                      await this.plugin.saveSettings();
                    }),
                );
            },
          },
          {
            name: "Vault path",
            desc: "Leave empty to use the current desktop vault path.",
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder(this.plugin.processManager.resolveVaultPath())
                    .setValue(this.plugin.settings.vaultPath)
                    .onChange(async (value) => {
                      this.plugin.settings.vaultPath = value.trim();
                      await this.plugin.saveSettings();
                    }),
                );
            },
          },
          {
            name: "Initialize vault config",
            desc: "Runs `obsidian-kb init --vault` for the configured vault path, using the configured config file and index directory when provided.",
            render: (setting) => {
              setting
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
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Service",
        items: [
          {
            name: "Host",
            render: (setting) => {
              setting
                .addText((text) =>
                  text.setValue(this.plugin.settings.host).onChange(async (value) => {
                    this.plugin.settings.host = value.trim() || "127.0.0.1";
                    await this.plugin.saveSettings();
                    this.plugin.recreateClient();
                  }),
                );
            },
          },
          {
            name: "Port",
            render: (setting) => {
              setting
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
            },
          },
          {
            name: "Start service automatically",
            desc: "Launch `obsidian-kb serve` when the plugin loads if no service is reachable.",
            control: { type: "toggle", key: "autoStart" },
          },
          {
            name: "Preload embedder",
            desc: "Warm the local embedding model when the service starts.",
            control: { type: "toggle", key: "preloadEmbedder" },
          },
          {
            name: "Service process",
            desc: "Start or stop the local `obsidian-kb serve` process managed by this plugin.",
            render: (setting) => {
              setting
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
            },
          },
          {
            name: "Doctor",
            desc: "Runs `obsidian-kb doctor --json` and shows a short result.",
            render: (setting) => {
              setting
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
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Search",
        items: [
          {
            name: "Default search mode",
            control: {
              type: "dropdown",
              key: "defaultMode",
              options: { hybrid: "Hybrid", bm25: "Lexical", vector: "Semantic" },
            },
          },
          {
            name: "Default result count",
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder("10")
                    .setValue(String(this.plugin.settings.defaultTop))
                    .onChange(async (value) => {
                      const top = Number(value);
                      if (Number.isInteger(top) && top >= 1) {
                        this.plugin.settings.defaultTop = top;
                        await this.plugin.saveSettings();
                      }
                    }),
                );
            },
          },
          {
            name: "Lexical candidate count",
            desc: "How many BM25 candidates obsidian-kb gathers before final ranking.",
            render: (setting) => {
              setting
                .addText((text) => {
                  text.inputEl.type = "number";
                  text.inputEl.min = "1";
                  text
                    .setPlaceholder("80")
                    .setValue(String(this.plugin.settings.searchBm25Candidates))
                    .onChange(async (value) => {
                      const candidates = Number(value);
                      if (Number.isInteger(candidates) && candidates >= 1) {
                        this.plugin.settings.searchBm25Candidates = candidates;
                        await this.plugin.saveSettings();
                      }
                    });
                });
            },
          },
          {
            name: "Semantic candidate count",
            desc: "How many vector candidates obsidian-kb gathers before final ranking.",
            render: (setting) => {
              setting
                .addText((text) => {
                  text.inputEl.type = "number";
                  text.inputEl.min = "1";
                  text
                    .setPlaceholder("80")
                    .setValue(String(this.plugin.settings.searchVectorCandidates))
                    .onChange(async (value) => {
                      const candidates = Number(value);
                      if (Number.isInteger(candidates) && candidates >= 1) {
                        this.plugin.settings.searchVectorCandidates = candidates;
                        await this.plugin.saveSettings();
                      }
                    });
                });
            },
          },
          {
            name: "Include chunk text",
            desc: "Show chunk excerpts in result cards. Search also requests full chunk text when enabled.",
            control: { type: "toggle", key: "includeText" },
          },
          {
            name: "Use graph expansion by default",
            control: { type: "toggle", key: "expandGraph" },
          },
          {
            name: "Graph expansion weight",
            desc: "Boost applied to linked notes when graph expansion is enabled.",
            render: (setting) => {
              setting
                .addText((text) => {
                  text.inputEl.type = "number";
                  text.inputEl.min = "0";
                  text.inputEl.step = "0.05";
                  text
                    .setPlaceholder("0.25")
                    .setValue(String(this.plugin.settings.searchGraphWeight))
                    .onChange(async (value) => {
                      const weight = Number(value);
                      if (Number.isFinite(weight) && weight >= 0) {
                        this.plugin.settings.searchGraphWeight = weight;
                        await this.plugin.saveSettings();
                      }
                    });
                });
            },
          },
          {
            name: "Graph expansion depth",
            desc: "Maximum link distance used for graph expansion.",
            render: (setting) => {
              setting
                .addText((text) => {
                  text.inputEl.type = "number";
                  text.inputEl.min = "0";
                  text.inputEl.step = "1";
                  text
                    .setPlaceholder("1")
                    .setValue(String(this.plugin.settings.searchGraphDepth))
                    .onChange(async (value) => {
                      const depth = Number(value);
                      if (Number.isInteger(depth) && depth >= 0) {
                        this.plugin.settings.searchGraphDepth = depth;
                        await this.plugin.saveSettings();
                      }
                    });
                });
            },
          },
          {
            name: "Graph max neighbors",
            desc: "Maximum linked notes considered during graph expansion.",
            render: (setting) => {
              setting
                .addText((text) => {
                  text.inputEl.type = "number";
                  text.inputEl.min = "1";
                  text.inputEl.step = "1";
                  text
                    .setPlaceholder("20")
                    .setValue(String(this.plugin.settings.searchGraphMaxNeighbors))
                    .onChange(async (value) => {
                      const neighbors = Number(value);
                      if (Number.isInteger(neighbors) && neighbors >= 1) {
                        this.plugin.settings.searchGraphMaxNeighbors = neighbors;
                        await this.plugin.saveSettings();
                      }
                    });
                });
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Indexing",
        items: [
          {
            name: "Exclude headings from index",
            desc: "One heading per line. Matching sections are removed from chunks, BM25, embeddings, and related-note scoring.",
            render: (setting) => {
              setting
                .addTextArea((text) => {
                  text.inputEl.rows = 4;
                  text
                    .setPlaceholder("Relations\nSources")
                    .setValue(this.plugin.settings.indexExcludeHeadings.join("\n"))
                    .onChange(async (value) => {
                      this.plugin.settings.indexExcludeHeadings = normalizeExcludeHeadings(value);
                      await this.plugin.saveSettings();
                    });
                });
            },
          },
          {
            name: "Index PDF attachments",
            desc: "Include PDF files in obsidian-kb indexing. PDF results link back to page anchors when available.",
            control: { type: "toggle", key: "indexPdfEnabled" },
          },
          {
            name: "Maximum PDF size",
            desc: "Maximum PDF file size to index, in MB.",
            render: (setting) => {
              setting
                .addText((text) =>
                  text
                    .setPlaceholder("50")
                    .setValue(String(this.plugin.settings.indexPdfMaxFileSizeMb))
                    .onChange(async (value) => {
                      const maxFileSizeMb = Number(value);
                      if (Number.isInteger(maxFileSizeMb) && maxFileSizeMb > 0) {
                        this.plugin.settings.indexPdfMaxFileSizeMb = maxFileSizeMb;
                        await this.plugin.saveSettings();
                      }
                    }),
                );
            },
          },
          {
            name: "Apply search and indexing config",
            desc: "Writes the obsidian-kb config file, restarts the plugin-managed service when needed, then refreshes the index.",
            render: (setting) => {
              setting
                .addButton((button) =>
                  button
                    .setButtonText("Apply config")
                    .setCta()
                    .onClick(async () => {
                      await this.plugin.applyKbConfigDraft();
                    }),
                );
            },
          },
        ],
      },
    ];
  }

  // Obsidian < 1.13 calls display(). Only use APIs available since 1.5 here.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const item of this.getSettingDefinitions()) {
      if ("type" in item) {
        new Setting(containerEl).setName(item.heading ?? "").setHeading();
        for (const row of item.items) {
          this.renderLegacyRow(containerEl, row);
        }
      } else {
        this.renderLegacyRow(containerEl, item);
      }
    }
  }

  private renderLegacyRow(containerEl: HTMLElement, row: SettingsRow): void {
    const setting = new Setting(containerEl).setName(row.name).setDesc(row.desc ?? "");
    if (row.render) {
      row.render(setting);
      return;
    }

    const { control } = row;
    const value = this.plugin.settings[control.key];
    if (control.type === "toggle") {
      setting.addToggle((toggle) =>
        toggle.setValue(Boolean(value)).onChange(async (value) => {
          await this.saveControlValue(control.key, value);
        }),
      );
    } else {
      setting.addDropdown((dropdown) =>
        dropdown.addOptions(control.options).setValue(String(value)).onChange(async (value) => {
          await this.saveControlValue(control.key, value);
        }),
      );
    }
  }

  private async saveControlValue(key: SimpleSettingKey, value: boolean | string): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: value });
    await this.plugin.saveSettings();
  }

  private renderSetupAssistant(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "obsidian-kb-setup-assistant" });
    const header = card.createDiv({ cls: "obsidian-kb-setup-header" });
    const titleGroup = header.createDiv({ cls: "obsidian-kb-setup-title-group" });
    titleGroup.createDiv({
      cls: "obsidian-kb-setup-title",
      text: "Setup assistant",
    });
    titleGroup.createDiv({
      cls: "obsidian-kb-setup-subtitle",
      text: "Check local retrieval, service health, index readiness, and MCP access.",
    });

    const runButton = header.createEl("button", {
      cls: "obsidian-kb-setup-run",
      text: "Run checks",
      attr: {
        type: "button",
      },
    });

    const body = card.createDiv({ cls: "obsidian-kb-setup-body" });
    runButton.addEventListener("click", () => {
      void this.refreshSetupAssistant(body);
    });
    void this.refreshSetupAssistant(body);
  }

  private async refreshSetupAssistant(body: HTMLElement): Promise<void> {
    body.empty();
    body.createDiv({
      cls: "obsidian-kb-setup-loading",
      text: "Checking local setup...",
    });

    try {
      const report = await this.plugin.getSetupReport();
      this.renderSetupReport(body, report);
    } catch (error) {
      body.empty();
      body.createDiv({
        cls: "obsidian-kb-setup-error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private renderSetupReport(body: HTMLElement, report: SetupReport): void {
    body.empty();

    const summary = body.createDiv({ cls: "obsidian-kb-setup-summary" });
    summary.createDiv({
      cls: "obsidian-kb-setup-summary-title",
      text: report.summary,
    });
    summary.createDiv({
      cls: "obsidian-kb-setup-summary-count",
      text: `${report.passedChecks} / ${report.totalChecks} checks passed`,
    });

    const checks = body.createDiv({ cls: "obsidian-kb-setup-checks" });
    for (const check of report.checks) {
      const row = checks.createDiv({ cls: "obsidian-kb-setup-check" });
      row.dataset.state = check.state;
      const marker = row.createSpan({ cls: "obsidian-kb-setup-check-marker" });
      marker.setText(check.state === "passed" ? "OK" : "!");

      const copy = row.createDiv({ cls: "obsidian-kb-setup-check-copy" });
      copy.createDiv({
        cls: "obsidian-kb-setup-check-label",
        text: check.label,
      });
      copy.createDiv({
        cls: "obsidian-kb-setup-check-detail",
        text: check.detail,
      });

      if (check.action && check.actionLabel) {
        const actionButton = row.createEl("button", {
          cls: "obsidian-kb-setup-check-action",
          text: check.actionLabel,
          attr: {
            type: "button",
          },
        });
        actionButton.addEventListener("click", () => {
          void this.runSetupAction(check.action, body);
        });
      }
    }

    const agent = body.createDiv({ cls: "obsidian-kb-setup-agent" });
    agent.createDiv({
      cls: "obsidian-kb-setup-agent-title",
      text: "Agent access",
    });
    const endpoint = agent.createDiv({ cls: "obsidian-kb-setup-endpoint" });
    endpoint.createSpan({
      cls: "obsidian-kb-setup-endpoint-label",
      text: "MCP endpoint",
    });
    endpoint.createEl("code", {
      cls: "obsidian-kb-setup-endpoint-value",
      text: report.mcpEndpoint,
    });

    const actions = agent.createDiv({ cls: "obsidian-kb-setup-agent-actions" });
    actions
      .createEl("button", {
        text: "Copy endpoint",
        attr: {
          type: "button",
        },
      })
      .addEventListener("click", () => {
        void this.copyText(report.mcpEndpoint, "MCP endpoint copied");
      });
    actions
      .createEl("button", {
        text: "Run doctor",
        attr: {
          type: "button",
        },
      })
      .addEventListener("click", () => {
        void this.runDoctor(body);
      });

    if (report.serviceOutput.trim()) {
      const logs = agent.createEl("details", { cls: "obsidian-kb-setup-logs" });
      logs.createEl("summary", { text: "Service logs" });
      logs.createEl("pre", { text: report.serviceOutput.trim() });
    }
  }

  private async runSetupAction(
    action: SetupActionId | undefined,
    body: HTMLElement,
  ): Promise<void> {
    if (!action) {
      return;
    }

    try {
      if (action === "initialize-config") {
        const output = await this.plugin.processManager.runInit();
        new Notice(output || "obsidian-kb config initialized");
      } else if (action === "start-service") {
        await this.plugin.ensureService();
      } else if (action === "refresh-index") {
        await this.plugin.client.refreshIndex();
        new Notice("obsidian-kb index refreshed");
      } else if (action === "rebuild-index") {
        await this.plugin.client.refreshIndex({ rebuild: true });
        new Notice("obsidian-kb index rebuilt");
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      await this.refreshSetupAssistant(body);
    }
  }

  private async runDoctor(body: HTMLElement): Promise<void> {
    try {
      await this.plugin.processManager.runDoctor();
      new Notice("obsidian-kb doctor completed");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      await this.refreshSetupAssistant(body);
    }
  }

  private async copyText(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(message);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}
