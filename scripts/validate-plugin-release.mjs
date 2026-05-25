import { existsSync, readFileSync, statSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const releaseMode = args.has("--release");
const assetsMode = args.has("--assets");
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path} is not valid JSON: ${error.message}`);
    return {};
  }
}

function fail(message) {
  errors.push(message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");

const semverPattern = /^\d+\.\d+\.\d+$/;

if (!semverPattern.test(packageJson.version ?? "")) {
  fail(`package.json version must use x.y.z SemVer, got ${packageJson.version}`);
}

if (manifest.version !== packageJson.version) {
  fail(
    `manifest.json version (${manifest.version}) must match package.json version (${packageJson.version})`,
  );
}

const lockRoot = packageLock.packages?.[""];
if (!lockRoot) {
  fail("package-lock.json must contain the root package entry");
} else {
  if (lockRoot.name !== packageJson.name) {
    fail(`package-lock.json package name (${lockRoot.name}) must match package.json name (${packageJson.name})`);
  }

  if (lockRoot.version !== packageJson.version) {
    fail(
      `package-lock.json root version (${lockRoot.version}) must match package.json version (${packageJson.version})`,
    );
  }
}

for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
  if (!isNonEmptyString(manifest[field])) {
    fail(`manifest.json must contain a non-empty ${field}`);
  }
}

if (manifest.isDesktopOnly !== true) {
  fail("manifest.json must set isDesktopOnly to true because OKB launches obsidian-kb as a local process");
}

if (versions[manifest.version] !== manifest.minAppVersion) {
  fail(
    `versions.json must map ${manifest.version} to manifest minAppVersion ${manifest.minAppVersion}`,
  );
}

if (releaseMode) {
  const tag = process.env.GITHUB_REF_NAME ?? process.env.RELEASE_TAG ?? "";

  if (!semverPattern.test(tag)) {
    fail(`release tag must use X.Y.Z format without a v prefix, got ${tag || "<empty>"}`);
  } else if (tag !== manifest.version) {
    fail(`release tag ${tag} must match manifest/package version ${manifest.version}`);
  }
}

if (assetsMode) {
  for (const path of ["main.js", "manifest.json", "styles.css"]) {
    if (!existsSync(path)) {
      fail(`${path} must exist before publishing a release`);
      continue;
    }

    if (statSync(path).size === 0) {
      fail(`${path} must not be empty`);
    }
  }
}

if (errors.length > 0) {
  console.error("Plugin release validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Plugin release metadata is valid.");
