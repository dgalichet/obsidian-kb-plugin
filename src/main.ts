import { Notice, Plugin, Platform, WorkspaceLeaf } from "obsidian";
import { ObsidianKbClient } from "./client";
import {
  OBSIDIAN_KB_ICON_ID,
  registerObsidianKbIcon,
} from "./icons";
import {
  readKbConfigDraft,
  writeKbConfigDraft,
  type KbConfigDraft,
} from "./kb-config";
import { ObsidianKbProcessManager } from "./process";
import { ObsidianKbSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  type ObsidianKbSettings,
} from "./types";
import {
  ObsidianKbView,
  VIEW_TYPE_OBSIDIAN_KB,
} from "./view";

export default class ObsidianKbPlugin extends Plugin {
  settings!: ObsidianKbSettings;
  client!: ObsidianKbClient;
  processManager!: ObsidianKbProcessManager;
  private readonly stopOnWindowUnload = (): void => {
    this.processManager?.stopServeNow();
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    registerObsidianKbIcon();
    this.recreateClient();
    this.processManager = new ObsidianKbProcessManager(this.app, () => this.settings);
    await this.loadKbConfigDraft();
    window.addEventListener("beforeunload", this.stopOnWindowUnload);
    window.addEventListener("unload", this.stopOnWindowUnload);

    this.registerView(
      VIEW_TYPE_OBSIDIAN_KB,
      (leaf: WorkspaceLeaf) => new ObsidianKbView(leaf, this),
    );
    this.registerHoverLinkSource("okb", {
      display: "Vault Knowledge Base",
      defaultMod: false,
    });

    this.addRibbonIcon(OBSIDIAN_KB_ICON_ID, "Open Vault Knowledge Base", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-obsidian-kb-search",
      name: "Open KB search",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "search-selection-in-obsidian-kb",
      name: "Search selected text",
      editorCallback: (editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) {
          new Notice("No selected text");
          return;
        }
        void this.activateView().then((view) => view?.runSearch(selected));
      },
    });

    this.addCommand({
      id: "find-related-notes",
      name: "Find notes related to current note",
      callback: () =>
        void this.activateView().then((view) => view?.findRelatedToCurrentNote()),
    });

    this.addCommand({
      id: "refresh-obsidian-kb-index",
      name: "Refresh KB index",
      callback: async () => {
        try {
          await this.client.refreshIndex();
          new Notice("obsidian-kb index refreshed");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      },
    });

    this.addCommand({
      id: "initialize-obsidian-kb-config",
      name: "Initialize KB config for this vault",
      callback: async () => {
        try {
          const output = await this.processManager.runInit();
          new Notice(output || "obsidian-kb config initialized");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      },
    });

    this.addCommand({
      id: "start-obsidian-kb-service",
      name: "Start KB service",
      callback: () => void this.ensureService(),
    });

    this.addCommand({
      id: "stop-obsidian-kb-service",
      name: "Stop KB service",
      callback: async () => {
        await this.stopManagedService();
        new Notice("obsidian-kb service stopped");
      },
    });

    this.addSettingTab(new ObsidianKbSettingTab(this.app, this));

    if (this.settings.autoStart && Platform.isDesktopApp) {
      this.app.workspace.onLayoutReady(() => {
        void this.ensureService();
      });
    }
  }

  onunload(): void {
    window.removeEventListener("beforeunload", this.stopOnWindowUnload);
    window.removeEventListener("unload", this.stopOnWindowUnload);
    void this.stopManagedService();
  }

  async loadSettings(): Promise<void> {
    const savedData: unknown = await this.loadData();
    const savedSettings =
      savedData && typeof savedData === "object"
        ? savedData as Partial<ObsidianKbSettings>
        : {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async loadKbConfigDraft(): Promise<void> {
    try {
      const draft = await readKbConfigDraft(this.processManager.resolveConfigPath());
      if (!draft) {
        return;
      }

      this.settings.indexExcludeHeadings = draft.excludeHeadings;
      this.settings.indexPdfEnabled = draft.pdfEnabled;
      this.settings.indexPdfMaxFileSizeMb = draft.pdfMaxFileSizeMb;
      this.settings.defaultMode = draft.searchDefaultMode;
      this.settings.defaultTop = draft.searchFinalTopK;
      this.settings.searchBm25Candidates = draft.searchBm25Candidates;
      this.settings.searchVectorCandidates = draft.searchVectorCandidates;
      this.settings.searchGraphWeight = draft.searchGraphWeight;
      this.settings.searchGraphDepth = draft.searchGraphDepth;
      this.settings.searchGraphMaxNeighbors = draft.searchGraphMaxNeighbors;
      await this.saveSettings();
    } catch (error) {
      console.error("Failed to load obsidian-kb config", error);
    }
  }

  async applyKbConfigDraft(): Promise<void> {
    const configPath = this.processManager.resolveConfigPath();
    const draft: KbConfigDraft = {
      excludeHeadings: this.settings.indexExcludeHeadings,
      pdfEnabled: this.settings.indexPdfEnabled,
      pdfMaxFileSizeMb: this.settings.indexPdfMaxFileSizeMb,
      searchDefaultMode: this.settings.defaultMode,
      searchFinalTopK: this.settings.defaultTop,
      searchBm25Candidates: this.settings.searchBm25Candidates,
      searchVectorCandidates: this.settings.searchVectorCandidates,
      searchGraphWeight: this.settings.searchGraphWeight,
      searchGraphDepth: this.settings.searchGraphDepth,
      searchGraphMaxNeighbors: this.settings.searchGraphMaxNeighbors,
    };

    try {
      await this.ensureConfigFile();
      const hadManagedService = this.processManager.isManagedProcessRunning;
      const hadExternalService = !hadManagedService && await this.isServiceReachable();

      await writeKbConfigDraft(configPath, draft);

      if (hadManagedService) {
        await this.stopManagedService();
        await this.ensureService();
        await this.client.refreshIndex();
        new Notice("obsidian-kb config applied, service restarted, and index refreshed");
        return;
      }

      if (hadExternalService) {
        new Notice("obsidian-kb config saved. Restart the external service, then refresh the index.");
        return;
      }

      await this.ensureService();
      await this.client.refreshIndex();
      new Notice("obsidian-kb config applied and index refreshed");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  recreateClient(): void {
    this.client = new ObsidianKbClient(
      `http://${this.settings.host}:${this.settings.port}`,
    );
  }

  async activateView(): Promise<ObsidianKbView | null> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIDIAN_KB)[0];
    if (!leaf) {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) {
        new Notice("Unable to open the right sidebar");
        return null;
      }
      leaf = rightLeaf;
      await leaf.setViewState({
        type: VIEW_TYPE_OBSIDIAN_KB,
        active: true,
      });
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return leaf.view instanceof ObsidianKbView ? leaf.view : null;
  }

  async ensureService(): Promise<void> {
    try {
      await this.client.health();
      return;
    } catch {
      // Fall through and try to start the managed local process.
    }

    try {
      await this.processManager.startServe();
      await waitForService(() => this.client.health(), 8000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`obsidian-kb unavailable: ${message}`);
    }
  }

  async stopManagedService(): Promise<void> {
    if (!this.processManager?.isManagedProcessRunning) {
      return;
    }

    try {
      await this.client.shutdown();
    } catch {
      // The process may not have finished starting or may already be exiting.
    }
    await this.processManager.stopServe();
  }

  private async ensureConfigFile(): Promise<void> {
    const draft = await readKbConfigDraft(this.processManager.resolveConfigPath());
    if (draft) {
      return;
    }
    await this.processManager.runInit();
  }

  private async isServiceReachable(): Promise<boolean> {
    try {
      await this.client.health();
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForService(
  healthCheck: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await healthCheck();
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("obsidian-kb service did not become ready");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
