import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { normalizeExcludeHeadings } from "./kb-config";
import type ObsidianKbPlugin from "./main";
import type { SearchMode, SetupActionId, SetupReport } from "./types";

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

    this.renderSetupAssistant(containerEl);

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

    new Setting(containerEl)
      .setName("Lexical candidate count")
      .setDesc("How many BM25 candidates obsidian-kb gathers before final ranking.")
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

    new Setting(containerEl)
      .setName("Semantic candidate count")
      .setDesc("How many vector candidates obsidian-kb gathers before final ranking.")
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

    new Setting(containerEl)
      .setName("Include chunk text")
      .setDesc("Show chunk excerpts in result cards. Search also requests full chunk text when enabled.")
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

    new Setting(containerEl)
      .setName("Graph expansion weight")
      .setDesc("Boost applied to linked notes when graph expansion is enabled.")
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

    new Setting(containerEl)
      .setName("Graph expansion depth")
      .setDesc("Maximum link distance used for graph expansion.")
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

    new Setting(containerEl)
      .setName("Graph max neighbors")
      .setDesc("Maximum linked notes considered during graph expansion.")
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

    new Setting(containerEl).setName("Indexing").setHeading();

    new Setting(containerEl)
      .setName("Exclude headings from index")
      .setDesc("One heading per line. Matching sections are removed from chunks, BM25, embeddings, and related-note scoring.")
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

    new Setting(containerEl)
      .setName("Index PDF attachments")
      .setDesc("Include PDF files in obsidian-kb indexing. PDF results link back to page anchors when available.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.indexPdfEnabled)
          .onChange(async (value) => {
            this.plugin.settings.indexPdfEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum PDF size")
      .setDesc("Maximum PDF file size to index, in MB.")
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

    new Setting(containerEl)
      .setName("Apply search and indexing config")
      .setDesc("Writes the obsidian-kb config file, restarts the plugin-managed service when needed, then refreshes the index.")
      .addButton((button) =>
        button
          .setButtonText("Apply config")
          .setCta()
          .onClick(async () => {
            await this.plugin.applyKbConfigDraft();
          }),
      );
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
