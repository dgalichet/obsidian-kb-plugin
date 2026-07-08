import {
  HoverPopover,
  ItemView,
  MarkdownRenderer,
  Notice,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { OBSIDIAN_KB_ICON_ID } from "./icons";
import type ObsidianKbPlugin from "./main";
import type {
  KbChunkRecord,
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
  documentKind?: string;
  title?: string;
  heading?: string;
  chunkId?: string;
  lineStart?: number;
  lineEnd?: number;
  startPage?: number;
  endPage?: number;
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
  private contextTrayEls: HTMLElement[] = [];
  private readonly tabButtons: Partial<Record<KbTab, HTMLElement>> = {};
  private readonly tabPanels: Partial<Record<KbTab, HTMLElement>> = {};
  private readonly contextItems = new Map<string, ResultCardData>();
  private activeTab: KbTab = "search";
  private relatedLoadedNotePath: string | null = null;
  private relatedLoadedTop: number | null = null;
  private relatedRequestId = 0;
  private chunkPreviewRequestId = 0;
  private chunkPreviewPopover: HoverPopover | null = null;
  private readonly chunkPreviewCache = new Map<string, Promise<KbChunkRecord>>();
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
    this.closeChunkPreview();
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
    this.contextTrayEls = [];

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
    this.registerContextTray(panel);
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
    this.registerContextTray(panel);
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
    this.renderDetail(details, "MCP endpoint", this.plugin.getMcpEndpoint());
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
      this.renderResultCard(
        this.searchResultsEl,
        toSearchResultCardData(hit, this.plugin.settings.includeText),
      );
    }
  }

  private renderRelated(notes: RelatedNote[]): void {
    this.relatedResultsEl.empty();
    if (notes.length === 0) {
      this.renderEmpty(this.relatedResultsEl, "No related note.");
      return;
    }

    for (const note of notes) {
      this.renderResultCard(
        this.relatedResultsEl,
        toRelatedResultCardData(note, this.plugin.settings.includeText),
      );
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
    this.registerResultPreview(title, result);

    const meta = titleRow.createDiv({ cls: "obsidian-kb-result-meta" });
    if (typeof result.score === "number") {
      meta.createSpan({
        cls: "obsidian-kb-score",
        text: result.score.toFixed(3),
      });
    }
    this.renderResultActions(meta, result);

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
    this.registerResultPreview(location, result);

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

  private renderResultActions(container: HTMLElement, result: ResultCardData): void {
    const actions = container.createDiv({ cls: "obsidian-kb-result-actions" });

    this.createResultAction(actions, "copy", "Copy link", (button) => {
      void this.copyResultLink(result, button);
    });
    this.createResultAction(actions, "corner-down-left", "Insert link", (button) => {
      void this.insertResultLink(result, button);
    });
    this.createResultAction(actions, "list-plus", "Add to context", (button) => {
      this.addResultToContext(result, button);
    });
    this.createResultAction(actions, "clipboard-copy", "Copy context", (button) => {
      void this.copyResultContext(result, button);
    });
  }

  private createResultAction(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: (button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "obsidian-kb-result-action",
      attr: {
        type: "button",
        "aria-label": label,
        title: label,
      },
    });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(button);
    });
    return button;
  }

  private async copyResultLink(
    result: ResultCardData,
    button?: HTMLButtonElement,
  ): Promise<void> {
    const link = formatResultWikilink(result);
    if (!link) {
      new Notice("No link available");
      return;
    }
    await this.copyText(link, "Link copied");
    this.markActionButton(button);
  }

  private async insertResultLink(
    result: ResultCardData,
    button?: HTMLButtonElement,
  ): Promise<void> {
    const link = formatResultWikilink(result);
    if (!link) {
      new Notice("No link available");
      return;
    }

    const editor = this.app.workspace.activeEditor?.editor;
    if (!editor) {
      new Notice("No active note editor");
      return;
    }

    editor.replaceSelection(link);
    new Notice("Link inserted");
    this.markActionButton(button);
  }

  private addResultToContext(
    result: ResultCardData,
    button?: HTMLButtonElement,
  ): void {
    const key = getContextItemKey(result);
    if (!result.path) {
      new Notice("No result path available");
      return;
    }
    if (this.contextItems.has(key)) {
      new Notice("Result already in context");
      return;
    }

    this.contextItems.set(key, result);
    this.renderContextTrays();
    this.markActionButton(button);
    new Notice("Added to context");
  }

  private async copyResultContext(
    result: ResultCardData,
    button?: HTMLButtonElement,
  ): Promise<void> {
    const context = await this.formatContextBundle([result]);
    await this.copyText(context, "Context copied");
    this.markActionButton(button);
  }

  private registerContextTray(panel: HTMLElement): void {
    const tray = panel.createDiv({ cls: "obsidian-kb-context-tray" });
    this.contextTrayEls.push(tray);
    this.renderContextTray(tray);
  }

  private renderContextTrays(): void {
    for (const tray of this.contextTrayEls) {
      this.renderContextTray(tray);
    }
  }

  private renderContextTray(tray: HTMLElement): void {
    tray.empty();
    const items = [...this.contextItems.entries()];
    tray.hidden = items.length === 0;
    if (items.length === 0) {
      return;
    }

    const header = tray.createDiv({ cls: "obsidian-kb-context-header" });
    header.createDiv({
      cls: "obsidian-kb-context-title",
      text: `${items.length.toLocaleString()} selected`,
    });

    const actions = header.createDiv({ cls: "obsidian-kb-context-actions" });
    actions
      .createEl("button", { text: "Copy context", cls: "mod-cta" })
      .addEventListener("click", () => void this.copySelectedContext());
    actions
      .createEl("button", { text: "Clear" })
      .addEventListener("click", () => this.clearContext());

    const list = tray.createDiv({ cls: "obsidian-kb-context-list" });
    for (const [key, item] of items) {
      const chip = list.createDiv({ cls: "obsidian-kb-context-chip" });
      chip.createSpan({
        cls: "obsidian-kb-context-chip-title",
        text: item.title || basename(item.path) || item.path,
      });
      const remove = chip.createEl("button", {
        cls: "obsidian-kb-context-remove",
        attr: {
          type: "button",
          "aria-label": "Remove",
          title: "Remove",
        },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.contextItems.delete(key);
        this.renderContextTrays();
      });
    }
  }

  private async copySelectedContext(): Promise<void> {
    const items = [...this.contextItems.values()];
    if (items.length === 0) {
      new Notice("No selected context");
      return;
    }

    const context = await this.formatContextBundle(items);
    await this.copyText(context, "Context copied");
  }

  private clearContext(): void {
    this.contextItems.clear();
    this.renderContextTrays();
    new Notice("Context cleared");
  }

  private async formatContextBundle(results: ResultCardData[]): Promise<string> {
    const sections = await Promise.all(
      results.map((result, index) => this.formatResultContext(result, index + 1)),
    );
    return ["## Vault Knowledge Base context", "", ...sections].join("\n");
  }

  private async formatResultContext(
    result: ResultCardData,
    index: number,
  ): Promise<string> {
    const lines = [`### ${index}. ${result.title || basename(result.path) || result.path}`];
    const link = formatResultWikilink(result);
    if (link) {
      lines.push(`- Link: ${link}`);
    }
    if (result.path) {
      lines.push(`- Path: ${formatInlineCode(result.path)}`);
    }
    const location = formatResultLocation(result);
    if (location) {
      lines.push(`- Location: ${location}`);
    }
    if (typeof result.score === "number") {
      lines.push(`- Score: ${result.score.toFixed(3)}`);
    }
    if (result.tags?.length) {
      lines.push(`- Tags: ${result.tags.join(", ")}`);
    }
    if (result.chunkId) {
      lines.push(`- Chunk ID: ${formatInlineCode(result.chunkId)}`);
    }

    const text = await this.getResultContextText(result);
    if (text) {
      lines.push("", "```text", sanitizeFenceText(text), "```");
    }

    return lines.join("\n");
  }

  private async getResultContextText(result: ResultCardData): Promise<string | null> {
    const maxChars = Math.max(500, this.plugin.settings.maxChars);
    if (result.chunkId) {
      try {
        const chunk = await this.loadPreviewChunk(result.chunkId);
        const text = chunk.text.trim();
        if (text) {
          return truncateText(text, maxChars);
        }
      } catch {
        // Fall back to the snippet already returned by search.
      }
    }

    return result.snippet ? truncateText(normalizeWhitespace(result.snippet), maxChars) : null;
  }

  private async copyText(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(message);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private markActionButton(button: HTMLButtonElement | undefined): void {
    if (!button) {
      return;
    }
    button.addClass("is-confirmed");
    window.setTimeout(() => button.removeClass("is-confirmed"), 900);
  }

  private async openResult(result: ResultCardData): Promise<void> {
    if (!result.path) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(result.path);
    const openState = getLineOpenState(result.lineStart);
    const pdfPageLink = getPdfPageLinkText(result.path, result.startPage);
    const headingLink = result.heading
      ? `${result.path}#${lastHeading(result.heading)}`
      : null;

    if (pdfPageLink) {
      await this.app.workspace.openLinkText(pdfPageLink, "", false);
      return;
    }

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

  private registerResultPreview(linkEl: HTMLElement, result: ResultCardData): void {
    linkEl.addEventListener("mouseenter", (event) => {
      if (isPdfResult(result) && !result.startPage && result.chunkId) {
        void this.openChunkPreview(linkEl, result, event);
        return;
      }
      this.closeChunkPreview();
      this.triggerNativePreview(linkEl, result, event);
    });
  }

  private async openChunkPreview(
    linkEl: HTMLElement,
    result: ResultCardData,
    event: MouseEvent,
  ): Promise<void> {
    if (!result.chunkId) {
      this.triggerNativePreview(linkEl, result, event);
      return;
    }

    this.disposeChunkPreview();
    const requestId = ++this.chunkPreviewRequestId;
    const popover = new HoverPopover(this.leaf, linkEl, 250);
    this.chunkPreviewPopover = popover;
    const contentEl = popover.hoverEl.createDiv({ cls: "obsidian-kb-preview" });
    contentEl.createDiv({
      cls: "obsidian-kb-preview-loading",
      text: "Loading preview...",
    });

    try {
      const chunk = await this.loadPreviewChunk(result.chunkId);
      if (
        requestId !== this.chunkPreviewRequestId ||
        this.chunkPreviewPopover !== popover
      ) {
        return;
      }
      const pageLink = getPdfPageLinkText(chunk.note_path, chunk.start_page);
      if (pageLink) {
        this.disposeChunkPreview();
        this.triggerNativePreview(
          linkEl,
          {
            ...result,
            path: chunk.note_path,
            documentKind: chunk.document_kind,
            startPage: chunk.start_page,
            endPage: chunk.end_page,
          },
          event,
        );
        return;
      }
      await this.renderChunkPreview(popover, chunk);
    } catch {
      if (this.chunkPreviewPopover === popover) {
        this.disposeChunkPreview();
      }
      this.triggerNativePreview(linkEl, result, event);
    }
  }

  private async renderChunkPreview(
    popover: HoverPopover,
    chunk: KbChunkRecord,
  ): Promise<void> {
    popover.hoverEl.empty();
    const container = popover.hoverEl.createDiv({ cls: "obsidian-kb-preview" });

    const header = container.createDiv({ cls: "obsidian-kb-preview-header" });
    header.createDiv({
      cls: "obsidian-kb-preview-title",
      text: chunk.title || basename(chunk.note_path),
    });

    const location = formatPreviewLocation(chunk);
    if (location) {
      header.createDiv({ cls: "obsidian-kb-preview-location", text: location });
    }

    const body = container.createDiv({
      cls: "obsidian-kb-preview-body markdown-rendered",
    });
    if (chunk.text.trim()) {
      await MarkdownRenderer.render(
        this.app,
        chunk.text,
        body,
        chunk.note_path,
        popover,
      );
    } else {
      body.createDiv({ cls: "obsidian-kb-empty", text: "No chunk text." });
    }
  }

  private loadPreviewChunk(chunkId: string): Promise<KbChunkRecord> {
    const cached = this.chunkPreviewCache.get(chunkId);
    if (cached) {
      return cached;
    }

    const request = this.plugin.client.showChunk(chunkId).catch((error) => {
      this.chunkPreviewCache.delete(chunkId);
      throw error;
    });
    this.chunkPreviewCache.set(chunkId, request);
    return request;
  }

  private disposeChunkPreview(): void {
    if (!this.chunkPreviewPopover) {
      return;
    }
    this.chunkPreviewPopover.unload();
    this.chunkPreviewPopover = null;
  }

  private closeChunkPreview(): void {
    this.chunkPreviewRequestId += 1;
    this.disposeChunkPreview();
  }

  private triggerNativePreview(
    linkEl: HTMLElement,
    result: ResultCardData,
    event: MouseEvent,
  ): void {
    const linktext = getPreviewLinkText(result);
    if (!linktext) {
      return;
    }

    this.app.workspace.trigger("hover-link", {
      event,
      source: "okb",
      hoverParent: this.leaf,
      targetEl: linkEl,
      linktext,
      sourcePath: this.app.workspace.getActiveFile()?.path ?? "",
    });
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

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function sanitizeFenceText(value: string): string {
  return value.replace(/```/g, "'''");
}

function toSearchResultCardData(
  hit: KbSearchHit,
  showChunkText: boolean,
): ResultCardData {
  const bestChunk = hit.chunks?.[0];
  return toResultCardData(hit, bestChunk, {
    snippet: showChunkText ? getResultSnippet(hit, bestChunk, true) : undefined,
    score: getNumberProperty(hit, "final_score") ?? getNumberProperty(hit, "score"),
  });
}

function toRelatedResultCardData(
  note: RelatedNote,
  showChunkText: boolean,
): ResultCardData {
  const bestChunk = note.chunks?.[0];
  return toResultCardData(note, bestChunk, {
    snippet: showChunkText ? getResultSnippet(note, bestChunk, false) : undefined,
    score: getNumberProperty(note, "score") ?? getNumberProperty(note, "best_score"),
  });
}

function toResultCardData(
  result: unknown,
  bestChunk: KbSearchHit | undefined,
  overrides: Partial<ResultCardData>,
): ResultCardData {
  return {
    path:
      getStringProperty(result, "path") ??
      getStringProperty(result, "note_path") ??
      bestChunk?.path ??
      bestChunk?.note_path ??
      "",
    documentKind: getStringProperty(result, "document_kind") ?? bestChunk?.document_kind,
    title: getStringProperty(result, "title") ?? bestChunk?.title,
    heading:
      getStringProperty(result, "best_heading") ??
      getStringProperty(result, "heading_path") ??
      getStringProperty(result, "heading") ??
      bestChunk?.heading_path ??
      bestChunk?.heading,
    chunkId:
      getStringProperty(result, "best_chunk_id") ??
      getStringProperty(result, "chunk_id") ??
      bestChunk?.chunk_id,
    lineStart:
      getNumberProperty(result, "best_start_line") ??
      getNumberProperty(result, "line_start") ??
      getNumberProperty(result, "start_line") ??
      bestChunk?.start_line ??
      bestChunk?.line_start,
    lineEnd:
      getNumberProperty(result, "best_end_line") ??
      getNumberProperty(result, "line_end") ??
      getNumberProperty(result, "end_line") ??
      bestChunk?.end_line ??
      bestChunk?.line_end,
    startPage:
      getNumberProperty(result, "best_start_page") ??
      getNumberProperty(result, "start_page") ??
      bestChunk?.start_page,
    endPage:
      getNumberProperty(result, "best_end_page") ??
      getNumberProperty(result, "end_page") ??
      bestChunk?.end_page,
    tags: mergeLabels(getLabels(result), getLabels(bestChunk)),
    ...overrides,
  };
}

function getResultSnippet(
  result: unknown,
  bestChunk: KbSearchHit | undefined,
  includeTextFallback: boolean,
): string | undefined {
  return (
    getStringProperty(result, "best_snippet") ??
    getStringProperty(result, "snippet") ??
    bestChunk?.best_snippet ??
    bestChunk?.snippet ??
    (includeTextFallback
      ? getStringProperty(result, "text") ?? bestChunk?.text
      : undefined)
  );
}

function formatPreviewLocation(chunk: KbChunkRecord): string {
  const parts = [chunk.note_path];
  if (chunk.heading_path) {
    parts.push(chunk.heading_path);
  }
  if (typeof chunk.start_page === "number") {
    const endPage = typeof chunk.end_page === "number" ? chunk.end_page : chunk.start_page;
    parts.push(endPage === chunk.start_page ? `Page ${chunk.start_page}` : `Pages ${chunk.start_page}-${endPage}`);
  } else if (typeof chunk.start_line === "number") {
    const endLine = typeof chunk.end_line === "number" ? chunk.end_line : chunk.start_line;
    parts.push(endLine === chunk.start_line ? `Line ${chunk.start_line}` : `Lines ${chunk.start_line}-${endLine}`);
  }
  return parts.filter(Boolean).join(" · ");
}

function formatResultLocation(result: ResultCardData): string | null {
  if (typeof result.startPage === "number") {
    const endPage = typeof result.endPage === "number" ? result.endPage : result.startPage;
    return endPage === result.startPage ? `Page ${result.startPage}` : `Pages ${result.startPage}-${endPage}`;
  }
  if (typeof result.lineStart === "number") {
    const endLine = typeof result.lineEnd === "number" ? result.lineEnd : result.lineStart;
    return endLine === result.lineStart ? `Line ${result.lineStart}` : `Lines ${result.lineStart}-${endLine}`;
  }
  return result.heading ?? null;
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

function getPreviewLinkText(result: ResultCardData): string | null {
  if (!result.path) {
    return null;
  }
  const pdfPageLink = getPdfPageLinkText(result.path, result.startPage);
  if (pdfPageLink) {
    return pdfPageLink;
  }
  if (!result.heading) {
    return result.path;
  }
  return `${result.path}#${lastHeading(result.heading)}`;
}

function formatResultWikilink(result: ResultCardData): string | null {
  const target = getResultLinkTarget(result);
  return target ? `[[${target}]]` : null;
}

function getResultLinkTarget(result: ResultCardData): string | null {
  if (!result.path) {
    return null;
  }
  const pdfPageLink = getPdfPageLinkText(result.path, result.startPage);
  if (pdfPageLink) {
    return pdfPageLink;
  }
  const path = stripMarkdownExtension(result.path);
  if (!result.heading) {
    return path;
  }
  return `${path}#${lastHeading(result.heading)}`;
}

function stripMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function getContextItemKey(result: ResultCardData): string {
  return [
    result.path,
    result.heading ?? "",
    result.chunkId ?? "",
    result.startPage ?? "",
    result.lineStart ?? "",
  ].join("\u0000");
}

function formatInlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function isPdfResult(result: ResultCardData): boolean {
  return result.documentKind === "pdf" || result.path.toLowerCase().endsWith(".pdf");
}

function getPdfPageLinkText(path: string, page: number | undefined): string | null {
  if (!path.toLowerCase().endsWith(".pdf")) {
    return null;
  }
  if (typeof page !== "number" || !Number.isFinite(page) || page < 1) {
    return null;
  }
  return `${path}#page=${Math.floor(page)}`;
}
