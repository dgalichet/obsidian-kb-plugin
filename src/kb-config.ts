import { existsSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { SearchMode } from "./types";

export interface KbConfigDraft {
  excludeHeadings: string[];
  pdfEnabled: boolean;
  pdfMaxFileSizeMb: number;
  searchDefaultMode: SearchMode;
  searchFinalTopK: number;
  searchBm25Candidates: number;
  searchVectorCandidates: number;
  searchGraphWeight: number;
  searchGraphDepth: number;
  searchGraphMaxNeighbors: number;
}

export const DEFAULT_KB_CONFIG_DRAFT: KbConfigDraft = {
  excludeHeadings: [],
  pdfEnabled: false,
  pdfMaxFileSizeMb: 50,
  searchDefaultMode: "hybrid",
  searchFinalTopK: 10,
  searchBm25Candidates: 80,
  searchVectorCandidates: 80,
  searchGraphWeight: 0.25,
  searchGraphDepth: 1,
  searchGraphMaxNeighbors: 20,
};

export async function readKbConfigDraft(
  configPath: string,
): Promise<KbConfigDraft | null> {
  if (!existsSync(configPath)) {
    return null;
  }

  const content = await readFile(configPath, "utf8");
  return {
    excludeHeadings:
      parseStringArray(findTomlValue(content, "index", "exclude_headings")) ??
      DEFAULT_KB_CONFIG_DRAFT.excludeHeadings,
    pdfEnabled:
      parseBoolean(findTomlValue(content, "index.pdf", "enabled")) ??
      DEFAULT_KB_CONFIG_DRAFT.pdfEnabled,
    pdfMaxFileSizeMb:
      parsePositiveInteger(findTomlValue(content, "index.pdf", "max_file_size_mb")) ??
      DEFAULT_KB_CONFIG_DRAFT.pdfMaxFileSizeMb,
    searchDefaultMode:
      parseSearchMode(findTomlValue(content, "search", "default_mode")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchDefaultMode,
    searchFinalTopK:
      parsePositiveInteger(findTomlValue(content, "search", "final_top_k")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchFinalTopK,
    searchBm25Candidates:
      parsePositiveInteger(findTomlValue(content, "search", "bm25_candidates")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchBm25Candidates,
    searchVectorCandidates:
      parsePositiveInteger(findTomlValue(content, "search", "vector_candidates")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchVectorCandidates,
    searchGraphWeight:
      parseNonNegativeNumber(findTomlValue(content, "search", "graph_weight")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchGraphWeight,
    searchGraphDepth:
      parseNonNegativeInteger(findTomlValue(content, "search", "graph_depth")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchGraphDepth,
    searchGraphMaxNeighbors:
      parsePositiveInteger(findTomlValue(content, "search", "graph_max_neighbors")) ??
      DEFAULT_KB_CONFIG_DRAFT.searchGraphMaxNeighbors,
  };
}

export async function writeKbConfigDraft(
  configPath: string,
  draft: KbConfigDraft,
): Promise<void> {
  const existing = existsSync(configPath)
    ? await readFile(configPath, "utf8")
    : "";
  const next = [
    {
      section: "index",
      key: "exclude_headings",
      value: formatStringArray(draft.excludeHeadings),
    },
    {
      section: "index.pdf",
      key: "enabled",
      value: String(draft.pdfEnabled),
    },
    {
      section: "index.pdf",
      key: "max_file_size_mb",
      value: String(draft.pdfMaxFileSizeMb),
    },
    {
      section: "search",
      key: "default_mode",
      value: JSON.stringify(draft.searchDefaultMode),
    },
    {
      section: "search",
      key: "final_top_k",
      value: String(draft.searchFinalTopK),
    },
    {
      section: "search",
      key: "bm25_candidates",
      value: String(draft.searchBm25Candidates),
    },
    {
      section: "search",
      key: "vector_candidates",
      value: String(draft.searchVectorCandidates),
    },
    {
      section: "search",
      key: "graph_weight",
      value: String(draft.searchGraphWeight),
    },
    {
      section: "search",
      key: "graph_depth",
      value: String(draft.searchGraphDepth),
    },
    {
      section: "search",
      key: "graph_max_neighbors",
      value: String(draft.searchGraphMaxNeighbors),
    },
  ].reduce(
    (content, patch) =>
      setTomlValue(content, patch.section, patch.key, patch.value),
    existing,
  );

  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp-${Date.now()}`;
  await writeFile(tmpPath, ensureFinalNewline(next), "utf8");
  await rename(tmpPath, configPath);
}

export function normalizeExcludeHeadings(value: string): string[] {
  return unique(
    value
      .split(/\r?\n|,/)
      .map((heading) => heading.trim())
      .filter(Boolean),
  );
}

function findTomlValue(
  content: string,
  section: string,
  key: string,
): string | null {
  const lines = splitTomlLines(content);
  let currentSection = "";

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const sectionName = parseSectionName(trimmed);
    if (sectionName !== null) {
      currentSection = sectionName;
      continue;
    }

    if (currentSection !== section || !isTomlKeyLine(trimmed, key)) {
      continue;
    }

    const endIndex = valueBlockEndIndex(lines, index);
    return lines.slice(index, endIndex + 1).join("\n").split(/=(.*)/s)[1]?.trim() ?? null;
  }

  return null;
}

function setTomlValue(
  content: string,
  section: string,
  key: string,
  value: string,
): string {
  const lines = splitTomlLines(content);
  const range = findSectionRange(lines, section);
  const nextLine = `${key} = ${value}`;

  if (!range) {
    const next = trimTrailingEmptyLines(lines);
    if (next.length > 0) {
      next.push("");
    }
    next.push(`[${section}]`, nextLine);
    return next.join("\n");
  }

  for (let index = range.start + 1; index < range.end; index += 1) {
    if (!isTomlKeyLine(lines[index].trim(), key)) {
      continue;
    }

    const endIndex = valueBlockEndIndex(lines, index);
    lines.splice(index, endIndex - index + 1, nextLine);
    return lines.join("\n");
  }

  let insertIndex = range.end;
  while (insertIndex > range.start + 1 && lines[insertIndex - 1].trim() === "") {
    insertIndex -= 1;
  }
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
}

function findSectionRange(
  lines: string[],
  section: string,
): { start: number; end: number } | null {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionName = parseSectionName(lines[index].trim());
    if (sectionName === null) {
      continue;
    }

    if (sectionName === section) {
      start = index;
      continue;
    }

    if (start >= 0) {
      return { start, end: index };
    }
  }

  return start >= 0 ? { start, end: lines.length } : null;
}

function valueBlockEndIndex(lines: string[], startIndex: number): number {
  let bracketDepth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    bracketDepth += bracketBalance(lines[index]);
    if (bracketDepth <= 0) {
      return index;
    }
  }
  return startIndex;
}

function bracketBalance(line: string): number {
  let balance = 0;
  let quote: string | null = null;
  let escaping = false;

  for (const char of line) {
    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\" && quote === "\"") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "[") {
      balance += 1;
    } else if (char === "]") {
      balance -= 1;
    } else if (char === "#") {
      break;
    }
  }

  return balance;
}

function parseSectionName(trimmedLine: string): string | null {
  const match = /^\[([A-Za-z0-9_.-]+)]\s*(?:#.*)?$/.exec(trimmedLine);
  return match?.[1] ?? null;
}

function isTomlKeyLine(trimmedLine: string, key: string): boolean {
  return new RegExp(`^${escapeRegExp(key)}\\s*=`).test(trimmedLine);
}

function parseStringArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  const result: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  for (const match of value.matchAll(regex)) {
    if (match[1] !== undefined) {
      result.push(JSON.parse(`"${match[1]}"`) as string);
    } else if (match[2] !== undefined) {
      result.push(match[2]);
    }
  }
  return result;
}

function parseBoolean(value: string | null): boolean | null {
  const normalized = stripInlineComment(value ?? "").trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return null;
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = /^\d+/.exec(stripInlineComment(value).trim());
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = /^\d+/.exec(stripInlineComment(value).trim());
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNonNegativeNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(stripInlineComment(value).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseSearchMode(value: string | null): SearchMode | null {
  const parsed = parseString(value);
  if (parsed === "hybrid" || parsed === "bm25" || parsed === "vector") {
    return parsed;
  }
  return null;
}

function parseString(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = stripInlineComment(value).trim();
  if (trimmed.startsWith("\"")) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripInlineComment(value: string): string {
  return value.split("#")[0] ?? "";
}

function formatStringArray(values: string[]): string {
  const normalized = unique(values.map((value) => value.trim()).filter(Boolean));
  if (normalized.length === 0) {
    return "[]";
  }
  return `[${normalized.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function splitTomlLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === "") {
    next.pop();
  }
  return next;
}

function ensureFinalNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
