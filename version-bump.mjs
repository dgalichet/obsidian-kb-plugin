import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
const manifestPath = "manifest.json";
const versionsPath = "versions.json";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = targetVersion;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
