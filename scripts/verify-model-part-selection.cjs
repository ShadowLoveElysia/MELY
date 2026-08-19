const { createHash } = require("node:crypto");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");
const {
  MODEL_PART_SELECTION_PROFILE,
} = require("./fixtures/generate-minimal-pmd.cjs");

const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4221/";
const modelPath = resolve(process.env.MELY_MODEL_PATH || "");
const browserPath = process.env.MELY_BROWSER_PATH;
const playwrightPath = process.env.MELY_PLAYWRIGHT_MODULE || "playwright";
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY
    || join(projectRoot, "release-validation/model-part-selection"),
);
const reportPath = resolve(
  process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"),
);

const BACKENDS = ["vanilla", "moeru", "babylon"];
const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|lavapipe|software rasterizer|reference rasterizer|microsoft basic render|basic render driver|\bwarp\b/i;
const D3D11_RENDERER_PATTERN = /direct3d11|d3d11/i;
const STABLE_PIXEL_RATIO = 0.01;
const PRESERVED_PIXEL_RATIO = 0.025;
const TARGET_MATERIAL = MODEL_PART_SELECTION_PROFILE.targetMaterialIndex;
const PRESERVED_MATERIAL = MODEL_PART_SELECTION_PROFILE.preservedMaterialIndex;
const TARGET_ROI = MODEL_PART_SELECTION_PROFILE.clickRois[TARGET_MATERIAL];
const TARGET_VALIDATION_ROI = MODEL_PART_SELECTION_PROFILE.validationRois.target;
const TARGET_INTERIOR_ROI = MODEL_PART_SELECTION_PROFILE.validationRois.targetInterior;
const PRESERVED_ROI = MODEL_PART_SELECTION_PROFILE.validationRois.preserved;
const EMPTY_ROI = Object.freeze({ xMin: 0.8, xMax: 0.84, yMin: 0.46, yMax: 0.54 });

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const delay = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));

const difference = (left, right) => {
  if (left.length !== right.length) throw new Error("Pixel samples have different dimensions");
  let changedPixels = 0;
  let channelDelta = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    const delta = Math.abs(left[offset] - right[offset])
      + Math.abs(left[offset + 1] - right[offset + 1])
      + Math.abs(left[offset + 2] - right[offset + 2]);
    channelDelta += delta;
    if (delta >= 18) changedPixels += 1;
  }
  const pixelCount = Math.max(1, left.length / 4);
  return {
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteRgbError: channelDelta / (pixelCount * 3),
  };
};

const captureCanvas = async (page, canvas, backend, state) => {
  await page.evaluate(() => new Promise((resolve_) => requestAnimationFrame(() => (
    requestAnimationFrame(resolve_)
  ))));
  await canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Viewport canvas is unavailable");
    const gl = element.getContext("webgl2") || element.getContext("webgl");
    if (!gl) throw new Error("WebGL context is unavailable while capturing the viewport");
    gl.finish();
  });
  const screenshot = await canvas.screenshot({ type: "png" });
  const path = join(outputDirectory, `${backend}-${state}.png`);
  await writeFile(path, screenshot);
  const samples = await page.evaluate(async ({ source, rois }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();
    const sample = document.createElement("canvas");
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D sampling is unavailable");
    context.drawImage(image, 0, 0);
    const read = (roi) => {
      const x = Math.max(0, Math.floor(roi.xMin * sample.width));
      const y = Math.max(0, Math.floor(roi.yMin * sample.height));
      const width = Math.max(1, Math.ceil((roi.xMax - roi.xMin) * sample.width));
      const height = Math.max(1, Math.ceil((roi.yMax - roi.yMin) * sample.height));
      return [...context.getImageData(x, y, width, height).data];
    };
    return Object.fromEntries(Object.entries(rois).map(([name, roi]) => [name, read(roi)]));
  }, {
    source: screenshot.toString("base64"),
    rois: {
      target: TARGET_VALIDATION_ROI,
      targetInterior: TARGET_INTERIOR_ROI,
      preserved: PRESERVED_ROI,
    },
  });
  return { path, sha256: sha256(screenshot), samples };
};

const readWebGlDiagnostics = async (page, canvas) => {
  const diagnostics = await canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Viewport canvas is unavailable");
    const gl = element.getContext("webgl2") || element.getContext("webgl");
    if (!gl) throw new Error("WebGL context is unavailable");
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      context: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
        ? "webgl2"
        : "webgl",
      drawingBufferWidth: gl.drawingBufferWidth,
      drawingBufferHeight: gl.drawingBufferHeight,
      vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: extension
        ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      unmaskedRendererInfo: Boolean(extension),
    };
  });
  const rendererIdentity = `${diagnostics.vendor} ${diagnostics.renderer}`;
  if (!diagnostics.unmaskedRendererInfo) {
    throw new Error("WEBGL_debug_renderer_info is required for fail-closed GPU validation");
  }
  if (SOFTWARE_RENDERER_PATTERN.test(rendererIdentity)) {
    throw new Error(`Software WebGL renderer is not accepted: ${rendererIdentity}`);
  }
  if (!D3D11_RENDERER_PATTERN.test(rendererIdentity)) {
    throw new Error(`ANGLE D3D11 hardware rendering is required: ${rendererIdentity}`);
  }
  if (!diagnostics.drawingBufferWidth || !diagnostics.drawingBufferHeight) {
    throw new Error("WebGL drawing buffer has invalid dimensions");
  }
  return diagnostics;
};

const waitForModel = async (page) => {
  await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 });
  await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });
  await page.locator(".viewport-canvas canvas").waitFor({ state: "visible", timeout: 180_000 });
};

const armSelectionState = async (page, expected, timeoutMs = 30_000) => {
  await page.evaluate(({ expectedState, timeout }) => {
    if (!window.__MELY_E2E_MATERIAL_SELECTION_PROBE__) {
      throw new Error("Material-selection probe flag is not enabled");
    }
    window.__MELY_E2E_MATERIAL_SELECTION_WAIT__?.cancel?.();
    const wait = {
      status: "pending",
      detail: null,
      error: null,
      cancel: null,
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("mely:material-selection-state", listener);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      wait.status = "error";
      wait.error = `Timed out waiting for material-selection state ${JSON.stringify(expectedState)}`;
    }, timeout);
    const listener = (event) => {
      const detail = event.detail;
      if (!detail || typeof detail !== "object") return;
      const matches = Object.entries(expectedState).every(([key, value]) => {
        if (key === "hiddenMaterialIndices") {
          return Array.isArray(detail[key])
            && JSON.stringify([...detail[key]].sort((left, right) => left - right))
              === JSON.stringify([...value].sort((left, right) => left - right));
        }
        return detail[key] === value;
      });
      if (!matches) return;
      cleanup();
      if (typeof detail.backend !== "string"
        || typeof detail.modelId !== "string"
        || !Object.hasOwn(detail, "pickedMaterialIndex")
        || (detail.pickedMaterialIndex !== null && typeof detail.pickedMaterialIndex !== "number")
        || !Array.isArray(detail.hiddenMaterialIndices)
        || typeof detail.outlineTargetCount !== "number") {
        wait.status = "error";
        wait.error = `Material-selection probe omitted required fields: ${JSON.stringify(detail)}`;
        return;
      }
      wait.status = "complete";
      wait.detail = detail;
    };
    wait.cancel = () => {
      cleanup();
      wait.status = "error";
      wait.error = "Material-selection wait was replaced";
    };
    window.addEventListener("mely:material-selection-state", listener);
    window.__MELY_E2E_MATERIAL_SELECTION_WAIT__ = wait;
  }, { expectedState: expected, timeout: timeoutMs });
};

const collectSelectionState = async (page, timeoutMs = 31_000) => {
  await page.waitForFunction(() => (
    window.__MELY_E2E_MATERIAL_SELECTION_WAIT__?.status !== "pending"
  ), undefined, { timeout: timeoutMs });
  return page.evaluate(() => {
    const waiter = window.__MELY_E2E_MATERIAL_SELECTION_WAIT__;
    delete window.__MELY_E2E_MATERIAL_SELECTION_WAIT__;
    if (!waiter) throw new Error("Material-selection wait was not armed");
    if (waiter.status !== "complete") throw new Error(waiter.error || "Selection probe failed");
    return waiter.detail;
  });
};

const canvasPoint = async (canvas, roi) => {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Viewport canvas has no layout bounds");
  return {
    x: bounds.x + bounds.width * ((roi.xMin + roi.xMax) / 2),
    y: bounds.y + bounds.height * ((roi.yMin + roi.yMax) / 2),
  };
};

const startSelectionEventCapture = async (page) => {
  await page.evaluate(() => {
    window.__MELY_E2E_MATERIAL_SELECTION_CAPTURE__?.stop?.();
    const events = [];
    const listener = (event) => events.push(event.detail);
    const capture = {
      events,
      stop: () => window.removeEventListener("mely:material-selection-state", listener),
    };
    window.addEventListener("mely:material-selection-state", listener);
    window.__MELY_E2E_MATERIAL_SELECTION_CAPTURE__ = capture;
  });
};

const stopSelectionEventCapture = async (page, backend, modelId) => page.evaluate((expected) => {
  const capture = window.__MELY_E2E_MATERIAL_SELECTION_CAPTURE__;
  delete window.__MELY_E2E_MATERIAL_SELECTION_CAPTURE__;
  if (!capture) throw new Error("Material-selection event capture was not started");
  capture.stop();
  return capture.events.filter((detail) => (
    detail?.backend === expected.backend && detail?.modelId === expected.modelId
  ));
}, { backend, modelId });

const applyFrontView = async (page, backend) => {
  await page.evaluate((expectedBackend) => new Promise((resolve_, reject) => {
    let retry = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(retry);
      window.removeEventListener("mely:e2e-view-applied", listener);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out applying front view for ${expectedBackend}`));
    }, 15_000);
    const listener = (event) => {
      if (event.detail?.backend !== expectedBackend || event.detail?.view !== "front") return;
      cleanup();
      resolve_(event.detail);
    };
    const dispatch = () => {
      window.dispatchEvent(new CustomEvent("mely:e2e-set-view", { detail: { view: "front" } }));
    };
    window.addEventListener("mely:e2e-view-applied", listener);
    retry = window.setInterval(dispatch, 100);
    dispatch();
  }), backend);
};

const hideBoundsOverlay = async (page) => {
  const button = page.getByRole("button", { name: "Show voxel bounds", exact: true });
  await button.waitFor({ state: "visible" });
  if (await button.evaluate((element) => element.classList.contains("icon-button--active"))) {
    await button.click();
  }
};

const exerciseBackend = async (page, backend) => {
  const rendererSelect = page.getByRole("combobox", { name: "MMD renderer", exact: true });
  let switchedState = null;
  if (await rendererSelect.inputValue() !== backend) {
    // 切换前先监听目标后端；仅等待 select 值会误把异步卸载期间的旧 canvas 当成新后端。
    await armSelectionState(page, { backend }, 180_000);
    await rendererSelect.selectOption(backend);
    switchedState = await collectSelectionState(page, 181_000);
    await page.waitForFunction((value) => {
      const select = document.querySelector('select[aria-label="MMD renderer"]');
      return select?.value === value && !select.disabled;
    }, backend, { timeout: 180_000 });
  }
  if (switchedState && (
    switchedState.selectedMaterialIndex !== TARGET_MATERIAL
    || switchedState.outlineTargetCount !== 1
  )) {
    throw new Error(`${backend}: renderer switch did not restore the selected material`);
  }
  const canvas = page.locator(".viewport-canvas canvas");
  await canvas.waitFor({ state: "visible", timeout: 180_000 });
  await hideBoundsOverlay(page);
  await applyFrontView(page, backend);
  await delay(250);

  const targetPoint = await canvasPoint(canvas, TARGET_ROI);
  const emptyPoint = await canvasPoint(canvas, EMPTY_ROI);
  await armSelectionState(page, {
    backend,
    ...(switchedState ? { modelId: switchedState.modelId } : {}),
    selectedMaterialIndex: TARGET_MATERIAL,
    pickedMaterialIndex: TARGET_MATERIAL,
    hiddenMaterialIndices: [],
    outlineTargetCount: 1,
  });
  await page.mouse.click(targetPoint.x, targetPoint.y, { button: "left" });
  const primeState = await collectSelectionState(page);
  const modelId = primeState.modelId;

  await armSelectionState(page, {
    backend,
    modelId,
    selectedMaterialIndex: null,
    pickedMaterialIndex: null,
    hiddenMaterialIndices: [],
    outlineTargetCount: 0,
  });
  await page.mouse.click(emptyPoint.x, emptyPoint.y, { button: "left" });
  const baselineState = await collectSelectionState(page);
  const webgl = await readWebGlDiagnostics(page, canvas);
  const baseline = await captureCanvas(page, canvas, backend, "baseline");

  await armSelectionState(page, {
    backend,
    modelId,
    selectedMaterialIndex: TARGET_MATERIAL,
    pickedMaterialIndex: TARGET_MATERIAL,
    hiddenMaterialIndices: [],
    outlineTargetCount: 1,
  });
  await page.mouse.click(targetPoint.x, targetPoint.y, { button: "left" });
  const selectedState = await collectSelectionState(page);
  const selected = await captureCanvas(page, canvas, backend, "selected");

  const selectedRow = page.locator(
    `[data-material-index="${TARGET_MATERIAL}"][aria-current="true"]`,
  );
  await selectedRow.waitFor({ state: "visible", timeout: 30_000 });
  const checkbox = selectedRow.locator('input[type="checkbox"]');
  if (!await checkbox.isChecked()) throw new Error(`${backend}: target material started hidden`);

  await checkbox.evaluate((element) => element.blur());
  await armSelectionState(page, {
    backend,
    modelId,
    selectedMaterialIndex: TARGET_MATERIAL,
    pickedMaterialIndex: TARGET_MATERIAL,
    hiddenMaterialIndices: [],
    outlineTargetCount: 1,
  });
  await page.mouse.click(targetPoint.x, targetPoint.y, { button: "left" });
  const repeatedState = await collectSelectionState(page);
  const repeatedClickFocusedMaterial = await checkbox.evaluate((element) => (
    document.activeElement === element
  ));
  const repeated = await captureCanvas(page, canvas, backend, "selected-repeated");

  await armSelectionState(page, {
    backend,
    modelId,
    selectedMaterialIndex: TARGET_MATERIAL,
    pickedMaterialIndex: null,
    hiddenMaterialIndices: [TARGET_MATERIAL],
    outlineTargetCount: 0,
  });
  await checkbox.click();
  const hiddenState = await collectSelectionState(page);
  const hidden = await captureCanvas(page, canvas, backend, "hidden");

  await armSelectionState(page, {
    backend,
    modelId,
    selectedMaterialIndex: TARGET_MATERIAL,
    pickedMaterialIndex: null,
    hiddenMaterialIndices: [],
    outlineTargetCount: 1,
  });
  await checkbox.click();
  const restoredState = await collectSelectionState(page);
  const restored = await captureCanvas(page, canvas, backend, "restored");

  // 像素采集后再验证拖拽，避免 OrbitControls 阻尼污染材质隔离对比。
  await startSelectionEventCapture(page);
  const dragStart = { x: targetPoint.x - 18, y: targetPoint.y };
  const dragEnd = { x: targetPoint.x + 18, y: targetPoint.y + 8 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
  await page.mouse.up({ button: "left" });
  await delay(180);
  const dragSelectionEvents = await stopSelectionEventCapture(page, backend, modelId);
  const selectionStayedAfterDrag = await page.locator(
    `[data-material-index="${TARGET_MATERIAL}"][aria-current="true"]`,
  ).count() === 1;

  const pixelDifferences = {
    selectedTarget: difference(baseline.samples.target, selected.samples.target),
    selectedTargetInterior: difference(
      baseline.samples.targetInterior,
      selected.samples.targetInterior,
    ),
    selectedPreserved: difference(baseline.samples.preserved, selected.samples.preserved),
    repeatedTarget: difference(selected.samples.target, repeated.samples.target),
    repeatedTargetInterior: difference(
      selected.samples.targetInterior,
      repeated.samples.targetInterior,
    ),
    repeatedPreserved: difference(selected.samples.preserved, repeated.samples.preserved),
    hiddenTarget: difference(repeated.samples.target, hidden.samples.target),
    hiddenTargetInterior: difference(
      repeated.samples.targetInterior,
      hidden.samples.targetInterior,
    ),
    hiddenPreserved: difference(repeated.samples.preserved, hidden.samples.preserved),
    restoredTarget: difference(repeated.samples.target, restored.samples.target),
    restoredTargetInterior: difference(
      repeated.samples.targetInterior,
      restored.samples.targetInterior,
    ),
    restoredPreserved: difference(repeated.samples.preserved, restored.samples.preserved),
  };
  const assertions = {
    rendererSwitchRestoredSelection: !switchedState || (
      switchedState.selectedMaterialIndex === TARGET_MATERIAL
      && switchedState.outlineTargetCount === 1
    ),
    primeSelectedCorrectMaterial: primeState.selectedMaterialIndex === TARGET_MATERIAL
      && primeState.pickedMaterialIndex === TARGET_MATERIAL
      && primeState.outlineTargetCount === 1,
    baselineUnselected: baselineState.selectedMaterialIndex === null
      && baselineState.pickedMaterialIndex === null
      && baselineState.outlineTargetCount === 0,
    selectedCorrectMaterial: selectedState.selectedMaterialIndex === TARGET_MATERIAL
      && selectedState.pickedMaterialIndex === TARGET_MATERIAL,
    selectedHasSingleOutlineTarget: selectedState.outlineTargetCount === 1,
    repeatedClickPublishedSelection: repeatedState.selectedMaterialIndex === TARGET_MATERIAL
      && repeatedState.pickedMaterialIndex === TARGET_MATERIAL
      && repeatedClickFocusedMaterial,
    repeatedClickKeptVisualStable: pixelDifferences.repeatedTarget.changedPixelRatio <= STABLE_PIXEL_RATIO
      && pixelDifferences.repeatedTargetInterior.changedPixelRatio <= STABLE_PIXEL_RATIO
      && pixelDifferences.repeatedPreserved.changedPixelRatio <= STABLE_PIXEL_RATIO,
    hiddenStatePersisted: hiddenState.hiddenMaterialIndices.includes(TARGET_MATERIAL)
      && hiddenState.pickedMaterialIndex === null,
    hiddenHasNoSelectionOutline: hiddenState.outlineTargetCount === 0,
    restoredStateVisible: !restoredState.hiddenMaterialIndices.includes(TARGET_MATERIAL)
      && restoredState.pickedMaterialIndex === null,
    restoredHasSingleOutlineTarget: restoredState.outlineTargetCount === 1,
    selectionChangedTargetPixels: pixelDifferences.selectedTarget.changedPixelRatio >= 0.0005,
    selectionPreservedTargetInterior: pixelDifferences.selectedTargetInterior.changedPixelRatio
      <= STABLE_PIXEL_RATIO,
    selectionPreservedOtherMaterial: pixelDifferences.selectedPreserved.changedPixelRatio <= PRESERVED_PIXEL_RATIO,
    hidingChangedTargetPixels: pixelDifferences.hiddenTarget.changedPixelRatio >= 0.05
      && pixelDifferences.hiddenTargetInterior.changedPixelRatio >= 0.5,
    hidingPreservedOtherMaterial: pixelDifferences.hiddenPreserved.changedPixelRatio <= PRESERVED_PIXEL_RATIO,
    restoredTargetMatchesSelected: pixelDifferences.restoredTarget.changedPixelRatio <= PRESERVED_PIXEL_RATIO,
    restoredTargetInteriorMatchesSelected: pixelDifferences.restoredTargetInterior.changedPixelRatio
      <= STABLE_PIXEL_RATIO,
    restoredOtherMaterialMatchesSelected: pixelDifferences.restoredPreserved.changedPixelRatio <= PRESERVED_PIXEL_RATIO,
    cameraDragDidNotSelect: selectionStayedAfterDrag && dragSelectionEvents.length === 0,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error(`${backend} model-part assertions failed: ${JSON.stringify(assertions)}`);
  }
  return {
    backend,
    webgl,
    states: {
      switched: switchedState,
      prime: primeState,
      baseline: baselineState,
      selected: selectedState,
      repeated: repeatedState,
      hidden: hiddenState,
      restored: restoredState,
    },
    interactions: {
      repeatedClickFocusedMaterial,
      dragSelectionEvents,
      selectionStayedAfterDrag,
    },
    screenshots: {
      baseline: { path: baseline.path, sha256: baseline.sha256 },
      selected: { path: selected.path, sha256: selected.sha256 },
      repeated: { path: repeated.path, sha256: repeated.sha256 },
      hidden: { path: hidden.path, sha256: hidden.sha256 },
      restored: { path: restored.path, sha256: restored.sha256 },
    },
    pixelDifferences,
    assertions,
  };
};

const main = async () => {
  if (!modelPath || modelPath === resolve("")) throw new Error("MELY_MODEL_PATH is required");
  const { chromium } = require(playwrightPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    appUrl,
    modelPath,
    fixtureProfile: MODEL_PART_SELECTION_PROFILE,
    browser: null,
    backends: [],
    consoleErrors: [],
    pageErrors: [],
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
      window.__MELY_E2E_VIEW_PROBE__ = true;
      window.__MELY_E2E_MATERIAL_SELECTION_PROBE__ = true;
    });
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelPath);
    await waitForModel(page);
    report.browser = { version: await browser.version() };

    for (const backend of BACKENDS) {
      report.backends.push(await exerciseBackend(page, backend));
    }
    report.assertions = {
      allBackendsExecuted: report.backends.length === BACKENDS.length,
      allBackendsPassed: report.backends.every((entry) => (
        Object.values(entry.assertions).every(Boolean)
      )),
      allHardwareGpu: report.backends.every((entry) => (
        entry.webgl.unmaskedRendererInfo
        && D3D11_RENDERER_PATTERN.test(`${entry.webgl.vendor} ${entry.webgl.renderer}`)
        && !SOFTWARE_RENDERER_PATTERN.test(`${entry.webgl.vendor} ${entry.webgl.renderer}`)
      )),
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
    };
    report.passed = Object.values(report.assertions).every(Boolean);
    if (!report.passed) {
      throw new Error(`Model-part E2E assertions failed: ${JSON.stringify(report.assertions)}`);
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
