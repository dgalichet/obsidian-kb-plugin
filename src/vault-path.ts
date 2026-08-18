import { posix, win32 } from "node:path";

const WINDOWS_EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";
const WINDOWS_EXTENDED_PREFIX = "\\\\?\\";

export function normalizeVaultPath(value: string, isWindows: boolean): string {
  if (!value) {
    return value;
  }

  return isWindows ? normalizeWindowsPath(value) : normalizePosixPath(value);
}

function normalizeWindowsPath(value: string): string {
  let normalized = value.replace(/\//g, "\\");
  if (normalized.toUpperCase().startsWith(WINDOWS_EXTENDED_UNC_PREFIX)) {
    normalized = "\\\\" + normalized.slice(WINDOWS_EXTENDED_UNC_PREFIX.length);
  } else if (normalized.startsWith(WINDOWS_EXTENDED_PREFIX)) {
    normalized = normalized.slice(WINDOWS_EXTENDED_PREFIX.length);
  }

  normalized = win32.normalize(normalized);
  return stripTrailingSeparators(normalized, win32.parse(normalized).root, "\\").toLowerCase();
}

function normalizePosixPath(value: string): string {
  const normalized = posix.normalize(value);
  return stripTrailingSeparators(normalized, posix.parse(normalized).root, "/");
}

function stripTrailingSeparators(
  value: string,
  root: string,
  separator: "\\" | "/",
): string {
  let normalized = value;
  while (normalized.length > root.length && normalized.endsWith(separator)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
