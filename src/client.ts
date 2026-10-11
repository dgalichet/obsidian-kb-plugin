import { requestUrl } from "obsidian";
import { request as httpRequest } from "http";
import { WorkspaceContextUnsupportedError } from "./workspace-context-error";
import type {
  KbHealth,
  KbChunkRecord,
  KbSearchHit,
  KbSearchRequest,
  KbStatus,
  RelatedReport,
  WorkspaceContextUpdate,
} from "./types";

interface JsonRpcResponse {
  result?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
    isError?: boolean;
  };
  error?: {
    message?: string;
  };
}

export class ObsidianKbClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<KbHealth> {
    return this.getJson<KbHealth>("/health");
  }

  async status(): Promise<KbStatus> {
    return this.getJson<KbStatus>("/status");
  }

  async search(request: KbSearchRequest): Promise<KbSearchHit[]> {
    return this.postJson<KbSearchHit[]>("/search", request);
  }

  async showChunk(chunkId: string): Promise<KbChunkRecord> {
    return this.postJson<KbChunkRecord>("/show", { chunk_id: chunkId });
  }

  async relatedByNote(
    note: string,
    top: number,
    candidates = 0,
  ): Promise<RelatedReport> {
    return this.callMcpTool<RelatedReport>("related", { note, top, candidates });
  }

  async relatedByText(
    text: string,
    top: number,
    candidates = 0,
  ): Promise<RelatedReport> {
    return this.callMcpTool<RelatedReport>("related", { text, top, candidates });
  }

  async refreshIndex(options: {
    rebuild?: boolean;
    no_embeddings?: boolean;
  } = {}): Promise<unknown> {
    return this.postJson<unknown>("/index/refresh", options);
  }

  async shutdown(): Promise<void> {
    await this.postJson<unknown>("/shutdown", {});
  }

  async publishWorkspaceContext(context: WorkspaceContextUpdate): Promise<void> {
    await this.workspaceRequest("POST", context);
  }

  async clearWorkspaceContext(identity: {
    vault_path: string;
    session_id: string;
  }): Promise<void> {
    await this.workspaceRequest("DELETE", identity);
  }

  private workspaceRequest(method: "POST" | "DELETE", body: unknown): Promise<void> {
    const url = new URL(`${this.baseUrl}/workspace/context`);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      return Promise.reject(new Error("Workspace context requires a loopback HTTP service"));
    }
    // serve binds IPv4 loopback; avoid IPv6-only localhost resolution on older
    // Electron versions and keep this channel independent of DNS resolution.
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      // Native HTTP keeps this desktop-only context channel bounded and
      // cancellable, including if the service accepts but never responds.
      const request = httpRequest(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      }, (response) => {
        response.on("error", (error) => {
          window.clearTimeout(deadline);
          reject(error);
        });
        response.resume();
        response.on("end", () => {
          window.clearTimeout(deadline);
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
          } else if (method === "POST" && (status === 404 || status === 405)) {
            reject(new WorkspaceContextUnsupportedError());
          } else {
            reject(new Error(`Workspace context returned HTTP ${status}`));
          }
        });
      });
      const deadline = window.setTimeout(() => {
        request.destroy(new Error("Workspace context request timed out"));
      }, 3000);
      request.on("error", (error) => {
        window.clearTimeout(deadline);
        reject(error);
      });
      request.end(data);
    });
  }

  private async callMcpTool<T>(
    name: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.postJson<JsonRpcResponse>("/mcp", {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name,
        arguments: argumentsValue,
      },
    });

    if (response.error?.message) {
      throw new Error(response.error.message);
    }

    if (response.result?.isError) {
      const message = response.result.content?.[0]?.text ?? "MCP tool failed";
      throw new Error(message);
    }

    const text = response.result?.content?.[0]?.text;
    if (!text) {
      throw new Error("MCP response did not include JSON content");
    }

    return JSON.parse(text) as T;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method: "GET",
      throw: false,
    });
    return parseJsonResponse<T>(response.status, response.text);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
      throw: false,
    });
    return parseJsonResponse<T>(response.status, response.text);
  }
}

function parseJsonResponse<T>(status: number, text: string): T {
  let parsed: unknown = null;
  if (text.trim()) {
    parsed = JSON.parse(text);
  }

  if (status < 200 || status >= 300) {
    const message =
      getErrorMessage(parsed) ?? `obsidian-kb returned HTTP ${status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function getErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const maybeError = (value as { error?: unknown }).error;
  if (!maybeError || typeof maybeError !== "object") {
    return null;
  }
  const message = (maybeError as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
