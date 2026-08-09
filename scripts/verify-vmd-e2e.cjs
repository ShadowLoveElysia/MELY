const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");
const nbt = require("prismarine-nbt");

const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = resolve(process.env.MELY_MODEL_ZIP || "");
const motionPath = resolve(
  process.env.MELY_MOTION_PATH || join(projectRoot, "tests/fixtures/mely-motion-e2e.vmd"),
);
const browserPath = process.env.MELY_BROWSER_PATH;
const playwrightPath = process.env.MELY_PLAYWRIGHT_MODULE || "playwright";
const targetHeight = Number(process.env.MELY_TARGET_HEIGHT || 96);
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY || join(projectRoot, "release-validation/vmd-pose-e2e"),
);
const reportPath = resolve(
  process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"),
);

if (!process.env.MELY_MODEL_ZIP) throw new Error("MELY_MODEL_ZIP is required");
if (!existsSync(modelZip)) throw new Error(`Model ZIP does not exist: ${modelZip}`);
if (!existsSync(motionPath)) throw new Error(`VMD file does not exist: ${motionPath}`);
if (!Number.isInteger(targetHeight) || targetHeight < 32 || targetHeight > 384) {
  throw new Error("MELY_TARGET_HEIGHT must be an integer from 32 to 384");
}

const { chromium } = require(playwrightPath);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

const poseNumber = (value) => {
  const rounded = Math.round(Number(value) * 100_000) / 100_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const poseName = (value) => String(value).normalize("NFKC").trim();

const canonicalQuaternion = (value) => {
  const source = Array.isArray(value) ? value.map(Number) : [0, 0, 0, 1];
  const length = Math.hypot(...source) || 1;
  const sign = source[3] < 0 ? -1 : 1;
  return source.map((component) => poseNumber(component * sign / length));
};

const canonicalPose = (document) => ({
  generator: document.generator,
  version: document.version,
  bones: [...(document.bones || [])].map((bone) => ({
    name: poseName(bone.name),
    pos: (bone.pos || []).map(poseNumber),
    rot: canonicalQuaternion(bone.rot),
  })).sort((left, right) => left.name.localeCompare(right.name)),
  morphs: [...(document.morphs || [])].map((morph) => ({
    name: poseName(morph.name),
    weight: poseNumber(morph.weight),
  })).sort((left, right) => left.name.localeCompare(right.name)),
});

const poseFingerprint = (document) => sha256(JSON.stringify(canonicalPose(document)));

const projectionFingerprint = async (path) => {
  const bytes = await readFile(path);
  const { parsed } = await nbt.parse(bytes, "big");
  const root = nbt.simplify(parsed);
  const regions = Object.entries(root.Regions).sort(([left], [right]) => left.localeCompare(right));
  const semantic = stableValue({
    dataVersion: root.MinecraftDataVersion,
    dimensions: root.Metadata.EnclosingSize,
    totalBlocks: root.Metadata.TotalBlocks,
    regions: regions.map(([name, region]) => ({
      name,
      position: region.Position,
      size: region.Size,
      palette: region.BlockStatePalette,
      blockStates: region.BlockStates,
    })),
  });
  return {
    hash: sha256(JSON.stringify(semantic)),
    byteLength: bytes.byteLength,
    version: root.Version,
    dataVersion: root.MinecraftDataVersion,
    totalBlocks: root.Metadata.TotalBlocks,
    dimensions: root.Metadata.EnclosingSize,
    regionCount: regions.length,
  };
};

const canvasPixels = async (page, screenshot) => page.evaluate(async (source) => {
  const image = new Image();
  image.src = `data:image/png;base64,${source}`;
  await image.decode();
  const sample = document.createElement("canvas");
  sample.width = 128;
  sample.height = 128;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D sampling is unavailable");
  context.drawImage(image, 0, 0, sample.width, sample.height);
  return [...context.getImageData(0, 0, sample.width, sample.height).data];
}, screenshot.toString("base64"));

const canvasStatistics = (pixels) => {
  let nonTransparent = 0;
  let luminanceSum = 0;
  let luminanceSquared = 0;
  const colors = new Set();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (alpha > 0) nonTransparent += 1;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luminanceSum += luminance;
    luminanceSquared += luminance * luminance;
    colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 4}`);
  }
  const pixelCount = pixels.length / 4;
  const meanLuminance = luminanceSum / Math.max(1, pixelCount);
  return {
    pixelCount,
    nonTransparentRatio: nonTransparent / Math.max(1, pixelCount),
    meanLuminance,
    luminanceStandardDeviation: Math.sqrt(Math.max(
      0,
      luminanceSquared / Math.max(1, pixelCount) - meanLuminance * meanLuminance,
    )),
    quantizedColorCount: colors.size,
  };
};

const canvasDifference = (left, right) => {
  if (left.length !== right.length) throw new Error("Canvas sample sizes differ");
  let channelDelta = 0;
  let changedPixels = 0;
  const pixelCount = left.length / 4;
  for (let offset = 0; offset < left.length; offset += 4) {
    const red = Math.abs(left[offset] - right[offset]);
    const green = Math.abs(left[offset + 1] - right[offset + 1]);
    const blue = Math.abs(left[offset + 2] - right[offset + 2]);
    channelDelta += red + green + blue;
    if (red + green + blue >= 18) changedPixels += 1;
  }
  return {
    meanAbsoluteRgbError: channelDelta / Math.max(1, pixelCount * 3),
    changedPixelRatio: changedPixels / Math.max(1, pixelCount),
  };
};

const saveCanvas = async (page, name) => {
  await page.locator(".toast").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(250);
  const canvas = page.locator("canvas").first();
  const screenshot = await canvas.screenshot({ type: "png" });
  const path = join(outputDirectory, `${name}.png`);
  await writeFile(path, screenshot);
  const pixels = await canvasPixels(page, screenshot);
  return {
    path,
    sha256: sha256(screenshot),
    bounds: await canvas.boundingBox(),
    statistics: canvasStatistics(pixels),
    pixels,
  };
};

const waitForModel = async (page) => {
  await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 }).catch(() => undefined);
  await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });
  await page.waitForFunction(
    () => document.querySelector(".model-summary__header small")?.textContent?.trim() === "PMX",
    null,
    { timeout: 180_000 },
  );
};

const currentFrame = async (timeline) => Number(await timeline.inputValue());

const setRange = async (page, timeline, value) => {
  await timeline.fill(String(value));
  await page.waitForFunction(
    (expected) => Number(document.querySelector('input[aria-label="Motion frame"]')?.value) === expected,
    value,
  );
};

const generateProjection = async (page) => {
  const generate = page.getByRole("button", { name: "Generate hologram", exact: true });
  await generate.waitFor({ state: "visible" });
  if (!await generate.isEnabled()) throw new Error("Projection generation is disabled");
  await generate.click();
  await page.locator(".progress-block").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".progress-block").waitFor({ state: "hidden", timeout: 300_000 });
  await page.locator(".export-button").waitFor({ state: "visible" });
  if (!await page.locator(".export-button").isEnabled()) throw new Error("Projection export is disabled");
};

const exportLitematic = async (page, outputName) => {
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator(".export-button").click();
  const exportDialog = page.getByRole("dialog").filter({ hasText: "Export center" });
  await exportDialog.waitFor({ state: "visible" });
  await exportDialog.getByRole("button", { name: /Litematica projection/ }).click();
  const download = await downloadPromise;
  const path = join(outputDirectory, outputName);
  await download.saveAs(path);
  return { path, fingerprint: await projectionFingerprint(path) };
};

const exportPose = async (page, outputName) => {
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Export pose JSON", exact: true }).click();
  const download = await downloadPromise;
  const path = join(outputDirectory, outputName);
  await download.saveAs(path);
  const document = JSON.parse(await readFile(path, "utf8"));
  return { path, document, fingerprint: poseFingerprint(document) };
};

const chooseRotatingBone = async (page) => {
  const select = page.getByRole("combobox", { name: "Select bone" });
  const candidates = await select.locator("option").evaluateAll((options) => options.map((option) => ({
    value: option.value,
    text: option.textContent || "",
  })));
  const ordered = [
    ...candidates.filter((candidate) => /上半身|upper body|upperbody/i.test(candidate.text)),
    ...candidates.filter((candidate) => candidate.value && !/IK/i.test(candidate.text)),
  ].filter((candidate, index, values) => (
    values.findIndex((value) => value.value === candidate.value) === index
  ));
  for (const candidate of ordered) {
    await select.selectOption(candidate.value);
    await page.waitForFunction((value) => (
      document.querySelector('select[aria-label="Select bone"]')?.value === value
    ), candidate.value);
    const mode = await page.locator(".pose-control__header small").innerText();
    if (mode.trim() === "Rotate") return candidate;
  }
  throw new Error("No rotatable bone is available in the real model");
};

const main = async () => {
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const motionBytes = await readFile(motionPath);
  const report = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    appUrl,
    modelZip,
    targetHeight,
    outputDirectory,
    reportPath,
    motion: {
      path: motionPath,
      byteLength: motionBytes.byteLength,
      sha256: sha256(motionBytes),
      provenance: motionPath.includes(`${join(projectRoot, "tests/fixtures")}`)
        ? "repository fixture"
        : "external local file",
    },
    assetSearch: {
      directDownloadsVmd: [],
      modelArchiveVmd: [],
      realSdefQdefAsset: null,
      note: "No direct .vmd/.pmx/.pmd files were found under H:\\Downloads. The supplied Elysia ZIP contains four PMX models and no VMD; its selected 35,033-vertex model is entirely BDEF.",
    },
    consoleErrors: [],
    pageErrors: [],
    controls: {},
    pose: {},
    manualPose: {},
    cameras: {},
    projections: {},
  };

  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.setDefaultTimeout(180_000);
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message));

    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60_000 });

    const assetInput = page.locator('input[type="file"][accept*=".pmx"]');
    await assetInput.setInputFiles(modelZip);
    await waitForModel(page);
    report.model = {
      name: await page.locator(".model-summary__header strong").innerText(),
      format: await page.locator(".model-summary__header small").innerText(),
      stats: await page.locator(".model-stat-grid").innerText(),
    };

    const heightInput = page.locator(".slider-number input").first();
    await heightInput.fill(String(targetHeight));
    await heightInput.press("Enter");

    await assetInput.setInputFiles(motionPath);
    await page.locator(".motion-control").waitFor({ state: "visible", timeout: 60_000 });
    const timeline = page.getByRole("slider", { name: "Motion frame" });
    await timeline.waitFor({ state: "visible" });
    report.controls.timeline = {
      min: await timeline.getAttribute("min"),
      max: await timeline.getAttribute("max"),
      initial: await currentFrame(timeline),
    };
    report.controls.generationDisabledBeforeLock = await page
      .getByRole("button", { name: "Generate hologram", exact: true })
      .isDisabled();

    const previous = page.getByRole("button", { name: "Previous frame", exact: true });
    const next = page.getByRole("button", { name: "Next frame", exact: true });
    report.controls.f0PreviousDisabled = await previous.isDisabled();
    await next.click();
    report.controls.afterNext = await currentFrame(timeline);
    await previous.click();
    report.controls.afterPrevious = await currentFrame(timeline);
    await setRange(page, timeline, 30);
    report.controls.f30NextDisabled = await next.isDisabled();

    await setRange(page, timeline, 0);
    await page.getByRole("button", { name: "Play motion", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Motion frame"]')?.value) > 0);
    await page.getByRole("button", { name: "Pause motion", exact: true }).click();
    const clickPausedFrame = await currentFrame(timeline);
    await page.waitForTimeout(180);
    report.controls.clickPlayback = {
      pausedFrame: clickPausedFrame,
      stableFrame: await currentFrame(timeline),
    };

    await setRange(page, timeline, 0);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Pause motion", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Motion frame"]')?.value) > 0);
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Play motion", exact: true }).waitFor({ state: "visible" });
    report.controls.spacePausedFrame = await currentFrame(timeline);

    await setRange(page, timeline, 0);
    await page.getByRole("button", { name: "Lock current frame", exact: true }).click();
    await page.getByRole("button", { name: "Unlock frame", exact: true }).waitFor({ state: "visible" });
    report.controls.lockedF0 = await timeline.isDisabled();
    await page.getByRole("button", { name: "Reset camera", exact: true }).click();
    await page.waitForTimeout(500);
    const frame0Canvas = await saveCanvas(page, "frame-0-source");
    report.pose.f0Canvas = { ...frame0Canvas, pixels: undefined };
    await generateProjection(page);
    report.projections.f0 = await exportLitematic(page, "frame-0.litematic");

    await page.getByRole("button", { name: "Source model", exact: true }).click();
    await page.getByRole("button", { name: "Unlock frame", exact: true }).click();
    await setRange(page, timeline, 30);
    await page.getByRole("button", { name: "Lock current frame", exact: true }).click();
    await page.getByRole("button", { name: "Unlock frame", exact: true }).waitFor({ state: "visible" });
    report.controls.lockedF30 = await timeline.isDisabled();
    await page.getByRole("button", { name: "Reset camera", exact: true }).click();
    await page.waitForTimeout(500);
    const frame30Canvas = await saveCanvas(page, "frame-30-source");
    report.pose.f30Canvas = { ...frame30Canvas, pixels: undefined };
    report.pose.f0ToF30CanvasDifference = canvasDifference(frame0Canvas.pixels, frame30Canvas.pixels);

    const frame30Pose = await exportPose(page, "frame-30.pose.json");
    report.pose.frame30 = {
      path: frame30Pose.path,
      boneCount: frame30Pose.document.bones?.length,
      boneNames: frame30Pose.document.bones?.map((bone) => bone.name),
      morphCount: frame30Pose.document.morphs?.length || 0,
    };
    await generateProjection(page);
    report.projections.f30 = await exportLitematic(page, "frame-30.litematic");

    const poseInput = page.locator('input[type="file"][accept*=".pose.json"]');
    await poseInput.setInputFiles(frame30Pose.path);
    await page.locator(".motion-control").waitFor({ state: "detached", timeout: 30_000 });
    report.pose.motionClearedAfterImport = await page.locator(".motion-control").count() === 0;
    const importedPose = await exportPose(page, "imported-roundtrip.pose.json");
    report.pose.importedRoundTrip = {
      path: importedPose.path,
      fingerprint: importedPose.fingerprint,
      boneCount: importedPose.document.bones?.length,
      morphCount: importedPose.document.morphs?.length || 0,
    };
    await page.getByRole("button", { name: "Reset camera", exact: true }).click();
    const importedCanvas = await saveCanvas(page, "imported-pose-source");
    report.pose.importedCanvas = { ...importedCanvas, pixels: undefined };
    report.pose.f0ToImportedCanvasDifference = canvasDifference(frame0Canvas.pixels, importedCanvas.pixels);
    report.pose.f30ToImportedCanvasDifference = canvasDifference(frame30Canvas.pixels, importedCanvas.pixels);
    await generateProjection(page);
    report.projections.importedPose = await exportLitematic(page, "imported-pose.litematic");

    await page.getByRole("button", { name: "Source model", exact: true }).click();
    await page.getByRole("switch", { name: "Manual posing", exact: true }).click();
    const rotatingBone = await chooseRotatingBone(page);
    const manualBasePose = await exportPose(page, "manual-pose-before.pose.json");
    const manualBase = await saveCanvas(page, "manual-pose-before");
    const nudge = page.getByRole("button", { name: "Nudge Z positive", exact: true });
    for (let count = 0; count < 6; count += 1) await nudge.click();
    const manualAfter = await saveCanvas(page, "manual-pose-after");
    const manualPose = await exportPose(page, "manual-k-pose.pose.json");
    const manualBone = manualPose.document.bones?.find((bone) => bone.name === rotatingBone.text.split(" / ")[0].replace(/^\d+\s*·\s*/, ""))
      || manualPose.document.bones?.[0];
    report.manualPose = {
      selectedBone: rotatingBone,
      before: { ...manualBase, pixels: undefined },
      after: { ...manualAfter, pixels: undefined },
      canvasDifference: canvasDifference(manualBase.pixels, manualAfter.pixels),
      basePosePath: manualBasePose.path,
      basePoseFingerprint: manualBasePose.fingerprint,
      posePath: manualPose.path,
      boneCount: manualPose.document.bones?.length,
      exportedBone: manualBone || null,
      editCountText: await page.locator(".pose-actions output").innerText(),
    };
    const undo = page.getByRole("button", { name: "Undo pose", exact: true });
    const redo = page.getByRole("button", { name: "Redo pose", exact: true });
    for (let count = 0; count < 6; count += 1) await undo.click();
    const undoCanvas = await saveCanvas(page, "manual-pose-undo");
    const undoPose = await exportPose(page, "manual-pose-undo.pose.json");
    for (let count = 0; count < 6; count += 1) await redo.click();
    const redoCanvas = await saveCanvas(page, "manual-pose-redo");
    const redoPose = await exportPose(page, "manual-pose-redo.pose.json");
    report.manualPose.undoDifferenceFromBase = canvasDifference(manualBase.pixels, undoCanvas.pixels);
    report.manualPose.redoDifferenceFromEdited = canvasDifference(manualAfter.pixels, redoCanvas.pixels);
    report.manualPose.undoPose = {
      path: undoPose.path,
      fingerprint: undoPose.fingerprint,
      matchesManualBase: undoPose.fingerprint === manualBasePose.fingerprint,
    };
    report.manualPose.redoPose = {
      path: redoPose.path,
      fingerprint: redoPose.fingerprint,
      matchesEditedPose: redoPose.fingerprint === manualPose.fingerprint,
    };

    await page.getByRole("button", { name: "Orbit view", exact: true }).click();
    await page.getByRole("button", { name: "Perspective view", exact: true }).click();
    await page.getByRole("button", { name: "Focus face", exact: true }).click();
    await page.waitForTimeout(700);
    const perspectiveFace = await saveCanvas(page, "face-focus-perspective");
    await page.getByRole("button", { name: "Orthographic view", exact: true }).click();
    await page.getByRole("button", { name: "Focus face", exact: true }).click();
    await page.waitForTimeout(700);
    const orthographicFace = await saveCanvas(page, "face-focus-orthographic");
    report.cameras = {
      perspective: { ...perspectiveFace, pixels: undefined },
      orthographic: { ...orthographicFace, pixels: undefined },
      perspectiveToOrthographicDifference: canvasDifference(
        perspectiveFace.pixels,
        orthographicFace.pixels,
      ),
      perspectiveActive: await page.getByRole("button", { name: "Perspective view", exact: true }).getAttribute("class"),
      orthographicActive: await page.getByRole("button", { name: "Orthographic view", exact: true }).getAttribute("class"),
    };

    report.assertions = {
      timelineRange: report.controls.timeline.min === "0"
        && report.controls.timeline.max === "30"
        && report.controls.timeline.initial === 0,
      generationDisabledBeforeLock: report.controls.generationDisabledBeforeLock,
      frameStepBoundaries: report.controls.f0PreviousDisabled
        && report.controls.afterNext === 1
        && report.controls.afterPrevious === 0
        && report.controls.f30NextDisabled,
      clickPauseStable: report.controls.clickPlayback.pausedFrame > 0
        && report.controls.clickPlayback.stableFrame === report.controls.clickPlayback.pausedFrame,
      spacePauseAdvanced: report.controls.spacePausedFrame > 0,
      framesLocked: report.controls.lockedF0 && report.controls.lockedF30,
      frame0DiffersFromFrame30: report.projections.f0.fingerprint.hash
        !== report.projections.f30.fingerprint.hash,
      sourceCanvasChangedAtFrame30: report.pose.f0ToF30CanvasDifference.changedPixelRatio >= 0.01,
      poseSchema: frame30Pose.document.generator === "MELY"
        && frame30Pose.document.version === "1.0"
        && frame30Pose.document.bones?.some((bone) => bone.name === "上半身"),
      motionClearedAfterPoseImport: report.pose.motionClearedAfterImport,
      importedPoseJsonMatchesFrame30: importedPose.fingerprint === frame30Pose.fingerprint,
      importedProjectionMatchesFrame30: report.projections.f30.fingerprint.hash
        === report.projections.importedPose.fingerprint.hash,
      importedSourceCloserToFrame30: report.pose.f30ToImportedCanvasDifference.meanAbsoluteRgbError
          <= report.pose.f0ToImportedCanvasDifference.meanAbsoluteRgbError * 0.25
        && report.pose.f30ToImportedCanvasDifference.changedPixelRatio
          <= report.pose.f0ToImportedCanvasDifference.changedPixelRatio * 0.5,
      manualPoseChangedCanvas: report.manualPose.canvasDifference.changedPixelRatio >= 0.001,
      manualPoseExported: manualPose.document.generator === "MELY"
        && manualPose.document.version === "1.0"
        && (manualPose.document.bones?.length || 0) > 0,
      manualUndoRestoredPoseJson: report.manualPose.undoPose.matchesManualBase,
      manualRedoRestoredPoseJson: report.manualPose.redoPose.matchesEditedPose,
      perspectiveFaceNonBlank: perspectiveFace.statistics.quantizedColorCount >= 16
        && perspectiveFace.statistics.luminanceStandardDeviation >= 3,
      orthographicFaceNonBlank: orthographicFace.statistics.quantizedColorCount >= 16
        && orthographicFace.statistics.luminanceStandardDeviation >= 3,
      cameraModesDiffer: report.cameras.perspectiveToOrthographicDifference.changedPixelRatio >= 0.005,
      orthographicButtonActive: report.cameras.orthographicActive.includes("icon-button--active"),
      validLitematicaExports: [
        report.projections.f0,
        report.projections.f30,
        report.projections.importedPose,
      ].every((entry) => entry.fingerprint.version === 6
        && entry.fingerprint.dataVersion === 3465
        && entry.fingerprint.totalBlocks > 0),
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
    };
    report.status = Object.values(report.assertions).every(Boolean) ? "passed" : "failed";
    if (report.status !== "passed") {
      const failures = Object.entries(report.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      throw new Error(`VMD/Pose E2E assertions failed: ${failures.join(", ")}`);
    }
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      reportPath,
      status: report.status,
      assertions: report.assertions,
      error: report.error,
    }, null, 2)}\n`);
    await browser.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
