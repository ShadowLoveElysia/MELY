import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = resolve(projectRoot, "src/version/version.json");
const cargoManifestPath = resolve(projectRoot, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(projectRoot, "src-tauri/Cargo.lock");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const readVersion = async () => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(versionPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 ${versionPath}`, { cause: error });
  }

  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || Object.keys(manifest).length !== 1
    || typeof manifest.version !== "string"
    || !semverPattern.test(manifest.version)
  ) {
    throw new Error("src/version/version.json 必须只包含符合 SemVer 的 version 字段");
  }
  return manifest.version;
};

const replaceCargoPackageVersion = (source, version, path) => {
  const headerMatch = source.match(/^\[package\][^\S\r\n]*(?:\r?\n)/m);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new Error(`无法在 ${path} 中找到 [package]`);
  }
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const nextSectionOffset = source.slice(sectionStart).search(/^\[/m);
  const sectionEnd = nextSectionOffset < 0 ? source.length : sectionStart + nextSectionOffset;
  const section = source.slice(sectionStart, sectionEnd);

  const versionField = /^version\s*=\s*"[^"]+"\s*$/m;
  if (!versionField.test(section)) {
    throw new Error(`无法在 ${path} 的 [package] 中找到 version`);
  }
  const synchronizedSection = section.replace(versionField, `version = "${version}"`);
  return `${source.slice(0, sectionStart)}${synchronizedSection}${source.slice(sectionEnd)}`;
};

const replaceCargoLockVersion = (source, version) => {
  const packageBlock = /(^\[\[package\]\][^\S\r\n]*\r?\nname\s*=\s*"mely"[^\S\r\n]*\r?\nversion\s*=\s*")[^"]+("[^\S\r\n]*(?:\r?\n|$))/m;
  if (!packageBlock.test(source)) {
    throw new Error("无法在 src-tauri/Cargo.lock 中找到 mely 包版本");
  }
  return source.replace(packageBlock, `$1${version}$2`);
};

const synchronize = async (checkOnly) => {
  const version = await readVersion();
  const targets = [
    {
      path: cargoManifestPath,
      update: (source) => replaceCargoPackageVersion(source, version, "src-tauri/Cargo.toml"),
    },
    {
      path: cargoLockPath,
      update: (source) => replaceCargoLockVersion(source, version),
    },
  ];
  const stalePaths = [];

  for (const target of targets) {
    const source = await readFile(target.path, "utf8");
    const synchronized = target.update(source);
    if (source === synchronized) continue;
    stalePaths.push(target.path);
    if (!checkOnly) await writeFile(target.path, synchronized, "utf8");
  }

  if (checkOnly && stalePaths.length > 0) {
    const relativePaths = stalePaths.map((path) => path.slice(projectRoot.length + 1));
    throw new Error(`版本镜像未同步：${relativePaths.join(", ")}。请运行 npm run version:sync`);
  }

  console.log(`[MELY] version ${version}${checkOnly ? " 已通过校验" : " 已同步"}`);
};

const command = process.argv[2] ?? "check";
if (command !== "check" && command !== "sync") {
  throw new Error("用法：node scripts/version.mjs [check|sync]");
}

synchronize(command === "check").catch((error) => {
  console.error(`[MELY] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
