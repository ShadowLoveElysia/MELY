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
  { id: "litematic", label: "Litematica projection", extension: "litematica" },
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
  await page.goto(appUrl, { waitUntil: "networkidle" });
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

const unlockExtendedHeight = async (page) => {
  const unlock = page.locator(".height-unlock");
  if (await unlock.getAttribute("aria-pressed") === "true") return;
  await unlock.click();
  const dialog = page.getByRole("dialog", { name: "Extended-height warning" });
  await dialog.getByRole("button", { name: "Unlock height" }).click();
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

const gatedExport = async (page, format, destination, report) => {
  const firstCenter = await openExportCenter(page);
  await formatButton(firstCenter, format).click();
  const firstGate = page.getByRole("dialog", {
    name: "Safety confirmation: this is not a vanilla projection",
  });
  const firstConfirm = firstGate.getByRole("button", { name: "Confirm export" });
  const firstCheckbox = firstGate.locator('input[type="checkbox"]');
  const initialDisabled = await firstConfirm.isDisabled();
  await firstGate.focus();
  const downloadCountBeforeEnter = report.downloadCount;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const enterDidNotDownload = report.downloadCount === downloadCountBeforeEnter;
  const remainedOpenAfterEnter = await firstGate.isVisible();
  await firstCheckbox.check();
  const enabledAfterCheck = await firstConfirm.isEnabled();
  await closeDialog(firstGate);

  const secondCenter = await openExportCenter(page);
  await formatButton(secondCenter, format).click();
  const secondGate = page.getByRole("dialog", {
    name: "Safety confirmation: this is not a vanilla projection",
  });
  const secondCheckbox = secondGate.locator('input[type="checkbox"]');
  const resetAfterClose = !await secondCheckbox.isChecked()
    && await secondGate.getByRole("button", { name: "Confirm export" }).isDisabled();
  await secondCheckbox.check();
  const parsed = await saveDownload(
    page,
    format,
    destination,
    () => secondGate.getByRole("button", { name: "Confirm export" }).click(),
    report,
  );
  await secondGate.waitFor({ state: "hidden" });
  const thirdCenter = await openExportCenter(page);
  await formatButton(thirdCenter, format).click();
  const thirdGate = page.getByRole("dialog", {
    name: "Safety confirmation: this is not a vanilla projection",
  });
  const resetAfterDownload = !await thirdGate.locator('input[type="checkbox"]').isChecked()
    && await thirdGate.getByRole("button", { name: "Confirm export" }).isDisabled();
  await closeDialog(thirdGate);
  return {
    initialDisabled,
    enterDidNotDownload,
    remainedOpenAfterEnter,
    enabledAfterCheck,
    resetAfterClose,
    resetAfterDownload,
    parsed,
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
      exports: {},
    };
    for (const format of selectedFormats) {
      const destination = path.join(outputDirectory, `height-385-${format.id}.${format.extension}`);
      const result = await gatedExport(page, format, destination, report);
      assertExport(format.id, result.parsed, boundaryDimensions);
      boundaryScenario.exports[format.id] = result;
      if (format.id === "litematic") {
        await page.screenshot({ path: path.join(outputDirectory, "height-385-after-export.png"), fullPage: true });
      }
    }
    report.scenarios.boundary385 = boundaryScenario;

    await unlockExtendedHeight(page);
    await generateFixture(page, "narrow", 2032);
    const narrowDimensions = fixtureProfiles.narrow(2032).dimensions;
    const narrowScenario = { dimensions: narrowDimensions, exports: {} };
    for (const format of selectedFormats) {
      const destination = path.join(outputDirectory, `height-2032-narrow-${format.id}.${format.extension}`);
      const result = await gatedExport(page, format, destination, report);
      assertExport(format.id, result.parsed, narrowDimensions);
      narrowScenario.exports[format.id] = result;
    }
    report.scenarios.narrow2032 = narrowScenario;

    await generateFixture(page, "proportional", 2032);
    const proportionalDimensions = fixtureProfiles.proportional(2032).dimensions;
    const center = await openExportCenter(page);
    const formatAvailability = {};
    for (const format of selectedFormats) {
      const button = formatButton(center, format);
      formatAvailability[format.id] = {
        disabled: await button.isDisabled(),
        text: (await button.innerText()).trim(),
      };
    }
    await center.screenshot({ path: path.join(outputDirectory, "height-2032-proportional-preflight.png") });
    await closeDialog(center);
    const sparseExports = {};
    for (const format of selectedFormats.filter(({ id }) => id === "litematic" || id === "bundle" || id === "mcfunction")) {
      const destination = path.join(outputDirectory, `height-2032-proportional-${format.id}.${format.extension}`);
      const result = await gatedExport(page, format, destination, report);
      assertExport(format.id, result.parsed, proportionalDimensions);
      sparseExports[format.id] = result;
    }
    report.scenarios.proportional2032 = {
      dimensions: proportionalDimensions,
      denseVolume: proportionalDimensions.reduce((product, value) => product * value, 1),
      availability: formatAvailability,
      sparseExports,
    };

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
    for (const formatId of ["schematic", "mcstructure"]) {
      const availability = formatAvailability[formatId];
      if (availability && !availability.disabled) {
        throw new Error(`Dense format was not disabled: ${JSON.stringify({
          formatId,
          availability,
        })}`);
      }
    }
    for (const format of selectedFormats) {
      const assertions = boundaryScenario.exports[format.id];
      if (boundaryScenario.targetHeight !== 320
        || !boundaryScenario.warningVisible
        || !assertions.initialDisabled
        || !assertions.enterDidNotDownload
        || !assertions.remainedOpenAfterEnter
        || !assertions.enabledAfterCheck
        || !assertions.resetAfterClose
        || !assertions.resetAfterDownload) {
        throw new Error(`Target-320 actual-span-385 safety gate failed for ${format.id}: ${JSON.stringify({
          targetHeight: boundaryScenario.targetHeight,
          warningVisible: boundaryScenario.warningVisible,
          assertions,
        })}`);
      }
    }
    for (const format of selectedFormats) {
      const assertions = narrowScenario.exports[format.id];
      if (!assertions.initialDisabled
        || !assertions.enterDidNotDownload
        || !assertions.resetAfterClose
        || !assertions.resetAfterDownload) {
        throw new Error(`2032 safety gate failed for ${format.id}: ${JSON.stringify(assertions)}`);
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
