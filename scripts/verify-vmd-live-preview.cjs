const { createHash } = require("node:crypto");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4218/";
const modelZip = resolve(process.env.MELY_MODEL_ZIP || "");
const motionZip = resolve(process.env.MELY_MOTION_ZIP || "");
const browserPath = process.env.MELY_BROWSER_PATH;
const playwrightPath = process.env.MELY_PLAYWRIGHT_MODULE || "playwright";
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY || join(projectRoot, "release-validation/vmd-live-preview"),
);
const reportPath = resolve(
  process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"),
);
const BACKENDS = ["vanilla", "moeru", "babylon"];
const TARGET_FRAMES = Object.freeze({
  vanilla: Object.freeze({ dance: 30, expression: 15 }),
  moeru: Object.freeze({ dance: 45, expression: 24 }),
  babylon: Object.freeze({ dance: 60, expression: 33 }),
});
const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|lavapipe|software rasterizer|reference rasterizer|microsoft basic render|basic render driver|\bwarp\b/i;
const D3D11_RENDERER_PATTERN = /direct3d11|d3d11/i;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const delay = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));

const canvasPixels = async (page, screenshot) => page.evaluate(async (source) => {
  const image = new Image();
  image.src = `data:image/png;base64,${source}`;
  await image.decode();
  const sample = document.createElement("canvas");
  sample.width = 160;
  sample.height = 160;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D sampling is unavailable");
  context.drawImage(image, 0, 0, sample.width, sample.height);
  return [...context.getImageData(0, 0, sample.width, sample.height).data];
}, screenshot.toString("base64"));

const canvasDifference = (left, right) => {
  let changedPixels = 0;
  let channelDelta = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const delta = Math.abs(left[offset] - right[offset])
      + Math.abs(left[offset + 1] - right[offset + 1])
      + Math.abs(left[offset + 2] - right[offset + 2]);
    channelDelta += delta;
    if (delta >= 18) changedPixels += 1;
  }
  const pixelCount = left.length / 4;
  return {
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteRgbError: channelDelta / (pixelCount * 3),
  };
};

const captureCanvas = async (page, name) => {
  await page.evaluate(() => new Promise((resolve_) => requestAnimationFrame(() => resolve_())));
  const canvas = page.locator(".viewport-canvas canvas");
  const screenshot = await canvas.screenshot({ type: "png" });
  const path = join(outputDirectory, `${name}.png`);
  await writeFile(path, screenshot);
  return {
    path,
    sha256: sha256(screenshot),
    pixels: await canvasPixels(page, screenshot),
  };
};

const readWebGlDiagnostics = async (page) => page.evaluate(() => {
  const canvas = document.querySelector(".viewport-canvas canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Viewport canvas is unavailable");
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
  if (!gl) throw new Error("WebGL context is unavailable");
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    context: gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl",
    drawingBufferWidth: gl.drawingBufferWidth,
    drawingBufferHeight: gl.drawingBufferHeight,
    vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
});

const trackPanel = (page, kind) => page.locator(`.viewport-motion--${kind}`);
const trackInput = (page, kind) => trackPanel(page, kind).getByRole("spinbutton", {
  name: `Jump to ${kind === "dance" ? "Dance" : "Expression"} track frame`,
  exact: true,
});

const readTrackFrames = async (page) => ({
  dance: Number(await trackInput(page, "dance").inputValue()),
  expression: Number(await trackInput(page, "expression").inputValue()),
});

const armRenderedFrames = async (page, expected, timeoutMs = 15_000) => {
  await page.evaluate(({ frames, timeout }) => {
    window.__MELY_E2E_FRAME_WAIT__?.cancel?.();
    window.__MELY_E2E_GPU_PROBE__ = true;
    const wait = { status: "pending", detail: null, error: null, cancel: null };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("mely:vmd-frame-rendered", listener);
      window.__MELY_E2E_GPU_PROBE__ = false;
    };
    const listener = (event) => {
      const detail = event.detail;
      if (
        !detail?.frames
        || Math.abs(detail.frames.dance - frames.dance) > 0.01
        || Math.abs(detail.frames.expression - frames.expression) > 0.01
      ) return;
      cleanup();
      wait.status = "complete";
      wait.detail = detail;
    };
    const timer = window.setTimeout(() => {
      cleanup();
      wait.status = "error";
      wait.error = `Timed out waiting for rendered frames ${JSON.stringify(frames)}`;
    }, timeout);
    wait.cancel = () => {
      cleanup();
      wait.status = "error";
      wait.error = "Frame wait was replaced";
    };
    window.addEventListener("mely:vmd-frame-rendered", listener);
    window.__MELY_E2E_FRAME_WAIT__ = wait;
  }, { frames: expected, timeout: timeoutMs });
};

const collectRenderedFrames = async (page, timeoutMs = 16_000) => {
  await page.waitForFunction(() => window.__MELY_E2E_FRAME_WAIT__?.status !== "pending", undefined, {
    timeout: timeoutMs,
  });
  return page.evaluate(() => {
    const wait = window.__MELY_E2E_FRAME_WAIT__;
    delete window.__MELY_E2E_FRAME_WAIT__;
    if (!wait || wait.status !== "complete") throw new Error(wait?.error || "Frame wait failed");
    return wait.detail;
  });
};

const enterTrackFrame = async (page, kind, frame, expectedFrames) => {
  const input = trackInput(page, kind);
  await armRenderedFrames(page, expectedFrames);
  await input.fill(String(frame));
  await input.press("Enter");
  const rendered = await collectRenderedFrames(page);
  await page.waitForFunction(({ dance, expression }) => {
    const read = (kind) => Number(document.querySelector(
      `.viewport-motion--${kind} input[type="number"]`,
    )?.value);
    return read("dance") === dance && read("expression") === expression;
  }, expectedFrames);
  return rendered;
};

const lockButton = (page, kind, locked) => trackPanel(page, kind).getByRole("button", {
  name: `${locked ? "Unlock" : "Lock"} ${kind === "dance" ? "Dance" : "Expression"} track`,
  exact: true,
});

const switchRenderer = async (page, backend) => {
  const select = page.getByRole("combobox", { name: "MMD renderer", exact: true });
  if (await select.inputValue() !== backend) {
    await page.evaluate(() => { window.__MELY_E2E_CURRENT_BACKEND__ = null; });
    await select.selectOption(backend);
  }
  await page.waitForFunction((expected) => {
    const renderer = document.querySelector('select[aria-label="MMD renderer"]');
    return renderer?.value === expected
      && !renderer.disabled
      && window.__MELY_E2E_CURRENT_BACKEND__?.backend === expected
      && document.querySelector(".viewport-canvas canvas");
  }, backend, { timeout: 180_000 });
};

const exerciseRenderer = async (page, backend, previousFrames) => {
  await switchRenderer(page, backend);
  const restoredFrames = await readTrackFrames(page);
  const restoredLocks = {
    dance: await lockButton(page, "dance", true).count() === 1,
    expression: await lockButton(page, "expression", true).count() === 1,
  };
  const target = TARGET_FRAMES[backend];
  const expectedAfterDance = { dance: target.dance, expression: restoredFrames.expression };
  const danceRender = await enterTrackFrame(page, "dance", target.dance, expectedAfterDance);
  const expressionLockPreserved = previousFrames === null
    ? true
    : await lockButton(page, "expression", true).count() === 1;
  const danceUnlockedAlone = await lockButton(page, "dance", false).count() === 1;
  const expressionRender = await enterTrackFrame(page, "expression", target.expression, target);
  const appliedFrames = await readTrackFrames(page);

  await lockButton(page, "dance", false).click();
  await lockButton(page, "expression", false).click();
  const lockedAfterInput = {
    dance: await lockButton(page, "dance", true).count() === 1,
    expression: await lockButton(page, "expression", true).count() === 1,
  };

  const canvas = page.locator(".viewport-canvas canvas");
  const webgl = await readWebGlDiagnostics(page);
  const rendererIdentity = `${webgl.vendor} ${webgl.renderer}`;
  const hardwareGpu = !SOFTWARE_RENDERER_PATTERN.test(rendererIdentity)
    && D3D11_RENDERER_PATTERN.test(rendererIdentity);
  const screenshot = await canvas.screenshot({ type: "png" });
  const screenshotPath = join(outputDirectory, `${backend}-D${target.dance}-E${target.expression}.png`);
  await writeFile(screenshotPath, screenshot);

  const assertions = {
    restoredPreviousFrames: previousFrames === null || (
      restoredFrames.dance === previousFrames.dance
      && restoredFrames.expression === previousFrames.expression
    ),
    restoredPreviousLocks: previousFrames === null || (restoredLocks.dance && restoredLocks.expression),
    danceInputPreservedExpression: Math.abs(danceRender.frames.dance - target.dance) <= 0.01
      && Math.abs(danceRender.frames.expression - restoredFrames.expression) <= 0.01,
    expressionInputPreservedDance: Math.abs(expressionRender.frames.dance - target.dance) <= 0.01
      && Math.abs(expressionRender.frames.expression - target.expression) <= 0.01,
    gpuSynchronized: danceRender.gpuSynchronized === true
      && expressionRender.gpuSynchronized === true,
    editingLockedDanceUnlockedOnlyDance: previousFrames === null
      || (danceUnlockedAlone && expressionLockPreserved),
    appliedIndependentFrames: appliedFrames.dance === target.dance
      && appliedFrames.expression === target.expression,
    relockedBothTracks: lockedAfterInput.dance && lockedAfterInput.expression,
    hardwareGpu,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error(`${backend} dual-track assertions failed: ${JSON.stringify(assertions)}`);
  }
  return {
    backend,
    target,
    restoredFrames,
    restoredLocks,
    appliedFrames,
    danceRender,
    expressionRender,
    webgl,
    screenshot: { path: screenshotPath, sha256: sha256(screenshot) },
    assertions,
  };
};

const main = async () => {
  const { chromium } = require(playwrightPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    modelZip,
    motionZip,
    appUrl,
    consoleErrors: [],
    pageErrors: [],
    renderers: [],
    assertions: {},
    passed: false,
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
    args: ["--enable-gpu", "--disable-software-rasterizer", "--use-angle=d3d11"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(180_000);
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message));

    await page.addInitScript(() => {
      window.__MELY_E2E_MATERIAL_SELECTION_PROBE__ = true;
      window.__MELY_E2E_CURRENT_BACKEND__ = null;
      window.addEventListener("mely:material-selection-state", (event) => {
        window.__MELY_E2E_CURRENT_BACKEND__ = event.detail;
      });
    });
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    const input = page.locator('input[type="file"][accept*=".pmx"]');
    await input.setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 });
    await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });

    await input.setInputFiles(motionZip);
    const timelinePanels = page.locator(".viewport-motion");
    await timelinePanels.first().waitFor({ state: "visible", timeout: 180_000 });
    if (await timelinePanels.count() !== 2) {
      throw new Error("The real VMD package must load both Dance and Expression tracks");
    }
    await trackInput(page, "dance").waitFor({ state: "visible" });
    await trackInput(page, "expression").waitFor({ state: "visible" });
    const canvas = page.locator(".viewport-canvas canvas");
    const panel = page.locator(".viewport-panel");
    report.browser = {
      version: await browser.version(),
    };

    report.motion = {
      dance: {
        selectedName: await trackPanel(page, "dance").locator(".viewport-motion__identity strong").innerText(),
        frameMaximum: Number(await trackInput(page, "dance").getAttribute("max")),
        matchText: await trackPanel(page, "dance").locator(".viewport-motion__meta").innerText(),
      },
      expression: {
        selectedName: await trackPanel(page, "expression").locator(".viewport-motion__identity strong").innerText(),
        frameMaximum: Number(await trackInput(page, "expression").getAttribute("max")),
        matchText: await trackPanel(page, "expression").locator(".viewport-motion__meta").innerText(),
      },
    };
    const [timelineBounds, canvasBounds, panelBounds] = await Promise.all([
      timelinePanels.first().boundingBox(),
      canvas.boundingBox(),
      panel.boundingBox(),
    ]);
    report.layout = { timelineBounds, canvasBounds, panelBounds };

    let previousFrames = null;
    for (const backend of BACKENDS) {
      const result = await exerciseRenderer(page, backend, previousFrames);
      report.renderers.push(result);
      previousFrames = result.appliedFrames;
    }

    await panel.screenshot({ path: join(outputDirectory, "viewport-with-bottom-timeline.png") });
    report.assertions = {
      selectedBodyMotion: report.motion.dance.selectedName.includes("动作"),
      selectedExpressionMotion: report.motion.expression.selectedName.includes("表情"),
      expectedRealFrameRanges: report.motion.dance.frameMaximum >= 60
        && report.motion.expression.frameMaximum >= 33,
      matchedBodyTracks: /Bones\s+[1-9]\d*\s*\/\s*[1-9]\d*/.test(report.motion.dance.matchText),
      matchedExpressionTracks: /Morphs\s+[1-9]\d*\s*\/\s*[1-9]\d*/.test(report.motion.expression.matchText),
      timelineBelowCanvas: Boolean(
        timelineBounds && canvasBounds
        && timelineBounds.y >= canvasBounds.y + canvasBounds.height - 2
      ),
      timelineInsideViewport: Boolean(
        timelineBounds && panelBounds
        && timelineBounds.x >= panelBounds.x
        && timelineBounds.x + timelineBounds.width <= panelBounds.x + panelBounds.width
      ),
      allRenderersExecuted: report.renderers.length === BACKENDS.length,
      allRenderersPassed: report.renderers.every((entry) => (
        Object.values(entry.assertions).every(Boolean)
      )),
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
    };
    report.passed = Object.values(report.assertions).every(Boolean);
    if (!report.passed) {
      throw new Error(`VMD live-preview assertions failed: ${JSON.stringify(report.assertions)}`);
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await browser.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
