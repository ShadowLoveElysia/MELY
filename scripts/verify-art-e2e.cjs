const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdir, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const { chromium } = require(process.env.MELY_PLAYWRIGHT_MODULE || "playwright");

const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4212/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const targetHeight = Number(process.env.MELY_TARGET_HEIGHT || 320);
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY || join(projectRoot, "release-validation/art-e2e"),
);
const reportPath = resolve(process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"));
const TWO_GIB = 2 * 1024 ** 3;

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");
if (!Number.isInteger(targetHeight) || targetHeight < 32 || targetHeight > 384) {
  throw new Error("MELY_TARGET_HEIGHT must be an integer from 32 to 384");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));

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

const rangeValue = async (range, value) => {
  await range.fill(String(value));
  await range.evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
};

const field = (page, label) => page.locator(".field-row").filter({ hasText: label });

const setTheme = async (page, theme) => {
  await field(page, "Block material theme").locator("select").selectOption(theme);
};

const setDithering = async (page, amount) => {
  await rangeValue(field(page, "Color dithering").locator('input[type="range"]'), amount);
};

const setRuinDecoration = async (page, amount) => {
  const control = field(page, "Ruin weathering strength");
  if (amount === 0 && await control.count() === 0) return;
  await control.waitFor({ state: "visible" });
  await rangeValue(control.locator('input[type="range"]'), amount);
};

const setEmissiveMapping = async (page, enabled) => {
  const toggle = page.getByRole("switch", { name: "Map emissive materials", exact: true });
  const current = await toggle.getAttribute("aria-checked") === "true";
  if (current !== enabled) await toggle.click();
};

const resetProjectionCapture = async (page) => {
  await page.evaluate(() => {
    window.__melyProjectionResult = null;
  });
};

const generateSolid = async (page) => {
  await resetProjectionCapture(page);
  const generate = page.getByRole("button", { name: "Generate solid projection", exact: true });
  await generate.waitFor({ state: "visible" });
  if (!await generate.isEnabled()) throw new Error("Solid generation is disabled");
  await generate.click();
  await page.waitForFunction(() => Boolean(document.querySelector(".progress-block")), null, {
    timeout: 15_000,
  });
  await page.waitForFunction(() => {
    const result = window.__melyProjectionResult;
    const exportButton = document.querySelector(".export-button");
    return result?.kind === "solid"
      && !document.querySelector(".progress-block")
      && exportButton instanceof HTMLButtonElement
      && !exportButton.disabled;
  }, null, { timeout: 300_000 });
};

const summarizeProjection = async (page, { baseline = false } = {}) => page.evaluate(async ({ baseline }) => {
  const result = window.__melyProjectionResult;
  if (!result || result.kind !== "solid") throw new Error("Solid projection result is unavailable");

  const coordinateBytes = new Uint8Array(
    result.positions.buffer,
    result.positions.byteOffset,
    result.positions.byteLength,
  );
  const coordinateDigest = await crypto.subtle.digest("SHA-256", coordinateBytes);
  const coordinateHash = [...new Uint8Array(coordinateDigest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const coordinates = new Set();
  const paletteCounts = new Map();
  const lightBlocks = new Set([
    "minecraft:end_rod",
    "minecraft:glowstone",
    "minecraft:sea_lantern",
    "minecraft:ochre_froglight",
    "minecraft:verdant_froglight",
    "minecraft:pearlescent_froglight",
    "minecraft:glow_lichen",
  ]);
  let lightBlockCount = 0;
  let stateHashA = 0x811c9dc5;
  let stateHashB = 0x9e3779b9;
  const updateHash = (value) => {
    stateHashA ^= value & 0xff;
    stateHashA = Math.imul(stateHashA, 0x01000193);
    stateHashB ^= value & 0xff;
    stateHashB = Math.imul(stateHashB, 0x85ebca6b);
  };

  for (let index = 0; index < result.blockIndices.length; index += 1) {
    const x = result.positions[index * 3];
    const y = result.positions[index * 3 + 1];
    const z = result.positions[index * 3 + 2];
    const key = `${x},${y},${z}`;
    coordinates.add(key);
    const blockId = result.palette[result.blockIndices[index]]?.blockId || "unknown";
    paletteCounts.set(blockId, (paletteCounts.get(blockId) || 0) + 1);
    if (lightBlocks.has(blockId)) lightBlockCount += 1;
    updateHash(x);
    updateHash(x >> 8);
    updateHash(y);
    updateHash(y >> 8);
    updateHash(z);
    updateHash(z >> 8);
    for (let offset = 0; offset < blockId.length; offset += 1) updateHash(blockId.charCodeAt(offset));
  }

  if (baseline) window.__melyArtBaselineCoordinates = coordinates;
  const baselineCoordinates = window.__melyArtBaselineCoordinates;
  let missingFromBaseline = 0;
  let additionsToBaseline = 0;
  if (baselineCoordinates instanceof Set) {
    for (const key of baselineCoordinates) {
      if (!coordinates.has(key)) missingFromBaseline += 1;
    }
    for (const key of coordinates) {
      if (!baselineCoordinates.has(key)) additionsToBaseline += 1;
    }
  }

  return {
    coordinateHash,
    stateHash: `${(stateHashA >>> 0).toString(16).padStart(8, "0")}${(stateHashB >>> 0).toString(16).padStart(8, "0")}`,
    paletteCounts: [...paletteCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([blockId, count]) => ({ blockId, count })),
    lightBlockCount,
    missingFromBaseline,
    additionsToBaseline,
    stats: result.stats,
    bounds: result.bounds,
  };
}, { baseline });

const canvasSample = async (page, name) => {
  await page.getByRole("button", { name: "Reset camera", exact: true }).click();
  await delay(450);
  const canvas = page.locator("canvas").first();
  const screenshot = await canvas.screenshot({ type: "png" });
  const path = join(outputDirectory, `${name}.png`);
  await writeFile(path, screenshot);
  const pixels = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();
    const sample = document.createElement("canvas");
    sample.width = 128;
    sample.height = 128;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas sampling is unavailable");
    context.drawImage(image, 0, 0, sample.width, sample.height);
    return [...context.getImageData(0, 0, sample.width, sample.height).data];
  }, screenshot.toString("base64"));
  return { path, hash: sha256(Buffer.from(pixels)), pixels };
};

const pixelDifference = (left, right) => {
  if (left.pixels.length !== right.pixels.length) throw new Error("Canvas samples differ in size");
  let absolute = 0;
  let changed = 0;
  for (let offset = 0; offset < left.pixels.length; offset += 4) {
    const delta = Math.abs(left.pixels[offset] - right.pixels[offset])
      + Math.abs(left.pixels[offset + 1] - right.pixels[offset + 1])
      + Math.abs(left.pixels[offset + 2] - right.pixels[offset + 2]);
    absolute += delta;
    if (delta >= 18) changed += 1;
  }
  const pixelCount = left.pixels.length / 4;
  return {
    meanAbsoluteRgbError: absolute / Math.max(1, pixelCount * 3),
    changedPixelRatio: changed / Math.max(1, pixelCount),
  };
};

const hideViewportGuides = async (page) => {
  for (const name of ["Show grid", "Show voxel bounds"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.evaluate((element) => element.classList.contains("icon-button--active"))) {
      await button.click();
    }
  }
};

const captureVariant = async (page, report, definition) => {
  await setTheme(page, definition.theme);
  await setDithering(page, definition.dithering);
  await setEmissiveMapping(page, definition.emissiveMapping);
  await setRuinDecoration(page, definition.ruinDecoration || 0);
  await generateSolid(page);
  const projection = await summarizeProjection(page, { baseline: definition.baseline });
  const canvas = await canvasSample(page, definition.id);
  report.variants[definition.id] = {
    options: definition,
    projection,
    canvas: { path: canvas.path, hash: canvas.hash },
  };
  return { projection, canvas };
};

const run = async () => {
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    appUrl,
    modelZip,
    targetHeight,
    consoleErrors: [],
    pageErrors: [],
    variants: {},
    peakWorkingSetBytes: 0,
    phasePeaks: {},
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(180_000);
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...arguments_) {
        super(...arguments_);
        this.addEventListener("message", (event) => {
          if (event.data?.type === "RESULT") window.__melyProjectionResult = event.data.result;
        });
      }
    };
  });

  let phase = "startup";
  let sampling = true;
  let samplingError;
  const sampler = (async () => {
    while (sampling) {
      try {
        const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
        const processIds = processInfo
          .map((process) => Number(process.id))
          .filter((processId) => Number.isInteger(processId) && processId > 0);
        const workingSetBytes = await processWorkingSet(processIds);
        report.peakWorkingSetBytes = Math.max(report.peakWorkingSetBytes, workingSetBytes);
        report.phasePeaks[phase] = Math.max(report.phasePeaks[phase] || 0, workingSetBytes);
      } catch (error) {
        samplingError = error;
        break;
      }
      await delay(350);
    }
  })();

  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    phase = "model-load";
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 });
    await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });
    report.modelName = await page.locator(".model-summary__header strong").innerText();

    const heightInput = page.locator(".slider-number input").first();
    await heightInput.fill(String(targetHeight));
    await heightInput.press("Enter");
    await page.getByRole("button", { name: /Solid sculpture/, exact: false }).click();
    await hideViewportGuides(page);

    const variants = [
      { id: "original-glow-flat", theme: "original", dithering: 0, emissiveMapping: true, ruinDecoration: 0, baseline: true },
      { id: "original-no-glow", theme: "original", dithering: 0, emissiveMapping: false, ruinDecoration: 0 },
      { id: "greek-marble", theme: "greekMarble", dithering: 0, emissiveMapping: true, ruinDecoration: 0 },
      { id: "steampunk", theme: "steampunk", dithering: 0, emissiveMapping: true, ruinDecoration: 0 },
      { id: "ancient-ruins", theme: "ancientRuins", dithering: 0, emissiveMapping: true, ruinDecoration: 35 },
      { id: "original-dither-100", theme: "original", dithering: 100, emissiveMapping: true, ruinDecoration: 0 },
    ];

    let baselineCanvas;
    for (const definition of variants) {
      phase = `variant:${definition.id}`;
      const captured = await captureVariant(page, report, definition);
      if (definition.baseline) baselineCanvas = captured.canvas;
    }

    phase = "night-preview";
    await setTheme(page, "original");
    await setDithering(page, 0);
    await setEmissiveMapping(page, true);
    await generateSolid(page);
    const day = await canvasSample(page, "night-preview-day");
    await page.getByRole("button", { name: "Switch to night preview", exact: true }).click();
    await delay(650);
    const night = await canvasSample(page, "night-preview-night");
    report.nightPreview = {
      day: { path: day.path, hash: day.hash },
      night: { path: night.path, hash: night.hash },
      difference: pixelDifference(day, night),
      differsFromInitialBaseline: baselineCanvas ? pixelDifference(baselineCanvas, night) : null,
    };

    const base = report.variants["original-glow-flat"].projection;
    const noGlow = report.variants["original-no-glow"].projection;
    const marble = report.variants["greek-marble"].projection;
    const steampunk = report.variants.steampunk.projection;
    const ruins = report.variants["ancient-ruins"].projection;
    const dither = report.variants["original-dither-100"].projection;
    const lightIds = new Set([
      "minecraft:end_rod",
      "minecraft:glowstone",
      "minecraft:sea_lantern",
      "minecraft:ochre_froglight",
      "minecraft:verdant_froglight",
      "minecraft:pearlescent_froglight",
      "minecraft:glow_lichen",
    ]);
    const themeAllowed = {
      marble: new Set([
        "minecraft:smooth_quartz",
        "minecraft:quartz_block",
        "minecraft:calcite",
        "minecraft:polished_diorite",
        "minecraft:smooth_sandstone",
      ]),
      steampunk: new Set([
        "minecraft:copper_block",
        "minecraft:cut_copper",
        "minecraft:exposed_copper",
        "minecraft:weathered_copper",
        "minecraft:oxidized_copper",
        "minecraft:raw_iron_block",
        "minecraft:iron_block",
        "minecraft:deepslate_gold_ore",
      ]),
      ruins: new Set([
        "minecraft:stone_bricks",
        "minecraft:mossy_stone_bricks",
        "minecraft:calcite",
        "minecraft:moss_block",
        "minecraft:vine",
        "minecraft:glow_lichen",
      ]),
    };
    const paletteAllowed = (projection, allowed) => projection.paletteCounts.every(({ blockId }) => (
      allowed.has(blockId) || lightIds.has(blockId)
    ));
    report.underTwoGiB = report.peakWorkingSetBytes < TWO_GIB;
    report.assertions = {
      baselineGenerated: base.stats.blockCount > 0,
      emissiveCoordinatesPreserved: noGlow.missingFromBaseline === 0 && noGlow.additionsToBaseline === 0,
      emissiveMappingChangedBlocks: base.lightBlockCount > noGlow.lightBlockCount && base.stateHash !== noGlow.stateHash,
      marbleCoordinatesPreserved: marble.missingFromBaseline === 0 && marble.additionsToBaseline === 0,
      marblePaletteConstrained: paletteAllowed(marble, themeAllowed.marble),
      marbleChangedBlocks: marble.stateHash !== base.stateHash,
      steampunkCoordinatesPreserved: steampunk.missingFromBaseline === 0 && steampunk.additionsToBaseline === 0,
      steampunkPaletteConstrained: paletteAllowed(steampunk, themeAllowed.steampunk),
      steampunkChangedBlocks: steampunk.stateHash !== base.stateHash,
      ruinsPreserveSource: ruins.missingFromBaseline === 0,
      ruinsAddDecoration: ruins.additionsToBaseline > 0 && ruins.stats.blockCount > base.stats.blockCount,
      ruinsPaletteConstrained: paletteAllowed(ruins, themeAllowed.ruins),
      ditheringCoordinatesPreserved: dither.missingFromBaseline === 0 && dither.additionsToBaseline === 0,
      ditheringChangedBlocks: dither.stateHash !== base.stateHash,
      nightPreviewChangedPixels: report.nightPreview.difference.changedPixelRatio > 0.2
        && report.nightPreview.difference.meanAbsoluteRgbError > 3,
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
      underTwoGiB: report.underTwoGiB,
    };
    if (!Object.values(report.assertions).every(Boolean)) {
      throw new Error(`Art E2E assertions failed: ${JSON.stringify(report.assertions)}`);
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    sampling = false;
    await sampler;
    if (samplingError && !report.error) {
      report.error = samplingError instanceof Error
        ? `${samplingError.name}: ${samplingError.message}`
        : String(samplingError);
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      reportPath,
      error: report.error,
      peakWorkingSetBytes: report.peakWorkingSetBytes,
      assertions: report.assertions,
      nightPreview: report.nightPreview,
    }, null, 2)}\n`);
    await browser.close();
  }

  if (samplingError) throw samplingError;
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
