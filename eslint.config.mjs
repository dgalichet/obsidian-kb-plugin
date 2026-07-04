import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

const tsconfigRootDir = import.meta.dirname;

const typedObsidianRules = {
  "obsidianmd/no-plugin-as-component": "error",
  "obsidianmd/no-view-references-in-plugin": "error",
  "obsidianmd/no-unsupported-api": "error",
  "obsidianmd/prefer-file-manager-trash-file": "warn",
  "obsidianmd/prefer-instanceof": "error",
};

const sentenceCaseOptions = {
  brands: ["obsidian-kb", "Vault Knowledge Base"],
  acronyms: ["BM25", "KB", "MB", "MCP", "PDF"],
  ignoreRegex: ["\\n"],
  enforceCamelCaseLower: true,
};

export default defineConfig([
  {
    ignores: ["main.js"],
  },
  ...obsidianmd.configs.recommended,
  {
    rules: Object.fromEntries(
      Object.keys(typedObsidianRules).map((rule) => [rule, "off"]),
    ),
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir,
      },
    },
    rules: {
      ...typedObsidianRules,
      "obsidianmd/ui/sentence-case": ["error", sentenceCaseOptions],
    },
  },
]);
