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

const measureTimelineScrub = async (page, targetFrame) => {
  const roundTripStartedAt = Date.now();
  const application = await page.evaluate(async ({ frame, timeoutMs }) => {
    const timeline = document.querySelector('input[aria-label="Motion frame"]');
    const output = timeline?.closest(".viewport-motion__scrubber")?.querySelector("output");
    if (!(timeline instanceof HTMLInputElement) || !(output instanceof HTMLOutputElement)) {
      throw new Error("Motion timeline controls are unavailable");
    }
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("Native range value setter is unavailable");

    window.__MELY_E2E_GPU_PROBE__ = true;
    const initialOutput = output.textContent;
    const startedAt = performance.now();
    let mutationAt = null;
    let renderedDetail = null;
    let timeout = 0;

    const committed = () => (
      Number(timeline.value) === frame
      && output.textContent !== initialOutput
    );

    const result = await new Promise((resolve_, reject) => {
      let dispatchReturnedAt = startedAt;
      const maybeFinish = () => {
        if (!renderedDetail || mutationAt === null || !committed()) return;
        finish({
          eventDispatchDurationMs: dispatchReturnedAt - startedAt,
          gpuCompletionLatencyMs: renderedDetail.renderedAt - startedAt,
          gpuSynchronized: renderedDetail.gpuSynchronized === true,
          uiCommitLatencyMs: mutationAt - startedAt,
          renderedFrame: renderedDetail.frame,
          appliedFrame: Number(timeline.value),
          outputText: output.textContent,
        });
      };
      const observer = new MutationObserver(() => {
        if (mutationAt === null && committed()) mutationAt = performance.now();
        maybeFinish();
      });
      const finish = (value) => {
        observer.disconnect();
        window.removeEventListener("mely:vmd-frame-rendered", onRendered);
        clearTimeout(timeout);
        window.__MELY_E2E_GPU_PROBE__ = false;
        resolve_(value);
      };
      observer.observe(output, { childList: true, characterData: true, subtree: true });
      timeout = window.setTimeout(() => {
        observer.disconnect();
        window.removeEventListener("mely:vmd-frame-rendered", onRendered);
        window.__MELY_E2E_GPU_PROBE__ = false;
        reject(new Error(`Motion scrub did not render frame ${frame} within ${timeoutMs} ms`));
      }, timeoutMs);

      const onRendered = (event) => {
        const detail = event.detail;
        if (!detail || Math.abs(detail.frame - frame) > 0.01) return;
        renderedDetail = detail;
        maybeFinish();
      };
      window.addEventListener("mely:vmd-frame-rendered", onRendered);

      valueSetter.call(timeline, String(frame));
      timeline.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      dispatchReturnedAt = performance.now();
    });
    return result;
  }, { frame: targetFrame, timeoutMs: 5_000 });

  return {
    measurementMethod: "in-page-input-to-webgl-finish",
    playwrightActionabilityIncluded: false,
    playwrightEvaluateRoundTripMs: Date.now() - roundTripStartedAt,
    ...application,
  };
};

const measurePlaybackStart = async (page, initialFrame) => {
  const playButton = page.getByRole("button", { name: "Play motion", exact: true });
  const actionabilityStartedAt = Date.now();
  await playButton.click({ trial: true });
  const playwrightActionabilityProbeMs = Date.now() - actionabilityStartedAt;

  const roundTripStartedAt = Date.now();
  const application = await page.evaluate(async ({ frame, timeoutMs }) => {
    const timeline = document.querySelector('input[aria-label="Motion frame"]');
    const panel = timeline?.closest(".viewport-motion");
    const button = panel?.querySelector('button[aria-label="Play motion"]');
    if (
      !(timeline instanceof HTMLInputElement)
      || !(panel instanceof HTMLElement)
      || !(button instanceof HTMLButtonElement)
    ) {
      throw new Error("Motion playback controls are unavailable");
    }

    window.__MELY_E2E_GPU_PROBE__ = true;
    const startedAt = performance.now();
    let mutationAt = null;
    let advancedFrame = null;
    let timeout = 0;

    const readAdvance = () => {
      const current = Number(timeline.value);
      if (Number.isFinite(current) && current > frame) {
        if (advancedFrame === null) advancedFrame = current;
        return true;
      }
      return false;
    };

    const result = await new Promise((resolve_, reject) => {
      let clickReturnedAt = startedAt;
      const observer = new MutationObserver(() => {
        if (mutationAt === null && readAdvance()) mutationAt = performance.now();
      });
      const finish = (value) => {
        observer.disconnect();
        window.removeEventListener("mely:vmd-frame-rendered", onRendered);
        clearTimeout(timeout);
        window.__MELY_E2E_GPU_PROBE__ = false;
        resolve_(value);
      };
      observer.observe(panel, {
        attributes: true,
        attributeFilter: ["aria-label", "aria-pressed", "value"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      timeout = window.setTimeout(() => {
        observer.disconnect();
        window.removeEventListener("mely:vmd-frame-rendered", onRendered);
        window.__MELY_E2E_GPU_PROBE__ = false;
        reject(new Error(`Motion playback did not advance within ${timeoutMs} ms`));
      }, timeoutMs);

      const onRendered = (event) => {
        const detail = event.detail;
        if (!detail || detail.frame <= frame) return;
        readAdvance();
        finish({
          nativeClickDispatchDurationMs: clickReturnedAt - startedAt,
          gpuCompletionLatencyMs: detail.renderedAt - startedAt,
          gpuSynchronized: detail.gpuSynchronized === true,
          firstUiAdvanceLatencyMs: mutationAt === null ? null : mutationAt - startedAt,
          firstAdvancedFrame: advancedFrame ?? detail.frame,
        });
      };
      window.addEventListener("mely:vmd-frame-rendered", onRendered);

      button.click();
      clickReturnedAt = performance.now();
    });
    return result;
  }, { frame: initialFrame, timeoutMs: 5_000 });

  return {
    measurementMethod: "in-page-click-to-webgl-finish",
    playwrightActionabilityIncluded: false,
    playwrightActionabilityProbeMs,
    playwrightEvaluateRoundTripMs: Date.now() - roundTripStartedAt,
    ...application,
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
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.setDefaultTimeout(180_000);
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message));

    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    const input = page.locator('input[type="file"][accept*=".pmx"]');
    await input.setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 });
    await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });

    await input.setInputFiles(motionZip);
    const timelinePanel = page.locator(".viewport-motion");
    await timelinePanel.waitFor({ state: "visible", timeout: 180_000 });
    const timeline = page.getByRole("slider", { name: "Motion frame" });
    const canvas = page.locator(".viewport-canvas canvas");
    const panel = page.locator(".viewport-panel");
    report.browser = {
      version: await browser.version(),
      webgl: await readWebGlDiagnostics(page),
    };

    report.motion = {
      selectedName: await page.locator(".viewport-motion__identity strong").innerText(),
      frameMaximum: Number(await timeline.getAttribute("max")),
      matchText: await page.locator(".viewport-motion__meta").innerText(),
    };
    const [timelineBounds, canvasBounds, panelBounds] = await Promise.all([
      timelinePanel.boundingBox(),
      canvas.boundingBox(),
      panel.boundingBox(),
    ]);
    report.layout = { timelineBounds, canvasBounds, panelBounds };

    report.scrub = await measureTimelineScrub(page, 100);
    const before = await captureCanvas(page, "frame-100-before-play");

    report.playback = await measurePlaybackStart(page, 100);
    await delay(350);
    await page.getByRole("button", { name: "Pause motion", exact: true }).click();
    const pausedFrame = Number(await timeline.inputValue());
    const after = await captureCanvas(page, "after-live-playback");
    await delay(180);
    const stableFrame = Number(await timeline.inputValue());
    report.playback.pausedFrame = pausedFrame;
    report.playback.stableFrame = stableFrame;
    report.playback.canvasDifference = canvasDifference(before.pixels, after.pixels);

    await panel.screenshot({ path: join(outputDirectory, "viewport-with-bottom-timeline.png") });
    report.assertions = {
      selectedBodyMotion: report.motion.selectedName.includes("动作"),
      expectedRealFrameRange: report.motion.frameMaximum === 629,
      matchedAllBodyTracks: /Bones\s+57\s*\/\s*57/.test(report.motion.matchText),
      timelineBelowCanvas: Boolean(
        timelineBounds && canvasBounds
        && timelineBounds.y >= canvasBounds.y + canvasBounds.height - 2
      ),
      timelineInsideViewport: Boolean(
        timelineBounds && panelBounds
        && timelineBounds.x >= panelBounds.x
        && timelineBounds.x + timelineBounds.width <= panelBounds.x + panelBounds.width
      ),
      scrubAppliedRequestedFrame: report.scrub.appliedFrame === 100
        && Math.abs(report.scrub.renderedFrame - 100) <= 0.01,
      scrubGpuCompletionResponsive: report.scrub.gpuCompletionLatencyMs <= 100,
      scrubGpuSynchronized: report.scrub.gpuSynchronized,
      firstPlaybackGpuCompletionResponsive: report.playback.gpuCompletionLatencyMs <= 100,
      firstPlaybackGpuSynchronized: report.playback.gpuSynchronized,
      frameAdvanced: pausedFrame > 100,
      canvasChangedDuringPlayback: report.playback.canvasDifference.changedPixelRatio >= 0.001,
      pauseStable: stableFrame === pausedFrame,
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
    };
    if (!Object.values(report.assertions).every(Boolean)) {
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
