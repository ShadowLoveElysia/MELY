const { chromium } = require(process.env.MELY_PLAYWRIGHT_MODULE || "playwright");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { readFile, writeFile } = require("node:fs/promises");
const nbt = require("prismarine-nbt");

const execFileAsync = promisify(execFile);

const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const mode = process.env.MELY_GENERATION_MODE || "hologram";
const faceDetail = process.env.MELY_FACE_DETAIL || "balanced";
const outputSuffix = mode === "solid" ? `${mode}-${faceDetail}` : mode;
const cameraYawDrag = Number(process.env.MELY_CAMERA_YAW_DRAG || 0);
const focusFace = process.env.MELY_FOCUS_FACE === "1";
const reportPath = process.env.MELY_REPORT_PATH;

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");

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

const canvasPixelReport = async (page) => {
  const canvas = page.locator("canvas").first();
  const screenshot = await canvas.screenshot({ type: "png" });
  await writeFile(`test-canvas-${outputSuffix}.png`, screenshot);
  return page.evaluate(async ({ source, outputName, tightFace, focusedFace }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();
    const analysis = document.createElement("canvas");
    analysis.width = image.naturalWidth;
    analysis.height = image.naturalHeight;
    const context = analysis.getContext("2d", { willReadFrequently: true });
    if (!context) return { available: false, reason: "no-2d-context" };
    context.drawImage(image, 0, 0);
    const width = analysis.width;
    const height = analysis.height;
    if (width <= 0 || height <= 0) return { available: false, reason: "empty-buffer", width, height };
    const pixels = context.getImageData(0, 0, width, height).data;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 120000)));
  const colors = new Set();
  let samples = 0;
  let opaque = 0;
  let luminanceMin = 255;
  let luminanceMax = 0;
  let nonBackground = 0;
  let contentMinX = width;
  let contentMinY = height;
  let contentMaxX = -1;
  let contentMaxY = -1;
  const cornerOffset = ((Math.min(height - 1, 2) * width) + Math.min(width - 1, 2)) * 4;
  const background = [
    pixels[cornerOffset],
    pixels[cornerOffset + 1],
    pixels[cornerOffset + 2],
  ];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      samples += 1;
      if (alpha > 0) opaque += 1;
      luminanceMin = Math.min(luminanceMin, luminance);
      luminanceMax = Math.max(luminanceMax, luminance);
      const differsFromBackground = (
        Math.abs(red - background[0])
          + Math.abs(green - background[1])
          + Math.abs(blue - background[2])
        > 20
      );
      if (differsFromBackground) {
        nonBackground += 1;
        contentMinX = Math.min(contentMinX, x);
        contentMinY = Math.min(contentMinY, y);
        contentMaxX = Math.max(contentMaxX, x);
        contentMaxY = Math.max(contentMaxY, y);
      }
      colors.add(`${red >> 4},${green >> 4},${blue >> 4},${alpha >> 6}`);
    }
  }
    let faceCrop;
    if (contentMaxX >= contentMinX && contentMaxY >= contentMinY) {
      const contentWidth = contentMaxX - contentMinX + 1;
      const contentHeight = contentMaxY - contentMinY + 1;
      const cropSize = focusedFace
        ? Math.max(160, Math.round(Math.min(width, height) * 0.78))
        : tightFace
        ? Math.max(96, Math.round(Math.min(width, height) * 0.17))
        : Math.max(48, Math.min(
            width,
            height,
            Math.round(Math.max(contentWidth * 0.32, contentHeight * 0.28)),
          ));
      const centerX = focusedFace || tightFace ? width * 0.5 : contentMinX + contentWidth * 0.5;
      const centerY = focusedFace ? height * 0.5 : tightFace ? height * 0.205 : contentMinY + contentHeight * 0.15;
      const cropX = Math.max(0, Math.min(width - cropSize, Math.round(centerX - cropSize * 0.5)));
      const cropY = Math.max(0, Math.min(height - cropSize, Math.round(centerY - cropSize * 0.5)));
      const crop = document.createElement("canvas");
      crop.width = 800;
      crop.height = 800;
      const cropContext = crop.getContext("2d");
      if (cropContext) {
        cropContext.imageSmoothingEnabled = false;
        cropContext.drawImage(analysis, cropX, cropY, cropSize, cropSize, 0, 0, 800, 800);
        faceCrop = {
          outputName,
          data: crop.toDataURL("image/png").slice("data:image/png;base64,".length),
          source: { x: cropX, y: cropY, size: cropSize },
        };
      }
    }
    return {
      available: true,
      width,
      height,
      samples,
      opaque,
      luminanceMin,
      luminanceMax,
      nonBackground,
      colorBuckets: colors.size,
      contentBounds: contentMaxX >= contentMinX
        ? { minX: contentMinX, minY: contentMinY, maxX: contentMaxX, maxY: contentMaxY }
        : null,
      faceCrop,
    };
  }, {
    source: screenshot.toString("base64"),
    outputName: `test-face-${outputSuffix}.png`,
    tightFace: mode === "solid" && cameraYawDrag !== 0,
    focusedFace: focusFace,
  });
};

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  const report = {
    mode,
    ...(mode === "solid" ? { faceDetail } : {}),
    consoleErrors: [],
    pageErrors: [],
    peakWorkingSetBytes: 0,
  };
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));

  let sampling = true;
  const memorySampler = (async () => {
    while (sampling) {
      const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
      const processIds = processInfo
        .map((process) => Number(process.id))
        .filter((processId) => Number.isInteger(processId) && processId > 0);
      const workingSet = await processWorkingSet(processIds);
      report.peakWorkingSetBytes = Math.max(report.peakWorkingSetBytes, workingSet);
      if (workingSet > 2 * 1024 ** 3) {
        throw new Error(`Process tree exceeded 2 GiB: ${workingSet} bytes`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();

  try {
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 120000 }).catch(() => undefined);
    await page.waitForFunction(
      () => document.querySelector("canvas") && document.body.innerText.includes("PMX"),
      null,
      { timeout: 120000 },
    );

    const targetHeight = page.locator(".slider-number input").first();
    await targetHeight.fill("320");
    await targetHeight.press("Enter");

    if (mode === "solid") {
      await page.locator('.mode-option[aria-pressed="false"]').click();
      const faceDetailSelect = page.locator(".field-row").filter({
        hasText: /面部细节|Facial detail|顔のディテール/,
      }).locator("select");
      await faceDetailSelect.selectOption(faceDetail);
    }
    await page.locator(".primary-button").click();

    const startedAt = Date.now();
    await page.locator(".progress-block").waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".progress-block").waitFor({ state: "hidden", timeout: 180000 });
    await page.locator(".export-button").waitFor({ state: "visible" });

    const exportEnabled = await page.locator(".export-button").isEnabled();
    report.elapsedMs = Date.now() - startedAt;
    report.exportEnabled = exportEnabled;
    report.summary = (await page.locator("body").innerText()).slice(-1800);
    report.canvasCount = await page.locator("canvas").count();
    if (mode === "solid") {
      const sidecar = await page.evaluate(({ detail }) => {
        const result = window.__melyProjectionResult;
        if (!result || result.kind !== "solid" || !result.faceFrame) return null;
        return {
          format: "MELYFaceProjectionSidecar",
          version: 1,
          coordinateSpace: "projection-result",
          faceDetail: detail,
          faceFrame: result.faceFrame,
          bounds: result.bounds,
          stats: result.stats,
        };
      }, { detail: faceDetail });
      if (!sidecar) throw new Error("Solid generation did not expose a faceFrame sidecar");
      const sidecarPath = `test-generation-${outputSuffix}.face.json`;
      await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
      report.faceSidecar = sidecarPath;
    }
    if (focusFace) {
      await page.getByRole("button", { name: /聚焦面部|Focus face|顔にフォーカス/ }).click();
      await page.waitForTimeout(650);
      report.focusFace = true;
    }
    if (cameraYawDrag !== 0) {
      const canvas = page.locator("canvas").first();
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Canvas bounds are unavailable for camera rotation");
      const startX = box.x + box.width * 0.5;
      const startY = box.y + box.height * 0.5;
      const clampedDrag = Math.max(-box.width * 0.42, Math.min(box.width * 0.42, cameraYawDrag));
      await page.mouse.move(startX, startY);
      await page.mouse.down({ button: "left" });
      await page.mouse.move(startX + clampedDrag, startY, { steps: 36 });
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(650);
      report.cameraYawDrag = clampedDrag;
    }
    const gridButton = page.getByRole("button", { name: /显示网格|Show grid|グリッド/ });
    if (await gridButton.evaluate((button) => button.classList.contains("icon-button--active"))) {
      await gridButton.click();
    }
    const boundsButton = page.getByRole("button", { name: /显示体素包围盒|Show voxel bounds|バウンディング/ });
    if (await boundsButton.evaluate((button) => button.classList.contains("icon-button--active"))) {
      await boundsButton.click();
    }
    await page.waitForTimeout(250);
    report.canvasPixels = await canvasPixelReport(page);
    if (report.canvasPixels.faceCrop) {
      await writeFile(
        report.canvasPixels.faceCrop.outputName,
        Buffer.from(report.canvasPixels.faceCrop.data, "base64"),
      );
      report.canvasPixels.faceCrop = {
        outputName: report.canvasPixels.faceCrop.outputName,
        source: report.canvasPixels.faceCrop.source,
      };
    }
    await page.screenshot({ path: `test-generation-${outputSuffix}.png`, fullPage: true });

    if (!exportEnabled) throw new Error(`${mode} generation did not complete in time`);
    if (
      !report.canvasPixels.available
      || report.canvasPixels.nonBackground < 100
      || report.canvasPixels.colorBuckets < 4
      || report.canvasPixels.luminanceMax - report.canvasPixels.luminanceMin < 8
    ) {
      throw new Error(`Canvas pixel check failed: ${JSON.stringify(report.canvasPixels)}`);
    }

    const downloadPromise = page.waitForEvent("download");
    await page.locator(".export-button").click();
    await page.getByRole("button", { name: /Litematica/ }).click();
    const download = await downloadPromise;
    const exportPath = `test-generation-${outputSuffix}.litematica`;
    await download.saveAs(exportPath);
    const bytes = await readFile(exportPath);
    const parsed = await nbt.parse(bytes, "big");
    const root = nbt.simplify(parsed.parsed);
    report.export = {
      bytes: bytes.byteLength,
      version: root.Version,
      dataVersion: root.MinecraftDataVersion,
      blocks: root.Metadata.TotalBlocks,
      regions: root.Metadata.RegionCount,
      dimensions: root.Metadata.EnclosingSize,
    };
  } finally {
    sampling = false;
    await memorySampler;
    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) await writeFile(reportPath, reportJson, "utf8");
    process.stdout.write(reportJson);
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
