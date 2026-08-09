const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const { chromium } = require(process.env.MELY_PLAYWRIGHT_MODULE || "playwright");

const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4227/";
const modelZip = resolve(process.env.MELY_MODEL_ZIP || "");
const browserPath = process.env.MELY_BROWSER_PATH;
const targetHeight = Number(process.env.MELY_TARGET_HEIGHT || 320);
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY
    || join(projectRoot, "release-validation/face-detail-approval"),
);
const reportPath = resolve(process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"));
const viewport = { width: 1600, height: 1000 };
const variants = ["off", "balanced", "strong"];
const viewDefinitions = [
  { id: "full-front", label: "Full body front" },
  { id: "face-front", label: "Face front" },
  { id: "face-oblique", label: "Face oblique" },
];
const resetDirection = [1.05, 0.58, 1.35];
const obliqueDragFraction = 0.085;

if (!process.env.MELY_MODEL_ZIP) throw new Error("MELY_MODEL_ZIP is required");
if (!existsSync(modelZip)) throw new Error(`Model ZIP does not exist: ${modelZip}`);
if (!Number.isInteger(targetHeight) || targetHeight < 32 || targetHeight > 384) {
  throw new Error("MELY_TARGET_HEIGHT must be an integer from 32 to 384");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const roundNumber = (value, precision = 9) => {
  const factor = 10 ** precision;
  const rounded = Math.round(Number(value) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const roundTuple = (value, precision = 9) => value.map((item) => roundNumber(item, precision));
const maxMatrixDelta = (left, right) => left.reduce(
  (maximum, value, index) => Math.max(maximum, Math.abs(value - right[index])),
  0,
);
const normalize = (value) => {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length);
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const normalizeAngle = (angle) => {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
};

const field = (page, label) => page.locator(".field-row").filter({ hasText: label });

const setRange = async (range, value) => {
  await range.fill(String(value));
  await range.evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
};

const setSwitch = async (page, label, enabled) => {
  const control = page.getByRole("switch", { name: label, exact: true });
  const current = await control.getAttribute("aria-checked") === "true";
  if (current !== enabled) await control.click();
};

const settleFrames = async (page, frameCount = 4) => page.evaluate(async (count) => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve_) => requestAnimationFrame(resolve_));
  }
}, frameCount);

const cameraSnapshot = async (page) => page.evaluate(() => {
  const runtime = window.__melyFaceApprovalRuntime;
  const activeCamera = runtime?.controls?.object;
  if (activeCamera) {
    activeCamera.updateMatrixWorld(true);
    const viewMatrix = [...activeCamera.matrixWorldInverse.elements];
    return {
      viewMatrix,
      projectionMatrix: [...activeCamera.projectionMatrix.elements],
      position: activeCamera.position.toArray(),
      target: runtime.controls.target.toArray(),
      right: [viewMatrix[0], viewMatrix[4], viewMatrix[8]],
      up: [viewMatrix[1], viewMatrix[5], viewMatrix[9]],
      lookDirection: [-viewMatrix[2], -viewMatrix[6], -viewMatrix[10]],
      quaternion: activeCamera.quaternion.toArray(),
      perspective: Boolean(activeCamera.isPerspectiveCamera),
      orthographic: Boolean(activeCamera.isOrthographicCamera),
      fovDegrees: activeCamera.isPerspectiveCamera ? activeCamera.fov : 0,
      aspect: activeCamera.isPerspectiveCamera
        ? activeCamera.aspect
        : (activeCamera.right - activeCamera.left)
          / Math.max(1e-9, activeCamera.top - activeCamera.bottom),
      near: activeCamera.near,
      far: activeCamera.far,
      zoom: activeCamera.zoom,
      minDistance: runtime.controls.minDistance,
      maxDistance: runtime.controls.maxDistance,
      source: "viewport-runtime",
    };
  }
  const rendered = window.__melyFaceApprovalCamera;
  if (rendered?.viewMatrix && rendered?.projectionMatrix) {
    return {
      viewMatrix: [...rendered.viewMatrix],
      projectionMatrix: [...rendered.projectionMatrix],
      position: [...rendered.position],
      right: [...rendered.right],
      up: [...rendered.up],
      lookDirection: [...rendered.lookDirection],
      quaternion: [...rendered.quaternion],
      perspective: rendered.perspective,
      orthographic: rendered.orthographic,
      fovDegrees: rendered.fovDegrees,
      aspect: rendered.aspect,
      near: rendered.near,
      far: rendered.far,
      zoom: rendered.zoom,
      renderUpdatedAt: rendered.updatedAt,
      source: "three-renderer",
    };
  }
  const audit = window.__melyFaceApprovalGl;
  const viewMatrix = audit?.viewMatrix ? [...audit.viewMatrix] : null;
  const projectionMatrix = audit?.projectionMatrix ? [...audit.projectionMatrix] : null;
  if (!viewMatrix || !projectionMatrix) return null;

  const position = audit.cameraPosition
    ? [...audit.cameraPosition]
    : [
        -(viewMatrix[0] * viewMatrix[12]
          + viewMatrix[1] * viewMatrix[13]
          + viewMatrix[2] * viewMatrix[14]),
        -(viewMatrix[4] * viewMatrix[12]
          + viewMatrix[5] * viewMatrix[13]
          + viewMatrix[6] * viewMatrix[14]),
        -(viewMatrix[8] * viewMatrix[12]
          + viewMatrix[9] * viewMatrix[13]
          + viewMatrix[10] * viewMatrix[14]),
      ];
  const fovRadians = 2 * Math.atan(1 / Math.abs(projectionMatrix[5]));
  const near = projectionMatrix[14] / (projectionMatrix[10] - 1);
  const far = projectionMatrix[14] / (projectionMatrix[10] + 1);
  return {
    viewMatrix,
    projectionMatrix,
    position,
    right: [viewMatrix[0], viewMatrix[4], viewMatrix[8]],
    up: [viewMatrix[1], viewMatrix[5], viewMatrix[9]],
    lookDirection: [-viewMatrix[2], -viewMatrix[6], -viewMatrix[10]],
    perspective: Math.abs(projectionMatrix[15]) < 0.5,
    fovDegrees: fovRadians * 180 / Math.PI,
    aspect: projectionMatrix[5] / projectionMatrix[0],
    near,
    far,
    uniformUpdatedAt: audit.updatedAt,
    source: "webgl-uniform-fallback",
  };
});

const waitForCameraStable = async (page) => {
  const stable = await page.evaluate(async () => {
    const read = () => {
      const runtime = window.__melyFaceApprovalRuntime;
      const camera = runtime?.controls?.object;
      if (camera) {
        camera.updateMatrixWorld(true);
        return [...camera.matrixWorldInverse.elements];
      }
      const source = window.__melyFaceApprovalCamera ?? window.__melyFaceApprovalGl;
      return source?.viewMatrix ? [...source.viewMatrix] : null;
    };
    const delta = (left, right) => left.reduce(
      (maximum, value, index) => Math.max(maximum, Math.abs(value - right[index])),
      0,
    );
    let previous = read();
    let stableFrames = 0;
    let maximumObservedDelta = Infinity;
    for (let frame = 0; frame < 300; frame += 1) {
      await new Promise((resolve_) => requestAnimationFrame(resolve_));
      const current = read();
      if (!previous || !current) {
        previous = current;
        continue;
      }
      maximumObservedDelta = delta(previous, current);
      stableFrames = maximumObservedDelta <= 1e-8 ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 10) {
        return { stable: true, frames: frame + 1, finalDelta: maximumObservedDelta };
      }
    }
    return { stable: false, frames: 300, finalDelta: maximumObservedDelta };
  });
  if (!stable.stable) throw new Error(`Camera did not settle: ${JSON.stringify(stable)}`);
  const snapshot = await cameraSnapshot(page);
  if (!snapshot) throw new Error("WebGL camera uniforms were not captured");
  return { ...snapshot, stability: stable };
};

const dragCanvas = async (page, deltaX, deltaY, steps = 48, button = "left") => {
  const canvas = page.locator("canvas").first();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds are unavailable");
  const startX = bounds.x + bounds.width * 0.5;
  const startY = bounds.y + bounds.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button });
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps });
  await page.mouse.up({ button });
};

const fullFrontRecipe = (faceFrame, canvasHeight) => {
  const current = normalize(resetDirection);
  const desired = normalize(faceFrame.forward);
  const currentAzimuth = Math.atan2(current[0], current[2]);
  const desiredAzimuth = Math.atan2(desired[0], desired[2]);
  const currentPolar = Math.acos(clamp(current[1], -1, 1));
  const desiredPolar = Math.acos(clamp(desired[1], -1, 1));
  const azimuthDelta = normalizeAngle(currentAzimuth - desiredAzimuth);
  const polarDelta = currentPolar - desiredPolar;
  return {
    resetDirection: roundTuple(current),
    desiredDirection: roundTuple(desired),
    dragPixels: {
      x: roundNumber(azimuthDelta * canvasHeight / (Math.PI * 2), 6),
      y: roundNumber(polarDelta * canvasHeight / (Math.PI * 2), 6),
    },
    azimuthDegrees: roundNumber(azimuthDelta * 180 / Math.PI, 6),
    polarDegrees: roundNumber(polarDelta * 180 / Math.PI, 6),
    steps: 64,
  };
};

const establishView = async (page, viewId, faceFrame, recipes) => {
  const canvas = page.locator("canvas").first();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas bounds are unavailable");

  if (viewId === "full-front") {
    await page.getByRole("button", { name: "Focus face", exact: true }).click();
    await waitForCameraStable(page);
    await page.getByRole("button", { name: "Reset camera", exact: true }).click();
    await waitForCameraStable(page);
    if (!recipes.fullFront) recipes.fullFront = fullFrontRecipe(faceFrame, bounds.height);
    await dragCanvas(
      page,
      recipes.fullFront.dragPixels.x,
      recipes.fullFront.dragPixels.y,
      recipes.fullFront.steps,
    );
    return waitForCameraStable(page);
  }

  await page.getByRole("button", { name: "Focus face", exact: true }).click();
  await waitForCameraStable(page);
  if (viewId === "face-oblique") {
    if (!recipes.faceOblique) {
      recipes.faceOblique = {
        dragPixels: { x: roundNumber(bounds.height * obliqueDragFraction, 6), y: 0 },
        derivedYawDegrees: roundNumber(obliqueDragFraction * 360, 6),
        steps: 48,
      };
    }
    await dragCanvas(
      page,
      recipes.faceOblique.dragPixels.x,
      recipes.faceOblique.dragPixels.y,
      recipes.faceOblique.steps,
    );
    return waitForCameraStable(page);
  }
  return cameraSnapshot(page);
};

const generateSolid = async (page) => {
  await page.evaluate(() => {
    window.__melyProjectionResult = null;
  });
  const generate = page.getByRole("button", { name: "Generate solid projection", exact: true });
  if (!await generate.isEnabled()) throw new Error("Solid generation is disabled");
  await generate.click();
  await page.locator(".progress-block").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const result = window.__melyProjectionResult;
    const exportButton = document.querySelector(".export-button");
    return result?.kind === "solid"
      && !document.querySelector(".progress-block")
      && exportButton instanceof HTMLButtonElement
      && !exportButton.disabled;
  }, null, { timeout: 300_000 });
};

const summarizeProjection = async (page, variant) => page.evaluate(async ({ variant }) => {
  const result = window.__melyProjectionResult;
  if (!result || result.kind !== "solid" || !result.faceFrame) {
    throw new Error("Solid projection result or faceFrame is unavailable");
  }

  const digest = async (value) => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((entry) => entry.toString(16).padStart(2, "0"))
      .join("");
  };
  const positionsBytes = new Uint8Array(
    result.positions.buffer,
    result.positions.byteOffset,
    result.positions.byteLength,
  );
  const coordinateKeys = [];
  const stateEntries = [];
  const stateMap = new Map();
  const paletteCounts = new Map();
  for (let index = 0; index < result.blockIndices.length; index += 1) {
    const x = result.positions[index * 3];
    const y = result.positions[index * 3 + 1];
    const z = result.positions[index * 3 + 2];
    const key = `${x},${y},${z}`;
    const blockId = result.palette[result.blockIndices[index]]?.blockId || "unknown";
    coordinateKeys.push(key);
    stateEntries.push(`${key}=${blockId}`);
    stateMap.set(key, blockId);
    paletteCounts.set(blockId, (paletteCounts.get(blockId) || 0) + 1);
  }
  coordinateKeys.sort();
  stateEntries.sort();

  const frame = result.faceFrame;
  const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  const faceCells = new Map();
  for (let index = 0; index < result.blockIndices.length; index += 1) {
    const position = [
      result.positions[index * 3],
      result.positions[index * 3 + 1],
      result.positions[index * 3 + 2],
    ];
    const relative = position.map((value, axis) => value - frame.origin[axis]);
    const local = {
      horizontal: dot(relative, frame.right) / frame.eyeDistance,
      vertical: dot(relative, frame.up) / frame.eyeDistance,
      depth: dot(relative, frame.forward) / frame.eyeDistance,
    };
    if (
      Math.abs(local.horizontal) > 1.75
      || local.vertical < -2.05
      || local.vertical > 1.2
      || local.depth < -1.5
      || local.depth > 1.45
    ) continue;
    const cellKey = `${Math.round(local.horizontal * frame.eyeDistance)},${Math.round(local.vertical * frame.eyeDistance)}`;
    const existing = faceCells.get(cellKey);
    if (!existing || local.depth > existing.local.depth) {
      faceCells.set(cellKey, {
        cellKey,
        position,
        local,
        blockId: result.palette[result.blockIndices[index]]?.blockId || "unknown",
      });
    }
  }

  const baseline = window.__melyFaceApprovalBaseline;
  let comparisonToOff = null;
  if (variant === "off") {
    window.__melyFaceApprovalBaseline = { stateMap, faceCells };
  } else {
    if (!baseline) throw new Error("Off baseline was not captured before face variants");
    let missingCoordinates = 0;
    let addedCoordinates = 0;
    let changedStateBlocks = 0;
    const transitions = new Map();
    for (const [key, baselineState] of baseline.stateMap) {
      const nextState = stateMap.get(key);
      if (nextState === undefined) missingCoordinates += 1;
      else if (nextState !== baselineState) {
        changedStateBlocks += 1;
        const transition = `${baselineState} -> ${nextState}`;
        transitions.set(transition, (transitions.get(transition) || 0) + 1);
      }
    }
    for (const key of stateMap.keys()) {
      if (!baseline.stateMap.has(key)) addedCoordinates += 1;
    }

    const zoneCounts = { eye: 0, brow: 0, mouth: 0, overlay: 0 };
    const sideCounts = { negative: 0, center: 0, positive: 0 };
    const faceTransitions = new Map();
    let changedVisibleFaceCells = 0;
    for (const [cellKey, baselineCell] of baseline.faceCells) {
      const nextCell = faceCells.get(cellKey);
      if (!nextCell || nextCell.blockId === baselineCell.blockId) continue;
      changedVisibleFaceCells += 1;
      const { horizontal, vertical } = nextCell.local;
      const zone = vertical > 0.3 && vertical <= 0.9
        ? "brow"
        : vertical >= -0.65 && vertical <= 0.3
          ? "eye"
          : vertical >= -1.8 && vertical < -0.65
            ? "mouth"
            : "overlay";
      const tolerance = 0.25 / frame.eyeDistance;
      const side = horizontal < -tolerance
        ? "negative"
        : horizontal > tolerance
          ? "positive"
          : "center";
      zoneCounts[zone] += 1;
      sideCounts[side] += 1;
      const transition = `${baselineCell.blockId} -> ${nextCell.blockId}`;
      faceTransitions.set(transition, (faceTransitions.get(transition) || 0) + 1);
    }
    const sortedCounts = (source) => [...source.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([value, count]) => ({ value, count }));
    comparisonToOff = {
      missingCoordinates,
      addedCoordinates,
      changedStateBlocks,
      transitions: sortedCounts(transitions).slice(0, 24),
      visibleFace: {
        offCellCount: baseline.faceCells.size,
        variantCellCount: faceCells.size,
        changedVisibleFaceCells,
        zones: zoneCounts,
        sides: sideCounts,
        transitions: sortedCounts(faceTransitions).slice(0, 24),
      },
    };
  }

  return {
    blockCount: result.stats.blockCount,
    surfaceBlockCount: result.stats.surfaceBlockCount,
    skinBlockCount: result.stats.skinBlockCount,
    paletteSize: result.stats.paletteSize,
    dimensions: result.stats.dimensions,
    bounds: result.bounds,
    faceFrame: result.faceFrame,
    coordinateBufferHash: await digest(positionsBytes),
    coordinateCanonicalHash: await digest(coordinateKeys.join(";")),
    stateHash: await digest(stateEntries.join("\n")),
    paletteCounts: [...paletteCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([blockId, count]) => ({ blockId, count })),
    frontFaceCellCount: faceCells.size,
    comparisonToOff,
  };
}, { variant });

const captureCanvas = async (page, filename) => {
  const canvas = page.locator("canvas").first();
  const cssBounds = await canvas.boundingBox();
  if (!cssBounds) throw new Error("Canvas bounds are unavailable");
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "mely-face-approval-capture-style";
    style.textContent = [
      ".viewport-toolbar { visibility: hidden !important; }",
      ".viewport-info { visibility: hidden !important; }",
      ".axis-gizmo { visibility: hidden !important; }",
      ".toast { visibility: hidden !important; }",
    ].join("\n");
    document.head.appendChild(style);
  });
  await settleFrames(page, 3);
  const bytes = await canvas.screenshot({ type: "png" });
  await page.evaluate(() => document.getElementById("mely-face-approval-capture-style")?.remove());
  await settleFrames(page, 2);
  const path = join(outputDirectory, filename);
  await writeFile(path, bytes);
  return {
    path,
    bytes,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    pixelSize: {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    },
    cssBounds: Object.fromEntries(
      Object.entries(cssBounds).map(([key, value]) => [key, roundNumber(value, 6)]),
    ),
  };
};

const imageDifference = async (page, left, right) => page.evaluate(async ({ left, right }) => {
  const decode = async (source) => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();
    return image;
  };
  const [leftImage, rightImage] = await Promise.all([decode(left), decode(right)]);
  const sample = document.createElement("canvas");
  sample.width = 256;
  sample.height = 256;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D sampling is unavailable");
  context.drawImage(leftImage, 0, 0, sample.width, sample.height);
  const leftPixels = context.getImageData(0, 0, sample.width, sample.height).data;
  context.clearRect(0, 0, sample.width, sample.height);
  context.drawImage(rightImage, 0, 0, sample.width, sample.height);
  const rightPixels = context.getImageData(0, 0, sample.width, sample.height).data;
  let rgbDelta = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < leftPixels.length; offset += 4) {
    const delta = Math.abs(leftPixels[offset] - rightPixels[offset])
      + Math.abs(leftPixels[offset + 1] - rightPixels[offset + 1])
      + Math.abs(leftPixels[offset + 2] - rightPixels[offset + 2]);
    rgbDelta += delta;
    if (delta >= 18) changedPixels += 1;
  }
  const pixelCount = sample.width * sample.height;
  return {
    sampleSize: [sample.width, sample.height],
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteRgbError: rgbDelta / (pixelCount * 3),
  };
}, {
  left: left.toString("base64"),
  right: right.toString("base64"),
});

const createApprovalSheet = async (browser, captures, report) => {
  const sheet = await browser.newPage({ viewport: { width: 2400, height: 2100 } });
  const labels = { off: "OFF", balanced: "BALANCED", strong: "STRONG" };
  const images = Object.fromEntries(variants.map((variant) => [
    variant,
    Object.fromEntries(viewDefinitions.map((view) => [
      view.id,
      captures[variant][view.id].bytes.toString("base64"),
    ])),
  ]));
  const columns = variants.map((variant) => `<div class="column-label">${labels[variant]}</div>`).join("");
  const rows = viewDefinitions.map((view) => `
    <section class="comparison-row">
      <h2>${view.label}</h2>
      <div class="image-grid">
        ${variants.map((variant) => `
          <figure>
            <img alt="${labels[variant]} ${view.label}" src="data:image/png;base64,${images[variant][view.id]}">
          </figure>
        `).join("")}
      </div>
    </section>
  `).join("");
  await sheet.setContent(`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 42px; color: #e6edf1; background: #0b1015; font-family: Arial, sans-serif; }
          header { display: flex; align-items: end; justify-content: space-between; margin-bottom: 24px; }
          h1 { margin: 0 0 8px; font-size: 36px; letter-spacing: 0; }
          header p { margin: 0; color: #8fa1ad; font-size: 18px; }
          .metadata { color: #79d7df; font: 16px Consolas, monospace; text-align: right; }
          .column-grid, .image-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
          .column-grid { margin: 0 0 18px 150px; }
          .column-label { padding: 12px; border-bottom: 2px solid #35bed0; color: #c9f7fb; font-size: 22px; font-weight: 700; text-align: center; }
          .comparison-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 18px; margin-bottom: 24px; }
          h2 { display: flex; align-items: center; margin: 0; color: #9aabb5; font-size: 20px; line-height: 1.25; }
          figure { overflow: hidden; margin: 0; border: 1px solid #2e3a43; background: #080b0f; }
          img { display: block; width: 100%; height: auto; }
          footer { margin-left: 150px; color: #71818c; font-size: 15px; line-height: 1.5; }
        </style>
      </head>
      <body>
        <header>
          <div>
            <h1>MELY Face Enhancement Approval Sheet</h1>
            <p>Real Elysia PMX, solid shell, identical coordinates and matched camera poses</p>
          </div>
          <div class="metadata">${report.modelName}<br>${targetHeight} blocks | ${report.variants.off.projection.blockCount.toLocaleString("en-US")} blocks</div>
        </header>
        <div class="column-grid">${columns}</div>
        ${rows}
        <footer>Only the facial-detail setting changes between columns. OFF is the source-color baseline; BALANCED and STRONG recolor existing foremost face voxels without adding or removing coordinates.</footer>
      </body>
    </html>`, { waitUntil: "load" });
  await sheet.waitForFunction(() => [...document.images].every((image) => image.complete));
  const path = join(outputDirectory, "face-enhancement-approval-sheet.png");
  const bytes = await sheet.screenshot({ path, fullPage: true, type: "png" });
  await sheet.close();
  return {
    path,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    pixelSize: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
  };
};

const comparableCamera = (camera) => ({
  viewMatrix: roundTuple(camera.viewMatrix),
  projectionMatrix: roundTuple(camera.projectionMatrix),
  position: roundTuple(camera.position),
  ...(camera.target ? { target: roundTuple(camera.target) } : {}),
  right: roundTuple(camera.right),
  up: roundTuple(camera.up),
  lookDirection: roundTuple(camera.lookDirection),
  ...(camera.quaternion ? { quaternion: roundTuple(camera.quaternion) } : {}),
  perspective: camera.perspective,
  orthographic: camera.orthographic ?? false,
  fovDegrees: roundNumber(camera.fovDegrees, 6),
  aspect: roundNumber(camera.aspect, 9),
  near: roundNumber(camera.near, 9),
  far: roundNumber(camera.far, 6),
  zoom: roundNumber(camera.zoom ?? 1, 9),
  ...(Number.isFinite(camera.minDistance) ? { minDistance: roundNumber(camera.minDistance, 9) } : {}),
  ...(Number.isFinite(camera.maxDistance) ? { maxDistance: roundNumber(camera.maxDistance, 9) } : {}),
  source: camera.source,
  stability: camera.stability,
});

const run = async () => {
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    format: "MELYFaceEnhancementApproval",
    version: 1,
    generatedAt: new Date().toISOString(),
    appUrl,
    modelZip,
    targetHeight,
    browserViewport: viewport,
    consoleErrors: [],
    pageErrors: [],
    fixedOptions: {},
    cameraRecipes: {},
    variants: {},
    comparisons: {},
  };
  const captures = {};
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(180_000);
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  const viewportInstrumentation = { requests: 0, replacements: 0 };
  await page.route("**/src/components/Viewport3D.tsx*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = "runtimeRef.current = runtime;";
    viewportInstrumentation.requests += 1;
    if (!body.includes(marker)) {
      await route.fulfill({ response, body });
      return;
    }
    viewportInstrumentation.replacements += 1;
    await route.fulfill({
      response,
      body: body.replace(
        marker,
        `${marker}\n    window.__melyFaceApprovalRuntime = runtime;`,
      ),
    });
  });
  await page.addInitScript(() => {
    const uniformNames = new WeakMap();
    window.__melyFaceApprovalGl = {};
    const install = (Context) => {
      if (!Context?.prototype || Context.prototype.__melyFaceApprovalPatched) return;
      const prototype = Context.prototype;
      const getUniformLocation = prototype.getUniformLocation;
      const uniformMatrix4fv = prototype.uniformMatrix4fv;
      const uniform3f = prototype.uniform3f;
      const uniform3fv = prototype.uniform3fv;
      prototype.getUniformLocation = function getUniformLocationPatched(program, name) {
        const location = getUniformLocation.call(this, program, name);
        if (location) uniformNames.set(location, String(name).replace(/\[0\]$/, ""));
        return location;
      };
      prototype.uniformMatrix4fv = function uniformMatrix4fvPatched(location, transpose, value) {
        const name = location ? uniformNames.get(location) : undefined;
        if (name === "viewMatrix" || name === "projectionMatrix") {
          window.__melyFaceApprovalGl[name] = Array.from(value);
          window.__melyFaceApprovalGl.updatedAt = performance.now();
        }
        return uniformMatrix4fv.call(this, location, transpose, value);
      };
      prototype.uniform3f = function uniform3fPatched(location, x, y, z) {
        if (location && uniformNames.get(location) === "cameraPosition") {
          window.__melyFaceApprovalGl.cameraPosition = [x, y, z];
        }
        return uniform3f.call(this, location, x, y, z);
      };
      prototype.uniform3fv = function uniform3fvPatched(location, value) {
        if (location && uniformNames.get(location) === "cameraPosition") {
          window.__melyFaceApprovalGl.cameraPosition = Array.from(value).slice(0, 3);
        }
        return uniform3fv.call(this, location, value);
      };
      Object.defineProperty(prototype, "__melyFaceApprovalPatched", { value: true });
    };
    install(window.WebGLRenderingContext);
    install(window.WebGL2RenderingContext);

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

  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60_000 });
    report.cameraInstrumentation = viewportInstrumentation;
    if (viewportInstrumentation.replacements !== 1) {
      throw new Error(`Viewport camera instrumentation failed: ${JSON.stringify(viewportInstrumentation)}`);
    }
    await settleFrames(page, 3);
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 }).catch(() => undefined);
    await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });
    report.modelName = await page.locator(".model-summary__header strong").innerText();
    report.modelFormat = await page.locator(".model-summary__header small").innerText();
    report.modelStats = await page.locator(".model-stat-grid").innerText();

    const heightInput = page.locator(".slider-number input").first();
    await heightInput.fill(String(targetHeight));
    await heightInput.press("Enter");
    await page.getByRole("button", { name: "Solid sculpture", exact: false }).click();
    await field(page, "Voxel structure").locator("select").selectOption("shell");
    await setRange(field(page, "Alpha threshold").locator('input[type="range"]'), 0.3);
    await setRange(field(page, "Thin-surface compensation").locator('input[type="range"]'), 0.08);
    await field(page, "Block palette").locator("select").selectOption("clean");
    await field(page, "Block material theme").locator("select").selectOption("original");
    await setRange(field(page, "Color dithering").locator('input[type="range"]'), 0);
    await setSwitch(page, "Map emissive materials", true);
    await setSwitch(page, "Skin protection", true);
    await setSwitch(page, "Exclude gravity blocks", true);
    await setSwitch(page, "Exclude rare blocks", true);
    await page.getByRole("button", { name: "Perspective view", exact: true }).click();
    for (const name of ["Show grid", "Show voxel bounds"]) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.evaluate((element) => element.classList.contains("icon-button--active"))) {
        await button.click();
      }
    }
    report.fixedOptions = {
      fillMode: "shell",
      alphaThreshold: 0.3,
      thicknessCompensation: 0.08,
      palettePreset: "clean",
      materialTheme: "original",
      dithering: 0,
      emissiveMapping: true,
      skinProtection: true,
      excludeGravity: true,
      excludeRare: true,
      cameraMode: "perspective",
      grid: false,
      bounds: false,
    };

    for (const variant of variants) {
      await field(page, "Facial detail").locator("select").selectOption(variant);
      const startedAt = Date.now();
      await generateSolid(page);
      const generationMs = Date.now() - startedAt;
      const projection = await summarizeProjection(page, variant);
      captures[variant] = {};
      const views = {};
      for (const definition of viewDefinitions) {
        const camera = await establishView(
          page,
          definition.id,
          projection.faceFrame,
          report.cameraRecipes,
        );
        const capture = await captureCanvas(page, `${variant}-${definition.id}.png`);
        captures[variant][definition.id] = capture;
        views[definition.id] = {
          camera: comparableCamera(camera),
          screenshot: {
            path: capture.path,
            sha256: capture.sha256,
            byteLength: capture.byteLength,
            pixelSize: capture.pixelSize,
            cssBounds: capture.cssBounds,
          },
        };
      }
      report.variants[variant] = { generationMs, projection, views };
    }

    const coordinateHashes = variants.map((variant) => report.variants[variant].projection.coordinateCanonicalHash);
    const coordinateBufferHashes = variants.map((variant) => report.variants[variant].projection.coordinateBufferHash);
    const blockCounts = variants.map((variant) => report.variants[variant].projection.blockCount);
    const cameraConsistency = {};
    for (const definition of viewDefinitions) {
      const baseline = report.variants.off.views[definition.id].camera;
      cameraConsistency[definition.id] = Object.fromEntries(["balanced", "strong"].map((variant) => {
        const candidate = report.variants[variant].views[definition.id].camera;
        return [variant, {
          maximumViewMatrixDelta: maxMatrixDelta(baseline.viewMatrix, candidate.viewMatrix),
          maximumProjectionMatrixDelta: maxMatrixDelta(
            baseline.projectionMatrix,
            candidate.projectionMatrix,
          ),
          positionDelta: Math.hypot(...baseline.position.map(
            (value, index) => value - candidate.position[index],
          )),
        }];
      }));
    }
    const pixelDifferences = {};
    for (const definition of viewDefinitions) {
      const off = captures.off[definition.id].bytes;
      const balanced = captures.balanced[definition.id].bytes;
      const strong = captures.strong[definition.id].bytes;
      pixelDifferences[definition.id] = {
        offToBalanced: await imageDifference(page, off, balanced),
        offToStrong: await imageDifference(page, off, strong),
        balancedToStrong: await imageDifference(page, balanced, strong),
      };
    }
    report.comparisons = {
      coordinateHashes,
      coordinateBufferHashes,
      blockCounts,
      stateHashes: Object.fromEntries(variants.map((variant) => [
        variant,
        report.variants[variant].projection.stateHash,
      ])),
      cameraConsistency,
      pixelDifferences,
      faceChanges: {
        balanced: report.variants.balanced.projection.comparisonToOff,
        strong: report.variants.strong.projection.comparisonToOff,
      },
    };
    report.sheet = await createApprovalSheet(browser, captures, report);

    const allCameraMatches = Object.values(cameraConsistency).every((view) => (
      Object.values(view).every((comparison) => (
        comparison.maximumViewMatrixDelta <= 1e-6
        && comparison.maximumProjectionMatrixDelta <= 1e-9
        && comparison.positionDelta <= 1e-5
      ))
    ));
    const balancedChange = report.variants.balanced.projection.comparisonToOff;
    const strongChange = report.variants.strong.projection.comparisonToOff;
    report.assertions = {
      realModelLoaded: report.modelFormat === "PMX" && report.modelName.length > 0,
      nineApprovalScreenshots: variants.every((variant) => (
        viewDefinitions.every((view) => report.variants[variant].views[view.id].screenshot.byteLength > 0)
      )),
      equalBlockCounts: blockCounts[0] > 0 && new Set(blockCounts).size === 1,
      coordinateCanonicalHashesMatch: new Set(coordinateHashes).size === 1,
      coordinateBufferHashesMatch: new Set(coordinateBufferHashes).size === 1,
      noCoordinateAdditionsOrRemovals: [balancedChange, strongChange].every((change) => (
        change.missingCoordinates === 0 && change.addedCoordinates === 0
      )),
      faceFrameMatches: JSON.stringify(report.variants.off.projection.faceFrame)
        === JSON.stringify(report.variants.balanced.projection.faceFrame)
        && JSON.stringify(report.variants.off.projection.faceFrame)
          === JSON.stringify(report.variants.strong.projection.faceFrame),
      stateHashesDiffer: new Set(Object.values(report.comparisons.stateHashes)).size === 3,
      balancedChangesVisibleFace: balancedChange.visibleFace.changedVisibleFaceCells > 0,
      strongChangesVisibleFace: strongChange.visibleFace.changedVisibleFaceCells
        >= balancedChange.visibleFace.changedVisibleFaceCells,
      camerasMatchWithinEachView: allCameraMatches,
      comparisonSheetCreated: report.sheet.byteLength > 0,
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
    };
    report.status = Object.values(report.assertions).every(Boolean) ? "passed" : "failed";
    if (report.status !== "passed") {
      const failures = Object.entries(report.assertions)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      throw new Error(`Face approval assertions failed: ${failures.join(", ")}`);
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
      sheet: report.sheet,
      error: report.error,
    }, null, 2)}\n`);
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
