const { chromium } = require("playwright");

const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const targetHeight = process.env.MELY_TARGET_HEIGHT || "320";
const faceDetail = process.env.MELY_FACE_DETAIL || "off";

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
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

  try {
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 120000 }).catch(() => undefined);
    await page.waitForFunction(
      () => document.querySelector("canvas") && document.body.innerText.includes("PMX"),
      null,
      { timeout: 120000 },
    );

    const heightInput = page.locator(".slider-number input").first();
    await heightInput.fill(targetHeight);
    await heightInput.press("Enter");
    await page.locator('.mode-option[aria-pressed="false"]').click();
    await page.locator(".field-row").filter({
      hasText: /面部细节|Facial detail|顔のディテール/,
    }).locator("select").selectOption(faceDetail);
    await page.locator(".primary-button").click();
    await page.locator(".progress-block").waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".progress-block").waitFor({ state: "hidden", timeout: 180000 });

    const report = await page.evaluate(() => {
      const result = window.__melyProjectionResult;
      if (!result || result.kind !== "solid" || !result.faceFrame) return { available: false };
      const frame = result.faceFrame;
      const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
      const paletteCounts = new Map();
      const cells = new Map();
      let faceBlocks = 0;
      let eyeBandBlocks = 0;

      for (let index = 0; index < result.blockIndices.length; index += 1) {
        const relative = [
          result.positions[index * 3] - frame.origin[0],
          result.positions[index * 3 + 1] - frame.origin[1],
          result.positions[index * 3 + 2] - frame.origin[2],
        ];
        const horizontal = dot(relative, frame.right) / frame.eyeDistance;
        const vertical = dot(relative, frame.up) / frame.eyeDistance;
        const depth = dot(relative, frame.forward) / frame.eyeDistance;
        if (
          Math.abs(horizontal) > 1.75
          || vertical < -2.05
          || vertical > 1.2
          || depth < -1.5
          || depth > 1.45
        ) continue;

        faceBlocks += 1;
        const paletteIndex = result.blockIndices[index];
        const blockId = result.palette[paletteIndex]?.blockId || `unknown:${paletteIndex}`;
        paletteCounts.set(blockId, (paletteCounts.get(blockId) || 0) + 1);
        if (vertical >= -0.75 && vertical <= 0.9) eyeBandBlocks += 1;

        const tangentHorizontal = Math.round(horizontal * frame.eyeDistance);
        const tangentVertical = Math.round(vertical * frame.eyeDistance);
        const key = `${tangentHorizontal},${tangentVertical}`;
        const existing = cells.get(key);
        if (!existing || depth > existing.depth) {
          cells.set(key, {
            horizontal,
            vertical,
            depth,
            blockId,
            position: [
              result.positions[index * 3],
              result.positions[index * 3 + 1],
              result.positions[index * 3 + 2],
            ],
          });
        }
      }

      const visiblePalette = new Map();
      for (const cell of cells.values()) {
        visiblePalette.set(cell.blockId, (visiblePalette.get(cell.blockId) || 0) + 1);
      }
      const sortCounts = (map) => [...map.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 30);
      const eyeCells = [...cells.values()]
        .filter((cell) => cell.vertical >= -0.75 && cell.vertical <= 0.9)
        .sort((left, right) => left.horizontal - right.horizontal || right.depth - left.depth)
        .slice(0, 120);
      return {
        available: true,
        faceFrame: frame,
        bounds: result.bounds,
        blockCount: result.stats.blockCount,
        faceBlocks,
        eyeBandBlocks,
        frontCellCount: cells.size,
        paletteCounts: sortCounts(paletteCounts),
        visiblePalette: sortCounts(visiblePalette),
        eyeCells,
      };
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
