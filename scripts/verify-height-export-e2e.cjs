const { Buffer } = require("node:buffer");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require(process.env.MELY_PLAYWRIGHT_MODULE || "playwright");
const { gunzipSync, strFromU8, unzipSync } = require("fflate");
const nbt = require("prismarine-nbt");

const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const outputDirectory = process.env.MELY_E2E_OUTPUT || "height-export-e2e";
const reportPath = process.env.MELY_REPORT_PATH || "height-export-e2e-report.json";
const downloadTimeoutMs = Number(process.env.MELY_DOWNLOAD_TIMEOUT_MS || 120_000);
const onlyFormat = process.env.MELY_E2E_ONLY_FORMAT || "";
const stopAfterSafe = process.env.MELY_E2E_STOP_AFTER_SAFE === "1";

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");

const formats = [
  { id: "litematic", label: "Litematica projection", extension: "litematic" },
  { id: "bundle", label: "32³ project bundle ZIP", extension: "zip" },
  { id: "schematic", label: "Sponge Schematic", extension: "schem" },
  { id: "mcstructure", label: "Bedrock structure", extension: "mcstructure" },
  { id: "mcfunction", label: "Bedrock behavior pack", extension: "zip" },
];
const selectedFormats = onlyFormat
  ? formats.filter(({ id }) => id === onlyFormat)
  : formats;

if (!selectedFormats.length) {
  throw new Error(`Unknown MELY_E2E_ONLY_FORMAT: ${onlyFormat}`);
}

const fixtureProfiles = {
  narrow: (height) => ({
    positions: [0, 0, 0, 0, height - 1, 0],
    dimensions: [1, height, 1],
  }),
  proportional: (height) => {
    const width = Math.max(2, Math.round(height * 0.45));
    const depth = Math.max(2, Math.round(height * 0.3));
    return {
      positions: [0, 0, 0, width - 1, height - 1, depth - 1],
      dimensions: [width, height, depth],
    };
  },
};

const overflowReport = async (page) => page.evaluate(() => {
  const viewportWidth = document.documentElement.clientWidth;
  const offenders = [...document.querySelectorAll("body *")]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
    })
    .slice(0, 16)
    .map((element) => ({
      tag: element.tagName,
      className: typeof element.className === "string" ? element.className : "",
      text: element.textContent?.trim().slice(0, 100),
    }));
  return {
    viewportWidth,
    documentWidth: document.documentElement.scrollWidth,
    offenders,
  };
});

const injectFixtureWorker = () => {
  window.__MELY_HEIGHT_FIXTURE_PROFILE = "narrow";
  window.__MELY_HEIGHT_FIXTURE_ACTUAL_HEIGHT = null;
  window.__MELY_E2E_EVENTS = [];
  const record = (type, detail = {}) => {
    window.__MELY_E2E_EVENTS.push({
      type,
      at: Math.round(performance.now()),
      ...detail,
    });
  };
  const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    const url = nativeCreateObjectUrl(object);
    record("object-url", {
      size: object?.size ?? null,
      mime: object?.type ?? null,
      url: String(url).slice(0, 80),
    });
    return url;
  };
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function instrumentedAnchorClick() {
    record("anchor-click", {
      download: this.download,
      href: this.href.slice(0, 100),
    });
    return nativeAnchorClick.call(this);
  };
  const NativeWorker = window.Worker;
  class FixtureWorker {
    constructor(url, options) {
      if (!String(url).includes("conversion.worker")) {
        record("worker-create", { url: String(url), fixture: false });
        const worker = new NativeWorker(url, options);
        worker.addEventListener("error", (event) => {
          record("worker-error", {
            url: String(url),
            message: event.message,
          });
        });
        worker.addEventListener("messageerror", () => {
          record("worker-message-error", { url: String(url) });
        });
        return worker;
      }
      record("worker-create", { url: String(url), fixture: true });
      this.onmessage = null;
      this.terminated = false;
    }

    postMessage(command) {
      if (this.terminated) return;
      const targetHeight = Math.max(1, Math.round(command.options?.targetHeight || 1));
      const height = Math.max(
        1,
        Math.round(window.__MELY_HEIGHT_FIXTURE_ACTUAL_HEIGHT || targetHeight),
      );
      const proportional = window.__MELY_HEIGHT_FIXTURE_PROFILE === "proportional";
      const width = proportional ? Math.max(2, Math.round(height * 0.45)) : 1;
      const depth = proportional ? Math.max(2, Math.round(height * 0.3)) : 1;
      const result = {
        kind: "hologram",
        positions: Float32Array.from([
          0, 0, 0,
          width - 1, height - 1, depth - 1,
        ]),
        facings: Uint8Array.from([2, 2]),
        materials: Uint8Array.from([0, 0]),
        stats: {
          blockCount: 2,
          endRodCount: 2,
          paneCount: 0,
          removedConflicts: 0,
          dimensions: [width, height, depth],
        },
        bounds: {
          min: [0, 0, 0],
          max: [width - 1, height - 1, depth - 1],
        },
      };
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onmessage?.({
          data: { type: "PROGRESS", jobId: command.jobId, stage: "sampling", progress: 0.72 },
        });
        this.onmessage?.({
          data: { type: "RESULT", jobId: command.jobId, result },
        });
      });
    }

    terminate() {
      this.terminated = true;
      this.onmessage = null;
    }
  }
  window.Worker = FixtureWorker;
};

const parseLitematic = async (bytes) => {
  const { parsed } = await nbt.parse(Buffer.from(bytes), "big");
  const root = nbt.simplify(parsed);
  return {
    version: root.Version,
    dataVersion: root.MinecraftDataVersion,
    dimensions: [
      root.Metadata.EnclosingSize.x,
      root.Metadata.EnclosingSize.y,
      root.Metadata.EnclosingSize.z,
    ],
    blocks: root.Metadata.TotalBlocks,
    regions: root.Metadata.RegionCount,
  };
};

const parseSchematic = (bytes) => {
  const root = nbt.simplify(nbt.parseUncompressed(Buffer.from(gunzipSync(bytes)), "big"));
  return {
    version: root.Version,
    dataVersion: root.DataVersion,
    dimensions: [root.Width, root.Height, root.Length],
  };
};

const parseMcstructure = (bytes) => {
  const root = nbt.simplify(nbt.parseUncompressed(Buffer.from(bytes), "little"));
  return {
    formatVersion: root.format_version,
    dimensions: root.size,
    origin: root.structure_world_origin,
  };
};

const commandExtents = (files) => {
  const commandFiles = Object.entries(files)
    .filter(([name]) => name.endsWith(".mcfunction") && name.includes("/chunks/"));
  const coordinates = [];
  const readCoordinate = (token) => token === "~" ? 0 : Number(token.slice(1));
  for (const [, bytes] of commandFiles) {
    for (const line of strFromU8(bytes).trim().split("\n")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens[0] === "setblock") {
        coordinates.push(tokens.slice(1, 4).map(readCoordinate));
      } else if (tokens[0] === "fill") {
        coordinates.push(tokens.slice(1, 4).map(readCoordinate));
        coordinates.push(tokens.slice(4, 7).map(readCoordinate));
      }
    }
  }
  if (!coordinates.length) return null;
  return {
    min: [0, 1, 2].map((axis) => Math.min(...coordinates.map((point) => point[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...coordinates.map((point) => point[axis]))),
  };
};

const parseZip = (bytes, format) => {
  const files = unzipSync(bytes);
  if (format === "bundle") {
    const manifest = JSON.parse(strFromU8(files["bundle.json"]));
    return {
      fileCount: Object.keys(files).length,
      format: manifest.format,
      dimensions: manifest.projection.bounds.dimensions,
      blocks: manifest.projection.blockCount,
      partCount: manifest.parts.length,
      hasMaterials: Boolean(files[manifest.guides.materials]),
      hasChests: Boolean(files[manifest.guides.chests]),
    };
  }
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  return {
    fileCount: Object.keys(files).length,
    minEngineVersion: manifest.header.min_engine_version,
    commandExtents: commandExtents(files),
  };
};

const parseExport = async (filePath, format) => {
  const bytes = await readFile(filePath);
  const parsed = format === "litematic"
    ? await parseLitematic(bytes)
    : format === "schematic"
      ? parseSchematic(bytes)
      : format === "mcstructure"
        ? parseMcstructure(bytes)
        : parseZip(bytes, format);
  return { bytes: bytes.byteLength, ...parsed };
};

const dimensionsEqual = (left, right) => (
  Array.isArray(left)
  && left.length === right.length
  && left.every((value, index) => value === right[index])
);

const assertExport = (format, parsed, expectedDimensions) => {
  if (format === "litematic") {
    if (parsed.version !== 6 || parsed.dataVersion !== 3465 || parsed.blocks !== 2) {
      throw new Error(`Invalid Litematica export: ${JSON.stringify(parsed)}`);
    }
  } else if (format === "schematic") {
    if (parsed.version !== 3 || parsed.dataVersion !== 3465) {
      throw new Error(`Invalid Schematic export: ${JSON.stringify(parsed)}`);
    }
  } else if (format === "mcstructure") {
    if (parsed.formatVersion !== 1) {
      throw new Error(`Invalid mcstructure export: ${JSON.stringify(parsed)}`);
    }
  } else if (format === "bundle") {
    if (parsed.format !== "MELYExportBundle" || parsed.blocks !== 2 || !parsed.hasMaterials || !parsed.hasChests) {
      throw new Error(`Invalid project bundle: ${JSON.stringify(parsed)}`);
    }
  } else if (
    !dimensionsEqual(parsed.minEngineVersion, [1, 20, 10])
    || !parsed.commandExtents
    || !dimensionsEqual(parsed.commandExtents.max, expectedDimensions.map((value) => value - 1))
  ) {
    throw new Error(`Invalid behavior pack: ${JSON.stringify(parsed)}`);
  }
  if (format !== "mcfunction" && !dimensionsEqual(parsed.dimensions, expectedDimensions)) {
    throw new Error(`${format} dimensions differ: ${JSON.stringify(parsed.dimensions)} != ${JSON.stringify(expectedDimensions)}`);
  }
};

const loadModel = async (page) => {
  // Vite 的 HMR WebSocket 会持续保持连接，不能用 networkidle 判断应用已就绪。
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 120_000 });
  await page.locator(".locale-control select").selectOption("en-US");
  await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
  await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 120_000 }).catch(() => undefined);
  await page.waitForFunction(
    () => document.querySelector("canvas") && document.body.innerText.includes("Vertices"),
    null,
    { timeout: 120_000 },
  );
};

const targetHeightInput = (page) => page.locator(".field-row")
  .filter({ hasText: "Target height" })
  .locator(".slider-number input");

const setHeight = async (page, height) => {
  const input = targetHeightInput(page);
  await input.fill(String(height));
  await input.press("Enter");
  if (await input.inputValue() !== String(height)) {
    throw new Error(`Target height did not update to ${height}`);
  }
};

const generateFixture = async (page, profile, targetHeight, actualHeight = targetHeight) => {
  await page.evaluate(({ profile: value, actualHeight: resultHeight }) => {
    window.__MELY_HEIGHT_FIXTURE_PROFILE = value;
    window.__MELY_HEIGHT_FIXTURE_ACTUAL_HEIGHT = resultHeight;
  }, { profile, actualHeight });
  await setHeight(page, targetHeight);
  await page.getByRole("button", { name: "Generate hologram" }).click();
  await page.locator(".export-button").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const button = document.querySelector(".export-button");
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    null,
    { timeout: 120_000 },
  ).catch(() => {
    throw new Error(
      `Export did not become available for ${profile} target ${targetHeight}, actual ${actualHeight}`,
    );
  });
};

const openExportCenter = async (page) => {
  await page.locator(".export-button").click();
  const dialog = page.getByRole("dialog", { name: "Export center" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
};

const formatButton = (dialog, format) => dialog.getByRole("button", {
  name: new RegExp(`^${format.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
});

const closeDialog = (dialog) => dialog.locator(".window-panel__close").click();

const browserState = (page) => page.evaluate(() => ({
  events: window.__MELY_E2E_EVENTS?.slice(-80) ?? [],
  toast: document.querySelector(".toast")?.textContent?.trim() ?? null,
  progress: [...document.querySelectorAll(".progress-block")].map((element) => ({
    text: element.textContent?.trim() ?? "",
    visible: Boolean(element.getClientRects().length),
  })),
  exportButton: (() => {
    const button = document.querySelector(".export-button");
    return button ? {
      disabled: button.disabled,
      text: button.textContent?.trim() ?? "",
    } : null;
  })(),
  dialogs: [...document.querySelectorAll('[role="dialog"]')].map((element) => ({
    label: element.getAttribute("aria-label"),
    text: element.textContent?.trim().slice(0, 500) ?? "",
    visible: Boolean(element.getClientRects().length),
  })),
}));

const saveDownload = async (page, format, destination, action, report) => {
  const startedAt = Date.now();
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      samples.push({
        elapsedMs: Date.now() - startedAt,
        ...await browserState(page),
      });
      await page.waitForTimeout(250);
    }
  })();
  const downloadPromise = page.waitForEvent("download", { timeout: downloadTimeoutMs });
  await action();
  try {
    const download = await downloadPromise;
    await download.saveAs(destination);
    report.exportDiagnostics.push({
      format: format.id,
      destination,
      elapsedMs: Date.now() - startedAt,
      outcome: "downloaded",
      samples,
    });
    return parseExport(destination, format.id);
  } catch (error) {
    report.exportDiagnostics.push({
      format: format.id,
      destination,
      elapsedMs: Date.now() - startedAt,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      samples,
      finalState: await browserState(page),
    });
    throw error;
  } finally {
    sampling = false;
    await sampler;
  }
};

const directExport = async (page, format, destination, report) => {
  const dialog = await openExportCenter(page);
  return saveDownload(page, format, destination, () => formatButton(dialog, format).click(), report);
};

const isBedrockFormat = (format) => (
  format.id === "mcstructure" || format.id === "mcfunction"
);

const unlockExtendedHeight = async (page) => {
  const unlock = page.locator('.height-unlock[aria-pressed]');
  if (await unlock.isDisabled()) {
    throw new Error("The 2,032-layer unlock is disabled");
  }
  await unlock.click();
  const dialog = page.getByRole("dialog", { name: "Extended-height warning" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Unlock height", exact: true }).click();
  await page.waitForFunction(() => (
    document.querySelector('.height-unlock[aria-pressed]')?.getAttribute("aria-pressed") === "true"
  ));

  const declaration = page.locator(".dimension-declaration");
  const inputs = declaration.locator('input[type="number"]');
  await inputs.nth(0).fill("-1024");
  await inputs.nth(1).fill("2032");
  await inputs.nth(2).fill("-1024");
  return {
    unlockDisabled: false,
    dialogReached: true,
    declaration: await inputs.evaluateAll((elements) => elements.map((element) => Number(element.value))),
  };
};

const reachExtremeHeight = async (page, report) => {
  const button = page.getByRole("button", {
    name: "Unlock experimental limit (4,064 layers)",
    exact: true,
  });
  if (await button.isDisabled()) throw new Error("The 4,064-layer unlock is disabled");
  await button.click();

  const unlockDialog = page.getByRole("dialog", {
    name: "Experimental 4,064 layers: unlock",
  });
  await unlockDialog.waitFor({ state: "visible" });
  await unlockDialog.getByRole("button", {
    name: "Continue to environment checks",
    exact: true,
  }).click();

  const environmentDialog = page.getByRole("dialog", {
    name: "Experimental 4,064 layers: environment checks",
  });
  await environmentDialog.waitFor({ state: "visible" });
  const checks = environmentDialog.locator('input[type="checkbox"]');
  if (await checks.count() !== 3) {
    throw new Error(`Expected three 4,064-layer environment notices, found ${await checks.count()}`);
  }
  for (let index = 0; index < 3; index += 1) await checks.nth(index).check();
  await environmentDialog.getByRole("button", {
    name: "Confirm this environment",
    exact: true,
  }).click();
  await environmentDialog.waitFor({ state: "hidden" });

  const declaration = page.locator(".dimension-declaration").locator('input[type="number"]');
  const targetHeight = Number(await targetHeightInput(page).inputValue());
  const values = await declaration.evaluateAll((elements) => elements.map((element) => Number(element.value)));
  if (targetHeight !== 4064 || !dimensionsEqual(values, [-2032, 4064, -2032])) {
    throw new Error(`4,064-layer state did not activate: ${JSON.stringify({ targetHeight, values })}`);
  }

  await page.evaluate(() => {
    window.__MELY_HEIGHT_FIXTURE_PROFILE = "narrow";
    window.__MELY_HEIGHT_FIXTURE_ACTUAL_HEIGHT = 4064;
  });
  await page.getByRole("button", { name: "Generate hologram" }).click();
  await page.locator(".export-button").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(() => {
    const control = document.querySelector(".export-button");
    return control instanceof HTMLButtonElement && !control.disabled;
  }, null, { timeout: 120_000 });
  const exportCenter = await openExportCenter(page);
  const litematic = formats.find(({ id }) => id === "litematic");
  if (!litematic) throw new Error("Missing Litematica E2E descriptor");
  const litematicButton = formatButton(exportCenter, litematic);
  if (await litematicButton.isDisabled()) {
    throw new Error(`4,064-layer Litematica attempt is unavailable: ${await litematicButton.innerText()}`);
  }
  await litematicButton.click();
  const exportDialog = page.getByRole("dialog", {
    name: "Safety confirmation: this is not a vanilla projection",
  });
  await exportDialog.waitFor({ state: "visible" });
  const confirm = exportDialog.getByRole("button", { name: "Confirm export", exact: true });
  const confirmDisabledInitially = await confirm.isDisabled();
  await exportDialog.locator('input[type="checkbox"]').check();
  await exportDialog.locator('.extreme-export-phrase input[type="text"]').fill("导出 4064");
  const confirmEnabledAfterAcknowledgement = await confirm.isEnabled();
  if (!confirmDisabledInitially || !confirmEnabledAfterAcknowledgement) {
    throw new Error("The 4,064-layer per-export confirmation did not become reachable");
  }
  const destination = path.join(outputDirectory, "height-4064-litematic.litematic");
  const parsed = await saveDownload(
    page,
    litematic,
    destination,
    () => confirm.click(),
    report,
  );
  assertExport(litematic.id, parsed, fixtureProfiles.narrow(4064).dimensions);
  return {
    unlockDialogReached: true,
    environmentDialogReached: true,
    environmentNoticeCount: 3,
    exportDialogReached: true,
    confirmDisabledInitially,
    confirmEnabledAfterAcknowledgement,
    targetHeight,
    declaration: values,
    confirmedExport: parsed,
  };
};

const main = async () => {
  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const report = {
    consoleErrors: [],
    pageErrors: [],
    console: [],
    downloadCount: 0,
    exportDiagnostics: [],
    scenarios: {},
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(injectFixtureWorker);
  page.on("console", (message) => {
    report.console.push({ type: message.type(), text: message.text() });
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("download", () => {
    report.downloadCount += 1;
  });

  try {
    await loadModel(page);

    await generateFixture(page, "narrow", 384);
    const safeDimensions = fixtureProfiles.narrow(384).dimensions;
    const safeScenario = { dimensions: safeDimensions, exports: {} };
    await (await openExportCenter(page)).screenshot({
      path: path.join(outputDirectory, "height-384-export-center.png"),
    });
    await closeDialog(page.getByRole("dialog", { name: "Export center" }));
    for (const format of selectedFormats) {
      const destination = path.join(outputDirectory, `height-384-${format.id}.${format.extension}`);
      const parsed = await directExport(page, format, destination, report);
      assertExport(format.id, parsed, safeDimensions);
      safeScenario.exports[format.id] = parsed;
    }
    report.scenarios.safe384 = safeScenario;

    if (stopAfterSafe) return;

    await generateFixture(page, "narrow", 320, 385);
    const boundaryDimensions = fixtureProfiles.narrow(385).dimensions;
    const boundaryScenario = {
      targetHeight: Number(await targetHeightInput(page).inputValue()),
      dimensions: boundaryDimensions,
      warningVisible: await page.locator(".height-warning").isVisible(),
      availability: {},
      bedrockDirectExports: {},
    };
    const boundaryCenter = await openExportCenter(page);
    for (const format of selectedFormats) {
      const button = formatButton(boundaryCenter, format);
      boundaryScenario.availability[format.id] = {
        disabled: await button.isDisabled(),
        text: (await button.innerText()).trim(),
      };
    }
    await boundaryCenter.screenshot({
      path: path.join(outputDirectory, "height-385-structural-preflight.png"),
    });
    await closeDialog(boundaryCenter);
    for (const format of selectedFormats.filter(isBedrockFormat)) {
      const destination = path.join(outputDirectory, `height-385-${format.id}.${format.extension}`);
      const parsed = await directExport(page, format, destination, report);
      assertExport(format.id, parsed, boundaryDimensions);
      boundaryScenario.bedrockDirectExports[format.id] = parsed;
    }
    report.scenarios.boundary385 = boundaryScenario;

    const versionSelect = page.locator(".field-row")
      .filter({ hasText: "Target Java version" })
      .locator("select");
    await versionSelect.selectOption("1.20.2");
    const versionWarning = page.locator('[role="status"]').filter({ hasText: "not fully tested" }).first();
    await versionWarning.waitFor({ state: "visible" });
    const extended2032 = {
      version: await versionSelect.inputValue(),
      versionWarning: (await versionWarning.innerText()).trim(),
      ...await unlockExtendedHeight(page),
      javaAvailability: {},
    };
    await generateFixture(page, "narrow", 2032);
    const extendedCenter = await openExportCenter(page);
    for (const format of formats.filter(({ id }) => !isBedrockFormat({ id }))) {
      const formatControl = formatButton(extendedCenter, format);
      extended2032.javaAvailability[format.id] = {
        disabled: await formatControl.isDisabled(),
        text: (await formatControl.innerText()).trim(),
      };
    }
    await extendedCenter.screenshot({
      path: path.join(outputDirectory, "height-2032-best-effort-export-center.png"),
    });
    if (Object.values(extended2032.javaAvailability).some(({ disabled }) => disabled)) {
      throw new Error(`2,032-layer Java export is not attemptable: ${JSON.stringify(extended2032)}`);
    }
    const extendedLitematic = selectedFormats.find(({ id }) => id === "litematic");
    if (extendedLitematic) {
      await formatButton(extendedCenter, extendedLitematic).click();
      const confirmation = page.getByRole("dialog", {
        name: "Safety confirmation: this is not a vanilla projection",
      });
      await confirmation.waitFor({ state: "visible" });
      const confirm = confirmation.getByRole("button", { name: "Confirm export", exact: true });
      const confirmDisabledInitially = await confirm.isDisabled();
      await confirmation.locator('input[type="checkbox"]').check();
      const confirmEnabledAfterAcknowledgement = await confirm.isEnabled();
      const destination = path.join(outputDirectory, "height-2032-litematic.litematic");
      const parsed = await saveDownload(
        page,
        extendedLitematic,
        destination,
        () => confirm.click(),
        report,
      );
      assertExport(extendedLitematic.id, parsed, fixtureProfiles.narrow(2032).dimensions);
      extended2032.confirmation = {
        confirmDisabledInitially,
        confirmEnabledAfterAcknowledgement,
      };
      extended2032.confirmedExport = parsed;
    } else {
      await closeDialog(extendedCenter);
    }
    report.scenarios.extended2032Reachable = extended2032;
    report.scenarios.extreme4064Reachable = await reachExtremeHeight(page, report);

    report.finalOverflow = await overflowReport(page);
    if (report.consoleErrors.length || report.pageErrors.length) {
      throw new Error(`Browser errors detected: ${JSON.stringify({
        consoleErrors: report.consoleErrors,
        pageErrors: report.pageErrors,
      })}`);
    }
    if (report.finalOverflow.offenders.length || report.finalOverflow.documentWidth > report.finalOverflow.viewportWidth) {
      throw new Error(`Horizontal overflow detected: ${JSON.stringify(report.finalOverflow)}`);
    }
    for (const format of selectedFormats) {
      const availability = boundaryScenario.availability[format.id];
      if (boundaryScenario.targetHeight !== 320
        || !boundaryScenario.warningVisible
        || (isBedrockFormat(format)
          ? availability.disabled || !boundaryScenario.bedrockDirectExports[format.id]
          : !availability.disabled)) {
        throw new Error(`Target-320 actual-span-385 structural routing failed for ${format.id}: ${JSON.stringify({
          targetHeight: boundaryScenario.targetHeight,
          warningVisible: boundaryScenario.warningVisible,
          availability,
          bedrockDirectExport: boundaryScenario.bedrockDirectExports[format.id] ?? null,
        })}`);
      }
    }
  } finally {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, json, "utf8");
    process.stdout.write(json);
    await browser.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
