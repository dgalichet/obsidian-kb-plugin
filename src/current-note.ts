import type { App } from "obsidian";
import { MarkdownView } from "obsidian";
import { randomUUID } from "crypto";
import type { CurrentNoteIdentity, WorkspaceContextUpdate } from "./types";
import { WorkspaceContextUnsupportedError } from "./workspace-context-error";

export interface WorkspaceContextTransport {
  publishWorkspaceContext(context: WorkspaceContextUpdate): Promise<void>;
  clearWorkspaceContext(identity: {
    vault_path: string;
    session_id: string;
  }): Promise<void>;
}

/** Resolve an open Markdown note, retaining it when a sidebar takes focus. */
export function currentNoteIdentity(app: App): CurrentNoteIdentity | null {
  const file = app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    return null;
  }
  const isOpen = app.workspace.getLeavesOfType("markdown").some((leaf) =>
    leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path,
  );
  return isOpen ? { path: file.path, title: file.basename } : null;
}

/** Publish identity only; the context version is not a note content revision. */
export class CurrentNotePublisher {
  private readonly sessionId = randomUUID();
  private contextVersion = 0;
  private note: CurrentNoteIdentity | null = null;
  private debounceTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private pending = false;
  private stopped = false;
  private running: Promise<void> | null = null;
  private lastTransport: WorkspaceContextTransport | null = null;
  private upgradeNoticeShown = false;

  constructor(
    private readonly vaultPath: string,
    private readonly readNote: () => CurrentNoteIdentity | null,
    private readonly transport: () => WorkspaceContextTransport,
    private readonly onUnsupported: () => void = () => {},
  ) {}

  start(): void {
    if (this.stopped || this.heartbeatTimer !== null) {
      return;
    }
    this.refresh();
    this.heartbeatTimer = window.setInterval(() => this.refresh(true), 20_000);
  }

  refresh(immediate = false): void {
    if (this.stopped) {
      return;
    }
    const note = this.readNote();
    if (
      this.contextVersion === 0 ||
      note?.path !== this.note?.path || note?.title !== this.note?.title
    ) {
      this.contextVersion += 1;
      this.note = note ? { ...note } : null;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (immediate) {
      this.enqueue();
    } else {
      this.debounceTimer = window.setTimeout(() => {
        this.debounceTimer = null;
        this.enqueue();
      }, 150);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.pending = false;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
    }
    // Clear after any in-flight publication so it cannot resurrect the session.
    await this.running;
    if (this.lastTransport) {
      await this.clear(this.lastTransport);
    }
  }

  private enqueue(): void {
    if (this.stopped) {
      return;
    }
    this.pending = true;
    if (!this.running) {
      this.running = this.flush().finally(() => {
        this.running = null;
        if (this.pending && !this.stopped) {
          this.enqueue();
        }
      });
    }
  }

  private async flush(): Promise<void> {
    while (this.pending && !this.stopped) {
      this.pending = false;
      const client = this.transport();
      if (this.lastTransport && this.lastTransport !== client) {
        await this.clear(this.lastTransport);
      }
      this.lastTransport = client;
      const update: WorkspaceContextUpdate = {
        vault_path: this.vaultPath,
        session_id: this.sessionId,
        context_version: this.contextVersion,
        note: this.note ? { ...this.note } : null,
      };
      try {
        await client.publishWorkspaceContext(update);
      } catch (error) {
        if (
          error instanceof WorkspaceContextUnsupportedError &&
          !this.upgradeNoticeShown && !this.stopped
        ) {
          this.upgradeNoticeShown = true;
          try {
            this.onUnsupported();
          } catch {
            // UI feedback must not turn an optional feature into a failure.
          }
        }
        // An older/stopped service must not disrupt Obsidian. The next
        // heartbeat retries the latest context, including after a restart.
      }
    }
  }

  private async clear(client: WorkspaceContextTransport): Promise<void> {
    try {
      await client.clearWorkspaceContext({
        vault_path: this.vaultPath,
        session_id: this.sessionId,
      });
    } catch {
      // Expiration covers abrupt shutdown and unavailable services.
    }
  }
}
