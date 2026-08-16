import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const crlf = "\r\n";

const cargoManifest = (version: string) => [
  "[package]",
  'name = "mely"',
  `version = "${version}"`,
  'description = "MELY"',
  "",
  "[dependencies]",
  'serde = "1"',
  "",
].join(crlf);

const cargoLock = (version: string) => [
  "version = 3",
  "",
  "[[package]]",
  'name = "mely"',
  `version = "${version}"`,
  "",
].join(crlf);

const createVersionFixture = async (sourceVersion: string, mirrorVersion: string) => {
  const root = await mkdtemp(join(tmpdir(), "mely-version-"));
  await Promise.all([
    mkdir(join(root, "scripts"), { recursive: true }),
    mkdir(join(root, "src", "version"), { recursive: true }),
    mkdir(join(root, "src-tauri"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile("scripts/version.mjs", join(root, "scripts", "version.mjs")),
    writeFile(
      join(root, "src", "version", "version.json"),
      `{${crlf}  "version": "${sourceVersion}"${crlf}}${crlf}`,
      "utf8",
    ),
    writeFile(
      join(root, "src-tauri", "tauri.conf.json"),
      `{${crlf}  "version": "../src/version/version.json"${crlf}}${crlf}`,
      "utf8",
    ),
    writeFile(join(root, "src-tauri", "Cargo.toml"), cargoManifest(mirrorVersion), "utf8"),
    writeFile(join(root, "src-tauri", "Cargo.lock"), cargoLock(mirrorVersion), "utf8"),
  ]);
  return root;
};

const runVersionCommand = (root: string, command: "check" | "sync") => spawnSync(
  process.execPath,
  [join(root, "scripts", "version.mjs"), command],
  { cwd: root, encoding: "utf8" },
);

test("version check accepts synchronized Cargo mirrors with CRLF", async (context) => {
  const root = await createVersionFixture("0.2.0", "0.2.0");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cargoManifestPath = join(root, "src-tauri", "Cargo.toml");
  const cargoLockPath = join(root, "src-tauri", "Cargo.lock");
  const manifestBefore = await readFile(cargoManifestPath, "utf8");
  const lockBefore = await readFile(cargoLockPath, "utf8");

  const result = runVersionCommand(root, "check");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(cargoManifestPath, "utf8"), manifestBefore);
  assert.equal(await readFile(cargoLockPath, "utf8"), lockBefore);
});

test("version sync preserves CRLF while updating Cargo mirrors", async (context) => {
  const root = await createVersionFixture("1.0.0", "0.2.0");
  context.after(() => rm(root, { recursive: true, force: true }));

  const syncResult = runVersionCommand(root, "sync");

  assert.equal(syncResult.status, 0, syncResult.stderr);
  assert.equal(await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8"), cargoManifest("1.0.0"));
  assert.equal(await readFile(join(root, "src-tauri", "Cargo.lock"), "utf8"), cargoLock("1.0.0"));

  const checkResult = runVersionCommand(root, "check");
  assert.equal(checkResult.status, 0, checkResult.stderr);
});

test("version check reports every stale Cargo mirror without modifying it", async (context) => {
  const root = await createVersionFixture("1.0.0", "0.2.0");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cargoManifestPath = join(root, "src-tauri", "Cargo.toml");
  const cargoLockPath = join(root, "src-tauri", "Cargo.lock");
  const manifestBefore = await readFile(cargoManifestPath, "utf8");
  const lockBefore = await readFile(cargoLockPath, "utf8");

  const result = runVersionCommand(root, "check");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /src-tauri[\\/]Cargo\.toml/);
  assert.match(result.stderr, /src-tauri[\\/]Cargo\.lock/);
  assert.equal(await readFile(cargoManifestPath, "utf8"), manifestBefore);
  assert.equal(await readFile(cargoLockPath, "utf8"), lockBefore);
});

test("version commands reject a Tauri config that no longer references the source manifest", async (context) => {
  const root = await createVersionFixture("1.0.0", "1.0.0");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "src-tauri", "tauri.conf.json"),
    `{${crlf}  "version": "0.2.0"${crlf}}${crlf}`,
    "utf8",
  );

  const result = runVersionCommand(root, "sync");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tauri\.conf\.json.*version.*\.\.\/src\/version\/version\.json/);
});
