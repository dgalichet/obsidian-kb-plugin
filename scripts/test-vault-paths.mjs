import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/vault-path.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const source = result.outputFiles[0].text;
const moduleUrl =
  "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { normalizeVaultPath } = await import(moduleUrl);

const normalizeWindows = (value) => normalizeVaultPath(value, true);
const normalizePosix = (value) => normalizeVaultPath(value, false);

assert.equal(normalizeWindows("\\\\?\\C:\\Vault"), normalizeWindows("C:\\Vault"));
assert.equal(
  normalizeWindows("\\\\?\\UNC\\server\\share\\Vault"),
  normalizeWindows("\\\\server\\share\\Vault"),
);
assert.equal(
  normalizeWindows("\\\\?\\unc\\server\\share\\Vault"),
  normalizeWindows("\\\\server\\share\\Vault"),
);
assert.equal(normalizeWindows("C:/Vault/"), normalizeWindows("c:\\vault"));
assert.equal(normalizeWindows("C:\\"), "c:\\");
assert.equal(normalizePosix("/Vault/"), "/Vault");
assert.equal(normalizePosix("/"), "/");
assert.notEqual(normalizePosix("/Vault"), normalizePosix("/vault"));

console.log("Vault path normalization tests passed.");
