import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { OBSIDIAN_KB_ICON_ID } from "./icons";
import type ObsidianKbPlugin from "./main";
import type {
  KbSearchHit,
  KbStatus,
  RelatedNote,
  SearchMode,
  ServiceState,
} from "./types";

export const VIEW_TYPE_OBSIDIAN_KB = "obsidian-kb-view";

type KbTab = "search" | "related" | "index";

const TABS: Array<{ id: KbTab; label: string }> = [
  { id: "search", label: "Search" },
  { id: "related", label: "Related notes" },
  { id: "index", label: "Index" },
];

const INDEX_STAT_KEYS = [
  ["notes", "Notes"],
  ["chunks", "Chunks"],
  ["links", "Links"],
  ["embeddings", "Embeddings"],
] as const;

interface ResultCardData {
  path: string;
  title?: string;
  heading?: string;
  lineStart?: number;
  snippet?: string;
  score?: number;
  tags?: string[];
}

export class ObsidianKbView extends ItemView {
  private queryInput!: HTMLInputElement;
  private modeSelect!: HTMLSelectElement;
  private searchTopInput!: HTMLInputElement;
  private relatedTopInput!: HTMLInputElement;
  private expandGraphInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private searchResultsEl!: HTMLElement;
  private relatedContextEl!: HTMLElement;
  private relatedResultsEl!: HTMLElement;
  private indexStatsEl!: HTMLElement;
  private readonly tabButtons: Partial<Record<KbTab, HTMLElement>> = {};
  private readonly tabPanels: Partial<Record<KbTab, HTMLElement>> = {};
  private activeTab: KbTab = "search";
  private relatedLoadedNotePath: string | null = null;
  private relatedLoadedTop: number | null = null;
  private relatedRequestId = 0;
  private serviceState: ServiceState = "unknown";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ObsidianKbPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OBSIDIAN_KB;
  }

  getDisplayText(): string {
    return "Obsidian KB";
  }

  getIcon(): string {
    return OBSIDIAN_KB_ICON_ID;
  }

  async onOpen(): Promise<void> {
    this.render();
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.updateRelatedContext();
        if (this.activeTab === "related") {
          void this.loadRelatedForCurrentNote(false);
        }
      }),
    );
    await this.refreshStatus();
  }

  async onClose(): Promise<void> {
    return;
  }

  async runSearch(query?: string): Promise<void> {
    this.setActiveTab("search");

    const effectiveQuery = query ?? this.queryInput.value;
    this.queryInput.value = effectiveQuery;
    if (!effectiveQuery.trim()) {
      this.renderEmpty(this.searchResultsEl, "Enter a query to search the indexed vault.");
      return;
    }

    await this.withBusy("Searching", this.searchResultsEl, async () => {
      const hits = await this.plugin.client.search({
        query: effectiveQuery.trim(),
        mode: this.modeSelect.value as SearchMode,
        top: Number(this.searchTopInput.value) || this.plugin.settings.defaultTop,
        expand_graph: this.expandGraphInput.checked,
        include_text: this.plugin.settings.includeText,
        max_chars: this.plugin.settings.maxChars,
      });
      this.renderHits(hits);
    });
  }

  async findRelatedToCurrentNote(): Promise<void> {
    this.setActiveTab("related", { loadRelated: false });
    await this.loadRelatedForCurrentNote(true);
  }

  private render(): void {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("obsidian-kb-view");

    const header = container.createDiv({ cls: "obsidian-kb-header" });
    this.renderTabs(header);
    this.statusEl = header.createDiv({ cls: "obsidian-kb-status" });

    const searchPanel = container.createDiv({ cls: "obsidian-kb-tab-panel" });
    this.tabPanels.search = searchPanel;
    this.renderSearchTab(searchPanel);

    const relatedPanel = container.createDiv({ cls: "obsidian-kb-tab-panel" });
    this.tabPanels.related = relatedPanel;
    this.renderRelatedTab(relatedPanel);

    const indexPanel = container.createDiv({ cls: "obsidian-kb-tab-panel" });
    this.tabPanels.index = indexPanel;
    this.renderIndexTab(indexPanel);

    this.setActiveTab(this.activeTab);
  }

  private renderTabs(container: HTMLElement): void {
    const tabsEl = container.createDiv({ cls: "obsidian-kb-tabs" });
    tabsEl.setAttribute("role", "tablist");

    for (const tab of TABS) {
      const button = tabsEl.createEl("button", {
        cls: "obsidian-kb-tab",
        text: tab.label,
        attr: {
          type: "button",
          role: "tab",
        },
      });
      button.addEventListener("click", () => {
        this.setActiveTab(tab.id);
        if (tab.id === "index") {
          void this.refreshStatus();
        }
      });
      this.tabButtons[tab.id] = button;
    }
  }

  private renderSearchTab(panel: HTMLElement): void {
    const toolbar = panel.createDiv({ cls: "obsidian-kb-toolbar" });
    this.queryInput = toolbar.createEl("input", {
      cls: "obsidian-kb-query",
      attr: {
        type: "search",
        placeholder: "Semantic search",
      },
    });
    this.queryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        void this.runSearch();
      }
    });

    const controls = panel.createDiv({ cls: "obsidian-kb-controls" });

    const modeField = this.createField(controls, "Mode");
    this.modeSelect = modeField.createEl("select", { cls: "obsidian-kb-select" });
    for (const [value, label] of [
      ["hybrid", "Hybrid"],
      ["bm25", "Lexical"],
      ["vector", "Semantic"],
    ] as const) {
      this.modeSelect.createEl("option", {
        text: label,
        attr: {
          value,
        },
      });
    }
    this.modeSelect.value = this.plugin.settings.defaultMode;

    const topField = this.createField(controls, "Results");
    this.searchTopInput = topField.createEl("input", {
      cls: "obsidian-kb-top",
      attr: {
        type: "number",
        min: "1",
        max: "50",
      },
    });
    this.searchTopInput.value = String(this.plugin.settings.defaultTop);

    const graphLabel = controls.createEl("label", { cls: "obsidian-kb-checkbox" });
    this.expandGraphInput = graphLabel.createEl("input", {
      attr: {
        type: "checkbox",
      },
    });
    this.expandGraphInput.checked = this.plugin.settings.expandGraph;
    graphLabel.createSpan({ text: "Graph" });

    const actions = panel.createDiv({ cls: "obsidian-kb-actions" });
    actions
      .createEl("button", { text: "Search", cls: "mod-cta" })
      .addEventListener("click", () => void this.runSearch());

    this.searchResultsEl = panel.createDiv({ cls: "obsidian-kb-results" });
    this.renderEmpty(this.searchResultsEl, "Search results will appear here.");
  }

  private renderRelatedTab(panel: HTMLElement): void {
    this.relatedContextEl = panel.createDiv({ cls: "obsidian-kb-current-note" });
    this.updateRelatedContext();

    const controls = panel.createDiv({ cls: "obsidian-kb-controls" });
    const topField = this.createField(controls, "Results");
    this.relatedTopInput = topField.createEl("input", {
      cls: "obsidian-kb-top",
      attr: {
        type: "number",
        min: "1",
        max: "50",
      },
    });
    this.relatedTopInput.value = String(this.plugin.settings.defaultTop);
    this.relatedTopInput.addEventListener("change", () => {
      this.relatedLoadedTop = null;
      if (this.activeTab === "related") {
        void this.loadRelatedForCurrentNote(true);
      }
    });

    const actions = panel.createDiv({ cls: "obsidian-kb-actions" });
    actions
      .createEl("button", { text: "Refresh related notes", cls: "mod-cta" })
      .addEventListener("click", () => void this.findRelatedToCurrentNote());

    this.relatedResultsEl = panel.createDiv({ cls: "obsidian-kb-results" });
    this.renderEmpty(this.relatedResultsEl, "Related notes will appear here.");
  }

  private renderIndexTab(panel: HTMLElement): void {
    const actions = panel.createDiv({ cls: "obsidian-kb-actions" });
    actions
      .createEl("button", { text: "Refresh status" })
      .addEventListener("click", () =>
        void this.withBusy(
          "Refreshing status",
          this.indexStatsEl,
          () => this.refreshStatus(),
          false,
        ),
      );
    actions
      .createEl("button", { text: "Refresh index", cls: "mod-cta" })
      .addEventListener("click", () => void this.refreshIndex());
    actions
      .createEl("button", { text: "Rebuild index", cls: "mod-warning" })
      .addEventListener("click", () => void this.refreshIndex(true));

    this.indexStatsEl = panel.createDiv({ cls: "obsidian-kb-index-stats" });
    this.renderEmpty(this.indexStatsEl, "Index stats will appear here.");
  }

  private createField(container: HTMLElement, label: string): HTMLElement {
    const field = container.createDiv({ cls: "obsidian-kb-field" });
    field.createDiv({ cls: "obsidian-kb-field-label", text: label });
    return field;
  }

  private setActiveTab(tab: KbTab, options: { loadRelated?: boolean } = {}): void {
    this.activeTab = tab;
    for (const candidate of TABS) {
      const isActive = candidate.id === tab;
      this.tabButtons[candidate.id]?.toggleClass("is-active", isActive);
      this.tabButtons[candidate.id]?.setAttribute("aria-selected", String(isActive));
      if (this.tabPanels[candidate.id]) {
        this.tabPanels[candidate.id]!.hidden = !isActive;
      }
    }

    if (tab === "related") {
      this.updateRelatedContext();
      if (options.loadRelated ?? true) {
        void this.loadRelatedForCurrentNote(false);
      }
    }
  }

  private async loadRelatedForCurrentNote(force: boolean): Promise<void> {
    this.updateRelatedContext();

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.relatedLoadedNotePath = null;
      this.relatedLoadedTop = null;
      this.renderEmpty(this.relatedResultsEl, "Open a note to find related notes.");
      if (force) {
        new Notice("No active note");
      }
      return;
    }

    const top = Number(this.relatedTopInput.value) || this.plugin.settings.defaultTop;
    if (
      !force &&
      this.relatedLoadedNotePath === file.path &&
      this.relatedLoadedTop === top
    ) {
      return;
    }

    const requestId = ++this.relatedRequestId;
    await this.withBusy("Finding related notes", this.relatedResultsEl, async () => {
      const report = await this.plugin.client.relatedByNote(file.path, top);
      if (requestId !== this.relatedRequestId) {
        return;
      }
      this.relatedLoadedNotePath = file.path;
      this.relatedLoadedTop = top;
      this.renderRelated(report.notes ?? []);
    });
  }

  private updateRelatedContext(): void {
    if (!this.relatedContextEl) {
      return;
    }

    const file = this.app.workspace.getActiveFile();
    this.relatedContextEl.empty();
    this.relatedContextEl.createSpan({
      cls: "obsidian-kb-current-note-label",
      text: "Current note",
    });
    this.relatedContextEl.createSpan({
      cls: "obsidian-kb-current-note-path",
      text: file?.path ?? "No active note",
    });
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await this.plugin.client.status();
      this.serviceState = this.getServiceState(status);
      this.renderIndexStatus(status);
      this.setStatus(this.formatStatus(status));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Service unavailable";
      this.serviceState = "stopped";
      this.renderError(this.indexStatsEl, message);
      this.setStatus(message);
    }
  }

  private getServiceState(status: KbStatus): ServiceState {
    if (status.index?.error) {
      return "error";
    }
    if (status.index?.available) {
      return "ready";
    }
    return "unknown";
  }

  private formatStatus(status: KbStatus): string {
    const stats = status.index?.stats;
    const details = [
      `obsidian-kb ${status.version ?? "unknown"}`,
      status.index?.available ? "index ready" : "index missing",
      typeof stats?.notes === "number" ? `${stats.notes} notes` : null,
      typeof stats?.chunks === "number" ? `${stats.chunks} chunks` : null,
    ].filter((value): value is string => typeof value === "string");
    return details.join(" · ");
  }

  private renderIndexStatus(status: KbStatus): void {
    if (!this.indexStatsEl) {
      return;
    }

    this.indexStatsEl.empty();

    const statGrid = this.indexStatsEl.createDiv({ cls: "obsidian-kb-stat-grid" });
    let renderedStats = 0;
    for (const [key, label] of INDEX_STAT_KEYS) {
      const value = status.index?.stats?.[key];
      if (typeof value === "number") {
        this.renderStat(statGrid, label, value.toLocaleString());
        renderedStats += 1;
      }
    }

    if (renderedStats === 0) {
      this.renderEmpty(statGrid, "No index stats available.");
    }

    const details = this.indexStatsEl.createDiv({ cls: "obsidian-kb-index-details" });
    this.renderDetail(details, "Vault", status.vault_path ?? "unknown");
    this.renderDetail(
      details,
      "Index",
      status.index?.available ? "available" : "missing",
    );
    if (status.index?.error) {
      this.renderDetail(details, "Index error", status.index.error);
    }
    this.renderDetail(
      details,
      "Vector embedder",
      formatLoaded(status.mcp?.vector_embedder_loaded),
    );
    this.renderDetail(
      details,
      "Vector embeddings",
      formatLoaded(status.mcp?.vector_embeddings_loaded),
    );
    if (typeof status.mcp?.vector_embedding_count === "number") {
      this.renderDetail(
        details,
        "Vector count",
        status.mcp.vector_embedding_count.toLocaleString(),
      );
    }
    if (typeof status.mcp?.idle_unload_seconds === "number") {
      this.renderDetail(
        details,
        "Idle unload",
        `${status.mcp.idle_unload_seconds.toLocaleString()}s`,
      );
    }
  }

  private renderStat(container: HTMLElement, label: string, value: string): void {
    const stat = container.createDiv({ cls: "obsidian-kb-stat" });
    stat.createDiv({ cls: "obsidian-kb-stat-value", text: value });
    stat.createDiv({ cls: "obsidian-kb-stat-label", text: label });
  }

  private renderDetail(container: HTMLElement, label: string, value: string): void {
    const row = container.createDiv({ cls: "obsidian-kb-index-detail" });
    row.createSpan({ cls: "obsidian-kb-index-detail-label", text: label });
    row.createSpan({ cls: "obsidian-kb-index-detail-value", text: value });
  }

  private async refreshIndex(rebuild = false): Promise<void> {
    this.setActiveTab("index");
    let completed = false;
    await this.withBusy(
      rebuild ? "Rebuilding index" : "Refreshing index",
      this.indexStatsEl,
      async () => {
        await this.plugin.client.refreshIndex(rebuild ? { rebuild: true } : {});
        completed = true;
      },
    );

    if (completed) {
      new Notice(rebuild ? "obsidian-kb index rebuilt" : "obsidian-kb index refreshed");
    }
  }

  private async withBusy(
    label: string,
    contentEl: HTMLElement,
    operation: () => Promise<void>,
    refreshAfter = true,
  ): Promise<void> {
    this.setStatus(`${label}...`);
    contentEl.toggleClass("is-loading", true);
    try {
      await operation();
      if (refreshAfter) {
        await this.refreshStatus();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.renderError(contentEl, message);
      this.setStatus(message);
    } finally {
      contentEl.toggleClass("is-loading", false);
    }
  }

  private renderHits(hits: KbSearchHit[]): void {
    this.searchResultsEl.empty();
    if (hits.length === 0) {
      this.renderEmpty(this.searchResultsEl, "No result.");
      return;
    }

    for (const hit of hits) {
      this.renderResultCard(this.searchResultsEl, {
        path: hit.path ?? hit.note_path ?? "",
        title: hit.title,
        heading: hit.heading_path ?? hit.heading,
        lineStart: hit.line_start,
        snippet: hit.snippet ?? hit.text,
        score: hit.final_score ?? hit.score,
        tags: getLabels(hit),
      });
    }
  }

  private renderRelated(notes: RelatedNote[]): void {
    this.relatedResultsEl.empty();
    if (notes.length === 0) {
      this.renderEmpty(this.relatedResultsEl, "No related note.");
      return;
    }

    for (const note of notes) {
      const bestChunk = note.chunks?.[0];
      this.renderResultCard(this.relatedResultsEl, {
        path: note.path ?? note.note_path ?? bestChunk?.path ?? bestChunk?.note_path ?? "",
        title: note.title ?? bestChunk?.title,
        heading:
          getStringProperty(note, "heading_path") ??
          getStringProperty(note, "heading") ??
          bestChunk?.heading_path ??
          bestChunk?.heading,
        lineStart: getNumberProperty(note, "line_start") ?? bestChunk?.line_start,
        score: note.score ?? note.best_score,
        tags: mergeLabels(getLabels(note), getLabels(bestChunk)),
      });
    }
  }

  private renderResultCard(
    container: HTMLElement,
    result: ResultCardData,
  ): void {
    const card = container.createDiv({ cls: "obsidian-kb-result" });
    const titleRow = card.createDiv({ cls: "obsidian-kb-result-title-row" });
    const title = titleRow.createEl("a", {
      cls: "obsidian-kb-result-title",
      text: result.title || basename(result.path) || result.path,
      attr: {
        href: "#",
      },
    });
    title.addEventListener("click", (event) => {
      event.preventDefault();
      void this.openResult(result);
    });

    if (typeof result.score === "number") {
      titleRow.createSpan({
        cls: "obsidian-kb-score",
        text: result.score.toFixed(3),
      });
    }

    const location = card.createEl("a", {
      cls: "obsidian-kb-location",
      attr: {
        href: "#",
      },
    });
    location.createSpan({ cls: "obsidian-kb-location-path", text: result.path });
    if (result.heading) {
      location.createSpan({ cls: "obsidian-kb-location-separator", text: "·" });
      location.createSpan({
        cls: "obsidian-kb-location-heading",
        text: result.heading,
      });
    }
    location.addEventListener("click", (event) => {
      event.preventDefault();
      void this.openResult(result);
    });

    if (result.snippet) {
      card.createDiv({
        cls: "obsidian-kb-snippet",
        text: normalizeWhitespace(result.snippet),
      });
    }

    if (result.tags?.length) {
      const tags = card.createDiv({ cls: "obsidian-kb-tags" });
      for (const tag of result.tags.slice(0, 6)) {
        tags.createSpan({ cls: "obsidian-kb-tag", text: tag });
      }
    }
  }

  private async openResult(result: ResultCardData): Promise<void> {
    if (!result.path) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(result.path);
    const openState = getLineOpenState(result.lineStart);
    const headingLink = result.heading
      ? `${result.path}#${lastHeading(result.heading)}`
      : null;

    if (file instanceof TFile && openState) {
      await this.app.workspace.getLeaf(false).openFile(file, openState);
      return;
    }

    if (headingLink) {
      await this.app.workspace.openLinkText(headingLink, "", false, openState);
      return;
    }

    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }

    await this.app.workspace.openLinkText(result.path, "", false, openState);
  }

  private renderEmpty(container: HTMLElement, message: string): void {
    container.empty();
    container.createDiv({ cls: "obsidian-kb-empty", text: message });
  }

  private renderError(container: HTMLElement, message: string): void {
    container.empty();
    container.createDiv({ cls: "obsidian-kb-error", text: message });
  }

  private setStatus(message: string): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.dataset.state = this.serviceState;
  }
}

function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatLoaded(value: boolean | undefined): string {
  if (typeof value !== "boolean") {
    return "unknown";
  }
  return value ? "loaded" : "not loaded";
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() ? property : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" && Number.isFinite(property)
    ? property
    : undefined;
}

function getLabels(value: unknown): string[] {
  return mergeLabels(
    getStringListProperty(value, "tags"),
    getStringListProperty(value, "labels"),
  ) ?? [];
}

function getStringListProperty(value: unknown, key: string): string[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const property = (value as Record<string, unknown>)[key];
  if (Array.isArray(property)) {
    return property.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof property === "string" && property.trim()) {
    return [property];
  }
  return undefined;
}

function mergeLabels(...labelGroups: Array<string[] | undefined>): string[] | undefined {
  const labels = labelGroups.flatMap((group) => group ?? []);
  const uniqueLabels = [...new Set(labels)];
  return uniqueLabels.length > 0 ? uniqueLabels : undefined;
}

function getLineOpenState(
  lineStart: number | undefined,
): { active: true; eState: { line: number } } | undefined {
  if (typeof lineStart !== "number" || !Number.isFinite(lineStart)) {
    return undefined;
  }
  return {
    active: true,
    eState: {
      line: Math.max(0, Math.floor(lineStart) - 1),
    },
  };
}

function lastHeading(heading: string): string {
  return heading
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean)
    .pop() ?? heading;
}
