const { chromium } = require("playwright");
const { writeFile } = require("node:fs/promises");

const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const yawDrag = Number(process.env.MELY_FACE_YAW_DRAG || 0);

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const report = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));

  try {
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
    await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 120000 }).catch(() => undefined);
    await page.waitForFunction(
      () => document.querySelector("canvas") && document.body.innerText.includes("PMX"),
      null,
      { timeout: 120000 },
    );

    const focusButton = page.getByRole("button", { name: /聚焦面部|Focus face|顔にフォーカス/ });
    report.focusEnabled = await focusButton.isEnabled();
    await focusButton.click();
    await page.waitForTimeout(800);

    const canvas = page.locator("canvas").first();
    if (yawDrag !== 0) {
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("Canvas bounds are unavailable");
      const startX = bounds.x + bounds.width * 0.5;
      const startY = bounds.y + bounds.height * 0.5;
      await page.mouse.move(startX, startY);
      await page.mouse.down({ button: "left" });
      await page.mouse.move(startX + yawDrag, startY, { steps: 48 });
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(800);
      report.yawDrag = yawDrag;
    }
    const screenshot = await canvas.screenshot({ type: "png" });
    await writeFile(yawDrag ? "test-face-focus-source-opposite.png" : "test-face-focus-source.png", screenshot);
    report.canvas = await canvas.boundingBox();
    report.body = (await page.locator("body").innerText()).slice(-700);
  } finally {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
