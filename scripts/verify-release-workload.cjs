const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { readFile, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { chromium } = require(process.env.MELY_PLAYWRIGHT_MODULE || "playwright");
const { gunzipSync, strFromU8, unzipSync } = require("fflate");
const nbt = require("prismarine-nbt");

const execFileAsync = promisify(execFile);

const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const mode = process.env.MELY_WORKLOAD_MODE || "hologram";
const exportFormat = process.env.MELY_EXPORT_FORMAT || "litematic";
const targetHeight = Number(process.env.MELY_TARGET_HEIGHT || 320);
const faceDetail = process.env.MELY_FACE_DETAIL || "off";
const navigationWaitUntil = process.env.MELY_NAVIGATION_WAIT_UNTIL || "networkidle";
const outputPrefix = process.env.MELY_OUTPUT_PREFIX || `release-${mode}-${targetHeight}-${exportFormat}`;
const reportPath = process.env.MELY_REPORT_PATH || `${outputPrefix}.json`;
const targetDimensionMinY = Number(process.env.MELY_TARGET_DIMENSION_MIN_Y);
const targetDimensionHeight = Number(process.env.MELY_TARGET_DIMENSION_HEIGHT);
const placementBottomY = Number(process.env.MELY_PLACEMENT_BOTTOM_Y);

const validModes = new Set(["hologram", "solid"]);
const exportExtensions = {
  litematic: "litematic",
  bundle: "zip",
  schematic: "schem",
  mcstructure: "mcstructure",
  mcfunction: "zip",
};
const exportLabels = {
  litematic: "Litematica projection",
  bundle: "32³ project bundle ZIP",
  schematic: "Sponge Schematic",
  mcstructure: "Bedrock structure",
  mcfunction: "Bedrock behavior pack",
};

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");
if (!validModes.has(mode)) throw new Error(`Unsupported MELY_WORKLOAD_MODE: ${mode}`);
if (!(exportFormat in exportExtensions)) throw new Error(`Unsupported MELY_EXPORT_FORMAT: ${exportFormat}`);
if (!Number.isInteger(targetHeight) || targetHeight < 32 || targetHeight > 4064) {
  throw new Error("MELY_TARGET_HEIGHT must be an integer from 32 to 4064");
}
if (targetHeight > 384) {
  const declaration = {
    MELY_TARGET_DIMENSION_MIN_Y: targetDimensionMinY,
    MELY_TARGET_DIMENSION_HEIGHT: targetDimensionHeight,
    MELY_PLACEMENT_BOTTOM_Y: placementBottomY,
  };
  if (!Object.values(declaration).every(Number.isSafeInteger) || targetDimensionHeight <= 0) {
    throw new Error(
      "Extended-height workloads require integer MELY_TARGET_DIMENSION_MIN_Y, "
      + "MELY_TARGET_DIMENSION_HEIGHT > 0, and MELY_PLACEMENT_BOTTOM_Y",
    );
  }
  const targetDimensionMaxY = targetDimensionMinY + targetDimensionHeight - 1;
  const placementMaxY = placementBottomY + targetHeight - 1;
  if (
    !Number.isSafeInteger(targetDimensionMaxY)
    || !Number.isSafeInteger(placementMaxY)
    || placementBottomY < targetDimensionMinY
    || placementMaxY > targetDimensionMaxY
  ) {
    throw new Error(
      `Declared placement Y=${placementBottomY}..${placementMaxY} is outside `
      + `the target dimension Y=${targetDimensionMinY}..${targetDimensionMaxY}`,
    );
  }
}

const processWorkingSet = async (processIds) => {
  if (!processIds.length) return 0;
  const script = [
    `$ids = @(${processIds.join(",")})`,
    "$sum = (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum",
    "if ($null -eq $sum) { 0 } else { [int64]$sum }",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
  });
  return Number(stdout.trim()) || 0;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const canonicalBlockState = (state) => JSON.stringify([
  state.Name,
  Object.entries(state.Properties ?? {}).sort(([left], [right]) => left.localeCompare(right)),
]);

const compareDecodedBlocks = (left, right) =>
  left.position[1] - right.position[1]
  || left.position[2] - right.position[2]
  || left.position[0] - right.position[0];

const unsignedLong = (pair) =>
  (BigInt(pair[0] >>> 0) << 32n) | BigInt(pair[1] >>> 0);

const packedIndex = (packed, index, bitsPerBlock) => {
  const bitOffset = index * bitsPerBlock;
  const longIndex = Math.floor(bitOffset / 64);
  const innerOffset = bitOffset & 63;
  const first = packed[longIndex];
  if (!first) throw new RangeError(`Missing packed long ${longIndex}`);
  const available = 64 - innerOffset;
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  let value = unsignedLong(first) >> BigInt(innerOffset);
  if (available < bitsPerBlock) {
    const second = packed[longIndex + 1];
    if (!second) throw new RangeError(`Missing packed long ${longIndex + 1}`);
    value |= unsignedLong(second) << BigInt(available);
  }
  return Number(value & mask);
};

const decodeLitematicBlocks = (root, documentOrigin) => {
  const blocks = [];
  for (const region of Object.values(root.Regions ?? {})) {
    const size = [
      Math.abs(Number(region.Size?.x ?? 0)),
      Math.abs(Number(region.Size?.y ?? 0)),
      Math.abs(Number(region.Size?.z ?? 0)),
    ];
    const volume = size[0] * size[1] * size[2];
    const palette = (region.BlockStatePalette ?? []).map(canonicalBlockState);
    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))));
    const packed = region.BlockStates ?? [];
    const origin = documentOrigin.map((value, axis) =>
      value + Number(region.Position?.["xyz"[axis]] ?? 0));
    const slotsPerLong = 64 % bitsPerBlock === 0 ? 64 / bitsPerBlock : 0;
    let linearIndex = 0;
    const append = (paletteIndex, index) => {
      if (paletteIndex === 0) return;
      const state = palette[paletteIndex];
      if (state === undefined) throw new RangeError(`Unknown palette index ${paletteIndex}`);
      const x = index % size[0];
      const yz = Math.floor(index / size[0]);
      const z = yz % size[2];
      const y = Math.floor(yz / size[2]);
      blocks.push({
        position: [origin[0] + x, origin[1] + y, origin[2] + z],
        state,
      });
    };

    if (slotsPerLong > 0) {
      const mask = (1n << BigInt(bitsPerBlock)) - 1n;
      for (const pair of packed) {
        const remaining = Math.min(slotsPerLong, volume - linearIndex);
        if (remaining <= 0) break;
        const packedValue = unsignedLong(pair);
        if (packedValue === 0n) {
          linearIndex += remaining;
          continue;
        }
        for (let slot = 0; slot < remaining; slot += 1) {
          append(
            Number((packedValue >> BigInt(slot * bitsPerBlock)) & mask),
            linearIndex,
          );
          linearIndex += 1;
        }
      }
    } else {
      for (; linearIndex < volume; linearIndex += 1) {
        append(packedIndex(packed, linearIndex, bitsPerBlock), linearIndex);
      }
    }
    if (linearIndex < volume) {
      throw new RangeError(`Packed region ended at ${linearIndex}/${volume} cells`);
    }
  }
  return blocks;
};

const contentHashForDecodedPart = (manifest, part, blocks) => {
  const origin = part.occupiedBounds.min;
  const sorted = [...blocks].sort(compareDecodedBlocks);
  const hash = createHash("sha256");
  hash.update(JSON.stringify([
    "MELYProjectionPart",
    1,
    manifest.projection.edition,
    manifest.projection.minecraftVersion,
    sorted.length,
  ]));
  for (const block of sorted) {
    hash.update("\n");
    hash.update(JSON.stringify([
      block.position[0] - origin[0],
      block.position[1] - origin[1],
      block.position[2] - origin[2],
      block.state,
    ]));
  }
  return `sha256:${hash.digest("hex")}`;
};

const inspectExport = async (path, format) => {
  const bytes = await readFile(path);
  const common = { byteLength: bytes.byteLength, sha256: sha256(bytes) };
  if (format === "litematic") {
    const parsed = await nbt.parse(bytes, "big");
    const root = nbt.simplify(parsed.parsed);
    const regions = Object.values(root.Regions ?? {});
    const regionVolumes = regions.map((region) => (
      Math.abs(Number(region.Size?.x ?? 0))
      * Math.abs(Number(region.Size?.y ?? 0))
      * Math.abs(Number(region.Size?.z ?? 0))
    ));
    const packedLongCount = regions.reduce(
      (total, region) => total + Number(region.BlockStates?.length ?? 0),
      0,
    );
    return {
      ...common,
      version: root.Version,
      dataVersion: root.MinecraftDataVersion,
      blocks: root.Metadata.TotalBlocks,
      regions: root.Metadata.RegionCount,
      volume: root.Metadata.TotalVolume,
      dimensions: root.Metadata.EnclosingSize,
      largestRegionVolume: Math.max(0, ...regionVolumes),
      packedLongCount,
      packedBytes: packedLongCount * 8,
    };
  }
  if (format === "schematic") {
    const root = nbt.simplify(nbt.parseUncompressed(Buffer.from(gunzipSync(bytes)), "big"));
    return {
      ...common,
      version: root.Version,
      dataVersion: root.DataVersion,
      dimensions: [root.Width, root.Height, root.Length],
    };
  }
  if (format === "mcstructure") {
    const root = nbt.simplify(nbt.parseUncompressed(Buffer.from(bytes), "little"));
    return {
      ...common,
      formatVersion: root.format_version,
      dimensions: root.size,
      paletteSize: root.structure?.palette?.default?.block_palette?.length,
    };
  }

  const files = unzipSync(bytes);
  const names = Object.keys(files).sort();
  if (format === "mcfunction") {
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    return {
      ...common,
      fileCount: names.length,
      functionCount: names.filter((name) => name.endsWith(".mcfunction")).length,
      minEngineVersion: manifest.header.min_engine_version,
      samples: names.slice(0, 12),
    };
  }

  const manifest = JSON.parse(strFromU8(files["bundle.json"]));
  const overallPath = manifest.litematic.overall;
  const partHashes = manifest.parts.map((part) => part.contentHash);
  const buildOrder = manifest.parts.map((part) => part.buildOrder);
  const overallRoot = nbt.simplify(nbt.parseUncompressed(
    Buffer.from(gunzipSync(files[overallPath])),
    "big",
  ));
  const overallBlocks = decodeLitematicBlocks(overallRoot, manifest.projection.bounds.min);
  const remainingOverall = new Map();
  let overallDuplicateCount = 0;
  const overallDuplicates = [];
  for (const block of overallBlocks) {
    const key = block.position.join(",");
    if (remainingOverall.has(key)) {
      overallDuplicateCount += 1;
      if (overallDuplicates.length < 8) overallDuplicates.push(key);
      continue;
    }
    remainingOverall.set(key, block.state);
  }
  let duplicatePartBlocks = 0;
  let unexpectedPartBlocks = 0;
  let stateMismatches = 0;
  const unionSamples = [];
  const partReadback = manifest.parts.map((part) => {
    const file = files[part.files.litematic];
    if (!file) return { id: part.id, path: part.files.litematic, missing: true };
    const root = nbt.simplify(nbt.parseUncompressed(
      Buffer.from(gunzipSync(file)),
      "big",
    ));
    const blocks = decodeLitematicBlocks(root, part.occupiedBounds.min);
    const localCoordinates = new Set();
    for (const block of blocks) {
      const key = block.position.join(",");
      if (localCoordinates.has(key)) {
        duplicatePartBlocks += 1;
        if (unionSamples.length < 8) unionSamples.push({ kind: "duplicate", id: part.id, key });
        continue;
      }
      localCoordinates.add(key);
      const expectedState = remainingOverall.get(key);
      if (expectedState === undefined) {
        unexpectedPartBlocks += 1;
        if (unionSamples.length < 8) unionSamples.push({ kind: "unexpected", id: part.id, key });
        continue;
      }
      if (expectedState !== block.state) {
        stateMismatches += 1;
        if (unionSamples.length < 8) unionSamples.push({
          kind: "state",
          id: part.id,
          key,
          expectedState,
          actualState: block.state,
        });
      }
      remainingOverall.delete(key);
    }
    const calculatedContentHash = contentHashForDecodedPart(manifest, part, blocks);
    return {
      id: part.id,
      path: part.files.litematic,
      version: root.Version,
      dataVersion: root.MinecraftDataVersion,
      blocks: root.Metadata.TotalBlocks,
      decodedBlocks: blocks.length,
      regions: root.Metadata.RegionCount,
      dimensions: root.Metadata.EnclosingSize,
      manifestBlocks: part.blockCount,
      calculatedContentHash,
      manifestContentHash: part.contentHash,
      contentHashMatches: calculatedContentHash === part.contentHash,
    };
  });
  const invalidParts = partReadback.filter((part) => part.missing
    || part.version !== 6
    || part.dataVersion !== 3465
    || part.blocks !== part.manifestBlocks
    || part.decodedBlocks !== part.manifestBlocks
    || !part.contentHashMatches
    || part.regions < 1
    || Object.values(part.dimensions ?? {}).some((dimension) => dimension < 1 || dimension > 32));
  return {
    ...common,
    fileCount: names.length,
    partCount: manifest.parts.length,
    guideLocale: manifest.guides.locale,
    blockCount: manifest.projection?.blockCount ?? manifest.blockCount,
    bounds: manifest.projection?.bounds ?? manifest.bounds,
    partIntegrity: {
      validHashes: partHashes.every((hash) => /^sha256:[0-9a-f]{64}$/.test(hash)),
      uniqueHashes: new Set(partHashes).size,
      sequentialBuildOrder: buildOrder.every((order, index) => order === index + 1),
      first: manifest.parts[0]
        ? {
            id: manifest.parts[0].id,
            buildOrder: manifest.parts[0].buildOrder,
            contentHash: manifest.parts[0].contentHash,
          }
        : null,
      last: manifest.parts.at(-1)
        ? {
            id: manifest.parts.at(-1).id,
            buildOrder: manifest.parts.at(-1).buildOrder,
            contentHash: manifest.parts.at(-1).contentHash,
          }
        : null,
      readbackCount: partReadback.length,
      readbackBlockCount: partReadback.reduce((total, part) => total + (part.blocks ?? 0), 0),
      decodedBlockCount: partReadback.reduce((total, part) => total + (part.decodedBlocks ?? 0), 0),
      overallDecodedBlockCount: overallBlocks.length,
      overallDuplicateCount,
      duplicatePartBlocks,
      unexpectedPartBlocks,
      stateMismatches,
      missingOverallBlocks: remainingOverall.size,
      coordinateUnionMatches: overallDuplicateCount === 0
        && duplicatePartBlocks === 0
        && unexpectedPartBlocks === 0
        && remainingOverall.size === 0,
      stateUnionMatches: stateMismatches === 0,
      contentHashMatchCount: partReadback.filter((part) => part.contentHashMatches).length,
      unionSamples,
      overallDuplicateSamples: overallDuplicates,
      invalidPartCount: invalidParts.length,
      invalidPartSamples: invalidParts.slice(0, 8),
    },
    overall: {
      version: overallRoot.Version,
      dataVersion: overallRoot.MinecraftDataVersion,
      blocks: overallRoot.Metadata.TotalBlocks,
      regions: overallRoot.Metadata.RegionCount,
      dimensions: overallRoot.Metadata.EnclosingSize,
    },
    contains: {
      readme: Boolean(files["README.txt"]),
      materials: Boolean(files["planning/materials.json"]),
      chests: Boolean(files["planning/chests.json"]),
      behaviorPack: Boolean(files["behavior_pack/manifest.json"]),
      schematic: names.some((name) => name.endsWith(".schem")),
      mcstructure: names.some((name) => name.endsWith(".mcstructure")),
    },
  };
};

const run = async () => {
  const report = {
    appUrl,
    modelZip,
    mode,
    exportFormat,
    targetHeight,
    targetDimension: targetHeight > 384 ? {
      minY: targetDimensionMinY,
      height: targetDimensionHeight,
      placementBottomY,
    } : undefined,
    navigationWaitUntil,
    faceDetail: mode === "solid" ? faceDetail : undefined,
    consoleErrors: [],
    pageErrors: [],
    peakWorkingSetBytes: 0,
    phasePeaks: {},
    timingsMs: {},
    safety: {},
    exportProgress: [],
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));

  let phase = "startup";
  let sampling = true;
  let samplingError;
  const memorySampler = (async () => {
    while (sampling) {
      try {
        const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
        const processIds = processInfo
          .map((process) => Number(process.id))
          .filter((processId) => Number.isInteger(processId) && processId > 0);
        const workingSet = await processWorkingSet(processIds);
        report.peakWorkingSetBytes = Math.max(report.peakWorkingSetBytes, workingSet);
        report.phasePeaks[phase] = Math.max(report.phasePeaks[phase] || 0, workingSet);
      } catch (error) {
        samplingError = error;
        return;
      }
      await new Promise((resolve_) => setTimeout(resolve_, 350));
    }
  })();

  try {
    let startedAt = Date.now();
    await page.goto(appUrl, { waitUntil: navigationWaitUntil, timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    report.timingsMs.startup = Date.now() - startedAt;

    phase = "modelLoad";
    startedAt = Date.now();
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 }).catch(() => undefined);
    await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });
    report.timingsMs.modelLoad = Date.now() - startedAt;
    report.modelName = await page.locator(".model-summary__header strong").innerText();

    if (targetHeight > 384) {
      const heightUnlock = page.locator('.height-unlock[aria-pressed]');
      if (await heightUnlock.isDisabled()) {
        report.safety.unlockDisabled = true;
        throw new Error("The extended-height unlock is disabled; best-effort height workflows must remain reachable");
      }
      await heightUnlock.click();
      const unlockDialog = page.getByRole("dialog").filter({ hasText: "Extended-height warning" });
      await unlockDialog.waitFor({ state: "visible" });
      report.safety.unlockDialog = true;
      await unlockDialog.getByRole("button", { name: "Unlock height", exact: true }).click();
      if (targetHeight > 2032) {
        const extremeUnlock = page.getByRole("button", {
          name: "Unlock experimental limit (4,064 layers)",
          exact: true,
        });
        if (!await extremeUnlock.isEnabled()) {
          throw new Error("The 4,064-layer unlock is disabled");
        }
        await extremeUnlock.click();
        const extremeDialog = page.getByRole("dialog", {
          name: "Experimental 4,064 layers: unlock",
        });
        await extremeDialog.waitFor({ state: "visible" });
        report.safety.extremeUnlockDialog = true;
        await extremeDialog.getByRole("button", {
          name: "Continue to environment checks",
          exact: true,
        }).click();
        const environmentDialog = page.getByRole("dialog", {
          name: "Experimental 4,064 layers: environment checks",
        });
        await environmentDialog.waitFor({ state: "visible" });
        const notices = environmentDialog.locator('input[type="checkbox"]');
        if (await notices.count() !== 3) {
          throw new Error(`Expected three 4,064-layer environment notices, found ${await notices.count()}`);
        }
        for (let index = 0; index < 3; index += 1) await notices.nth(index).check();
        await environmentDialog.getByRole("button", {
          name: "Confirm this environment",
          exact: true,
        }).click();
        report.safety.extremeEnvironmentDialog = true;
      }
      const declaration = page.locator(".dimension-declaration");
      await declaration.locator('input[type="number"]').nth(0).fill(String(targetDimensionMinY));
      await declaration.locator('input[type="number"]').nth(1).fill(String(targetDimensionHeight));
      await declaration.locator('input[type="number"]').nth(2).fill(String(placementBottomY));
    }
    const heightInput = page.locator(".slider-number input").first();
    await heightInput.fill(String(targetHeight));
    await heightInput.press("Enter");
    report.actualHeightInput = Number(await heightInput.inputValue());
    report.safety.persistentWarning = targetHeight > 384
      ? await page.locator(".height-warning").isVisible()
      : await page.locator(".height-warning").count() === 0;

    if (mode === "solid") {
      await page.getByRole("button", { name: /Solid sculpture/, exact: false }).click();
      const faceDetailSelect = page.locator(".field-row").filter({ hasText: "Facial detail" }).locator("select");
      await faceDetailSelect.selectOption(faceDetail);
    }

    phase = "generation";
    startedAt = Date.now();
    const generateLabel = mode === "solid" ? "Generate solid projection" : "Generate hologram";
    const generateButton = page.getByRole("button", { name: generateLabel, exact: true });
    if (!await generateButton.isEnabled()) throw new Error(`${generateLabel} is disabled`);
    await generateButton.click();
    await page.locator(".progress-block").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".progress-block").waitFor({ state: "hidden", timeout: 600_000 });
    await page.locator(".export-button").waitFor({ state: "visible" });
    report.timingsMs.generation = Date.now() - startedAt;
    report.bodySummary = (await page.locator("body").innerText()).slice(-900);

    phase = "export";
    startedAt = Date.now();
    await page.locator(".export-button").click();
    const exportDialog = page.getByRole("dialog").filter({ hasText: "Export center" });
    await exportDialog.waitFor({ state: "visible" });
    const formatButton = exportDialog.locator("button.export-format", {
      has: page.locator("strong", {
        hasText: new RegExp(`^${exportLabels[exportFormat].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      }),
    });
    if (!await formatButton.isEnabled()) {
      throw new Error(`${exportFormat} is unavailable: ${await formatButton.innerText()}`);
    }

    await page.evaluate(() => {
      window.__melyExportProgress = [];
      window.addEventListener("mely:export-progress", (event) => {
        window.__melyExportProgress.push(event.detail);
      });
    });

    let startExport;
    const javaHeightGate = targetHeight > 384
      && exportFormat !== "mcstructure"
      && exportFormat !== "mcfunction";
    if (javaHeightGate) {
      await formatButton.click();
      const safetyDialog = page.getByRole("dialog").filter({
        hasText: "Safety confirmation: this is not a vanilla projection",
      });
      await safetyDialog.waitFor({ state: "visible" });
      const confirm = safetyDialog.getByRole("button", { name: "Confirm export", exact: true });
      report.safety.confirmDisabledBeforeAcknowledge = await confirm.isDisabled();
      await safetyDialog.locator('input[type="checkbox"]').check();
      if (targetHeight > 2032) {
        await safetyDialog.locator('.extreme-export-phrase input[type="text"]')
          .fill(`导出 ${targetHeight}`);
        report.safety.extremePhraseEntered = true;
      }
      report.safety.confirmEnabledAfterAcknowledge = await confirm.isEnabled();
      startExport = () => confirm.click();
    } else {
      startExport = () => formatButton.click();
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 600_000 });
    void downloadPromise.catch(() => undefined);
    let observingExport = true;
    const progressObserver = (async () => {
      while (observingExport) {
        const failureToast = page.locator(".toast").filter({ hasText: "Export failed:" });
        if (await failureToast.isVisible().catch(() => false)) {
          return {
            kind: "failure",
            message: await failureToast.innerText(),
          };
        }
        await new Promise((resolve_) => setTimeout(resolve_, 250));
      }
      return { kind: "stopped" };
    })();

    await startExport();
    const outcome = await Promise.race([
      downloadPromise.then((download) => ({ kind: "download", download })),
      progressObserver,
    ]);
    observingExport = false;
    report.exportProgress = await page.evaluate(() => window.__melyExportProgress || []);
    if (outcome.kind === "failure") {
      throw new Error(`Application export failure: ${outcome.message}`);
    }
    if (outcome.kind !== "download") {
      throw new Error("Export observation stopped before a download or failure was reported");
    }
    const download = outcome.download;
    const outputPath = resolve(`${outputPrefix}.${exportExtensions[exportFormat]}`);
    await download.saveAs(outputPath);
    report.timingsMs.export = Date.now() - startedAt;
    report.outputPath = outputPath;
    report.export = await inspectExport(outputPath, exportFormat);
    await page.screenshot({ path: `${outputPrefix}.png`, fullPage: true });
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    sampling = false;
    await memorySampler;
    if (samplingError && !report.error) {
      report.error = samplingError instanceof Error
        ? `${samplingError.name}: ${samplingError.message}`
        : String(samplingError);
    }
    report.underTwoGiB = report.peakWorkingSetBytes < 2 * 1024 ** 3;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
  }

  if (samplingError) throw samplingError;
  if (report.consoleErrors.length || report.pageErrors.length) {
    throw new Error("The workload produced browser console or page errors");
  }
  if (!report.underTwoGiB) {
    throw new Error(`Process tree exceeded 2 GiB: ${report.peakWorkingSetBytes} bytes`);
  }
  if (
    exportFormat === "bundle"
    && (report.export.contains.behaviorPack
      || report.export.contains.schematic
      || report.export.contains.mcstructure)
  ) {
    throw new Error(`Default project bundle contains optional formats: ${JSON.stringify(report.export.contains)}`);
  }
  if (
    exportFormat === "bundle"
    && (!report.export.partIntegrity.validHashes
      || !report.export.partIntegrity.sequentialBuildOrder
      || report.export.partIntegrity.readbackCount !== report.export.partCount
      || report.export.partIntegrity.readbackBlockCount !== report.export.blockCount
      || report.export.partIntegrity.decodedBlockCount !== report.export.blockCount
      || report.export.partIntegrity.overallDecodedBlockCount !== report.export.blockCount
      || !report.export.partIntegrity.coordinateUnionMatches
      || !report.export.partIntegrity.stateUnionMatches
      || report.export.partIntegrity.contentHashMatchCount !== report.export.partCount
      || report.export.partIntegrity.invalidPartCount !== 0)
  ) {
    throw new Error(`Project bundle part integrity metadata failed: ${JSON.stringify(report.export.partIntegrity)}`);
  }
  if (exportFormat === "bundle") {
    const fileEvents = report.exportProgress.filter((event) => event.currentFileStatus);
    const completed = fileEvents.filter((event) => event.currentFileStatus === "completed");
    if (
      completed.length !== report.export.fileCount
      || completed.some((event) => !event.fileStartedAt
        || !event.fileFinishedAt
        || !Number.isInteger(event.fileDurationMs)
        || !Number.isSafeInteger(event.bytesWritten))
    ) {
      throw new Error(`Project bundle progress telemetry is incomplete: ${completed.length}/${report.export.fileCount}`);
    }
  }
  if (
    targetHeight > 384
    && exportFormat !== "mcstructure"
    && exportFormat !== "mcfunction"
    && (!report.safety.unlockDialog
      || !report.safety.persistentWarning
      || !report.safety.confirmDisabledBeforeAcknowledge
      || !report.safety.confirmEnabledAfterAcknowledge
      || (targetHeight > 2032 && (!report.safety.extremeUnlockDialog
        || !report.safety.extremeEnvironmentDialog
        || !report.safety.extremePhraseEntered)))
  ) {
    throw new Error(`Extended-height safety checks failed: ${JSON.stringify(report.safety)}`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
