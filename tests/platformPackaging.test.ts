import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readProjectFile = (path: string) => readFile(path, "utf8");

test("Windows launcher prefers packaged EXE and retains explicit Web fallback", async () => {
  const launcher = await readProjectFile("MELY.bat");
  assert.match(launcher, /call :find_packaged_executable[\s\S]*if defined MELY_EXE goto packaged_mode/);
  assert.match(launcher, /:desktop_unavailable[\s\S]*Falling back to the browser runtime/);
  assert.match(launcher, /:web_mode[\s\S]*scripts\\start-web\.mjs/);
  assert.match(launcher, /src-tauri\\target\\release\\MELY\.exe/);
  assert.doesNotMatch(launcher, /^\s*(?:call\s+)?"?%MELY_NPM%"?\s+(?:install|ci)\b/im);
});

test("Windows npm scripts invoke JavaScript entry points without relying on bin shims", async () => {
  const packageJson = JSON.parse(await readProjectFile("package.json"));
  const synchronizeVersion = "npm run version:sync && npm run version:check";
  assert.equal(packageJson.scripts["prestart:desktop"], synchronizeVersion);
  assert.equal(packageJson.scripts["predev:desktop"], synchronizeVersion);
  assert.equal(packageJson.scripts["prebuild:desktop"], synchronizeVersion);
  assert.equal(packageJson.scripts.pretauri, synchronizeVersion);
  assert.equal(packageJson.scripts["start:desktop"], "node node_modules/@tauri-apps/cli/tauri.js dev");
  assert.equal(packageJson.scripts["dev:desktop"], "node node_modules/@tauri-apps/cli/tauri.js dev");
  assert.equal(packageJson.scripts["build:desktop"], "node node_modules/@tauri-apps/cli/tauri.js build");
  assert.equal(packageJson.scripts.typecheck, "node node_modules/typescript/bin/tsc -b");
  assert.match(packageJson.scripts["build:web"], /^npm run typecheck && node node_modules\/vite\/bin\/vite\.js build /);
  assert.doesNotMatch(packageJson.scripts["build:web"], /version:(?:sync|check)/);
  assert.match(packageJson.scripts.test, /version:check/);
  assert.doesNotMatch(packageJson.scripts.test, /version:sync/);
  assert.match(packageJson.scripts["dev:web"], /^node node_modules\/vite\/bin\/vite\.js /);
  assert.match(packageJson.scripts["preview:web"], /^node node_modules\/vite\/bin\/vite\.js preview /);
});

test("Windows release builds reuse local dependencies without weakening CI installs", async () => {
  const builder = await readProjectFile("scripts/build-windows-release.ps1");
  const validation = await readProjectFile("scripts/windows-release-validation.ps1");
  assert.match(builder, /\[switch\]\$RefreshDependencies/);
  assert.match(builder, /\$RefreshDependencies -or \$Channel -ne "local" -or -not \$dependenciesReady/);
  assert.match(builder, /if \(\$Channel -eq "local"\) \{[\s\S]*--ignore-scripts/);
  assert.match(builder, /node_modules\\esbuild\\install\.js/);
  assert.match(builder, /node_modules\\tsx\\node_modules\\esbuild\\install\.js/);
  assert.match(builder, /Reusing installed dependencies for the local build/);
  assert.match(builder, /Invoke-Native \$node @\(\$versionScript, "sync"\)/);
  assert.match(builder, /Invoke-Native \$node @\(\$versionScript, "check"\)/);
  assert.match(validation, /node\.exe" "scripts\\version\.mjs" sync/);
  assert.match(validation, /node\.exe" "scripts\\version\.mjs" check/);
  assert.doesNotMatch(builder, /Version configuration mismatch/);
  assert.ok(
    builder.indexOf('Invoke-Native $node @($versionScript, "sync")')
      < builder.indexOf("$versionManifest = Get-Content"),
    "The release builder must synchronize derived versions before reading the artifact version.",
  );
});

test("Tauri desktop shell uses v2 configuration and bundled Web assets", async () => {
  const config = JSON.parse(await readProjectFile("src-tauri/tauri.conf.json"));
  const cargo = await readProjectFile("src-tauri/Cargo.toml");
  const capabilities = JSON.parse(await readProjectFile("src-tauri/capabilities/main.json"));
  assert.equal(config.$schema, "https://schema.tauri.app/config/2");
  assert.equal(config.productName, "MELY");
  assert.equal(config.version, "../src/version/version.json");
  assert.equal(config.build.frontendDist, "../dist");
  assert.equal(config.build.devUrl, "http://127.0.0.1:4173");
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.icon, [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ]);
  assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"2"/);
  assert.match(cargo, /tauri-build\s*=\s*\{\s*version\s*=\s*"2"/);
  assert.deepEqual(capabilities.windows, ["main"]);
  assert.ok(capabilities.permissions.includes("fs:allow-write"));
});

test("application version has one editable source and synchronized Cargo mirrors", async () => {
  const versionManifest = JSON.parse(await readProjectFile("src/version/version.json"));
  const packageJson = JSON.parse(await readProjectFile("package.json"));
  const packageLock = JSON.parse(await readProjectFile("package-lock.json"));
  const tauriConfig = JSON.parse(await readProjectFile("src-tauri/tauri.conf.json"));
  const cargo = await readProjectFile("src-tauri/Cargo.toml");
  const cargoLock = await readProjectFile("src-tauri/Cargo.lock");
  const cargoVersion = cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLockVersion = cargoLock.match(/\[\[package\]\]\s*\nname\s*=\s*"mely"\s*\nversion\s*=\s*"([^"]+)"/m)?.[1];

  assert.match(versionManifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/);
  assert.equal("version" in packageJson, false);
  assert.equal("version" in packageLock, false);
  assert.equal("version" in packageLock.packages[""], false);
  assert.equal(tauriConfig.version, "../src/version/version.json");
  assert.equal(cargoVersion, versionManifest.version);
  assert.equal(cargoLockVersion, versionManifest.version);
});
