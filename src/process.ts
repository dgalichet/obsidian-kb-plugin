import type { App } from "obsidian";
import { FileSystemAdapter, Notice, Platform } from "obsidian";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { delimiter, isAbsolute, join } from "path";
import { homedir } from "os";
import type { ObsidianKbSettings } from "./types";

const DEFAULT_EXECUTABLE = "obsidian-kb";
const EXTRA_EXECUTABLE_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  "/usr/bin",
  "/bin",
];

export class ObsidianKbProcessManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lastOutput = "";

  constructor(
    private readonly app: App,
    private readonly settingsProvider: () => ObsidianKbSettings,
  ) {}

  get isManagedProcessRunning(): boolean {
    return this.child !== null;
  }

  get output(): string {
    return this.lastOutput;
  }

  resolveVaultPath(): string {
    const settings = this.settingsProvider();
    if (settings.vaultPath.trim()) {
      return expandHome(settings.vaultPath.trim());
    }

    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }

    const unsafeAdapter = adapter as unknown as {
      basePath?: string;
      getBasePath?: () => string;
    };
    return unsafeAdapter.getBasePath?.() ?? unsafeAdapter.basePath ?? "";
  }

  resolveConfigPath(): string {
    const settings = this.settingsProvider();
    const configuredPath = settings.configPath.trim();
    const vaultPath = this.resolveVaultPath();
    if (!configuredPath) {
      return join(vaultPath, ".obsidian-kb.toml");
    }

    const expanded = expandHome(configuredPath);
    return isAbsolute(expanded) ? expanded : join(vaultPath, expanded);
  }

  resolveExecutablePath(): string | null {
    return resolveExecutablePath(this.settingsProvider().executablePath);
  }

  configFileExists(): boolean {
    return existsSync(this.resolveConfigPath());
  }

  async startServe(): Promise<void> {
    if (!Platform.isDesktopApp) {
      throw new Error("obsidian-kb can only be launched from Obsidian Desktop");
    }
    if (this.child) {
      return;
    }

    const settings = this.settingsProvider();
    const vaultPath = this.resolveVaultPath();
    if (!vaultPath) {
      throw new Error("Unable to resolve the current vault path");
    }

    const args = [
      "serve",
      "--vault",
      vaultPath,
      "--port",
      String(settings.port),
    ];
    addOptionalPathArg(args, "--config", settings.configPath);

    if (settings.preloadEmbedder) {
      args.push("--preload-embedder");
    }
    if (settings.idleUnloadSeconds >= 0) {
      args.push("--idle-unload-seconds", String(settings.idleUnloadSeconds));
    }

    const executablePath = resolveExecutablePath(settings.executablePath);
    if (!executablePath) {
      throw missingExecutableError(settings.executablePath);
    }

    this.lastOutput = "";
    this.child = spawn(executablePath, args, {
      cwd: vaultPath,
      env: processEnvWithExtraPath(),
      stdio: "pipe",
    });

    this.child.stdout.on("data", (data: Buffer) => {
      this.appendOutput(data.toString());
    });
    this.child.stderr.on("data", (data: Buffer) => {
      this.appendOutput(data.toString());
    });
    this.child.on("error", (error) => {
      const message = processStartErrorMessage(error, settings.executablePath);
      this.appendOutput(message);
      this.child = null;
      new Notice(`obsidian-kb failed to start: ${message}`);
    });
    this.child.on("exit", (code, signal) => {
      this.appendOutput(`obsidian-kb exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      this.child = null;
    });
  }

  async stopServe(): Promise<void> {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    await terminateChild(child);
  }

  stopServeNow(): void {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      this.appendOutput(error instanceof Error ? error.message : String(error));
    }
  }

  async runInit(): Promise<string> {
    const settings = this.settingsProvider();
    const args = ["init", "--vault", this.resolveVaultPath()];
    addOptionalPathArg(args, "--config", settings.configPath);
    addOptionalPathArg(args, "--index-dir", settings.indexDir);
    return this.runCommand(args);
  }

  async runDoctor(): Promise<string> {
    const settings = this.settingsProvider();
    const args = ["doctor", "--vault", this.resolveVaultPath(), "--json"];
    addOptionalPathArg(args, "--config", settings.configPath);
    return this.runCommand(args);
  }

  private async runCommand(args: string[]): Promise<string> {
    const settings = this.settingsProvider();
    const vaultPath = this.resolveVaultPath();
    if (!vaultPath) {
      throw new Error("Unable to resolve the current vault path");
    }

    return new Promise((resolve, reject) => {
      const executablePath = resolveExecutablePath(settings.executablePath);
      if (!executablePath) {
        reject(missingExecutableError(settings.executablePath));
        return;
      }

      const child = spawn(executablePath, args, {
        cwd: vaultPath,
        env: processEnvWithExtraPath(),
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error((stderr || stdout).trim() || `obsidian-kb exited with ${code}`));
        }
      });
    });
  }

  private appendOutput(text: string): void {
    this.lastOutput = `${this.lastOutput}${text}`.slice(-4000);
  }
}

function resolveExecutablePath(configuredPath: string): string | null {
  const executable = configuredPath.trim() || DEFAULT_EXECUTABLE;
  const expanded = expandHome(executable);
  if (hasPathSeparator(expanded)) {
    return isExecutable(expanded) ? expanded : null;
  }

  for (const directory of executableSearchDirs()) {
    const candidate = join(directory, expanded);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function executableSearchDirs(): string[] {
  const pathDirs = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return unique([...pathDirs, ...EXTRA_EXECUTABLE_DIRS]);
}

function processEnvWithExtraPath(): NodeJS.ProcessEnv {
  const pathValue = unique([...EXTRA_EXECUTABLE_DIRS, ...(process.env.PATH ?? "").split(delimiter)])
    .filter(Boolean)
    .join(delimiter);
  return {
    ...process.env,
    PATH: pathValue,
  };
}

function addOptionalPathArg(args: string[], flag: string, value: string): void {
  const path = value.trim();
  if (path) {
    args.push(flag, expandHome(path));
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function missingExecutableError(configuredPath: string): Error {
  const executable = configuredPath.trim() || DEFAULT_EXECUTABLE;
  return new Error(
    `Cannot find executable "${executable}". Set an absolute path in settings, for example /opt/homebrew/bin/obsidian-kb.`,
  );
}

function processStartErrorMessage(error: Error, configuredPath: string): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return missingExecutableError(configuredPath).message;
  }
  return error.message;
}

function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: number | null = null;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        window.clearTimeout(timeout);
      }
      resolve();
    };

    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }

    timeout = window.setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
      finish();
    }, 1500);
  });
}
