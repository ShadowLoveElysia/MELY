const { chromium } = require("playwright");

const appUrl = process.env.MELY_URL || "http://127.0.0.1:4199/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;

const overflowReport = async (page) => page.evaluate(() => {
  const viewportWidth = document.documentElement.clientWidth;
  const offenders = [...document.querySelectorAll("body *")]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
    })
    .slice(0, 12)
    .map((element) => ({
      className: element.className,
      tag: element.tagName,
      text: element.textContent?.trim().slice(0, 80),
    }));
  return {
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth,
    offenders,
  };
});

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const report = { consoleErrors: [], pageErrors: [] };
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    desktop.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    desktop.on("pageerror", (error) => report.pageErrors.push(error.message));
    await desktop.goto(appUrl, { waitUntil: "networkidle" });
    await desktop.screenshot({ path: "test-desktop.png", fullPage: true });
    report.desktop = {
      title: await desktop.title(),
      overflow: await overflowReport(desktop),
      body: (await desktop.locator("body").innerText()).slice(0, 1500),
    };

    const locale = desktop.locator(".locale-control select");
    await locale.selectOption("en-US");
    report.englishVisible = await desktop.getByText("Target height", { exact: false }).first().isVisible();
    await locale.selectOption("ja-JP");
    report.japaneseText = (await desktop.locator("body").innerText()).slice(0, 350);
    await locale.selectOption("zh-CN");

    await desktop.locator(".height-unlock").click();
    report.unlockDialogVisible = await desktop.getByRole("dialog").isVisible();
    report.unlockDialogText = (await desktop.getByRole("dialog").innerText()).slice(0, 700);
    await desktop.getByRole("button", { name: /确认解锁/ }).click();
    const heightNumber = desktop.locator(".slider-number input").first();
    await heightNumber.fill("1200");
    await heightNumber.press("Enter");
    report.extendedWarningVisible = await desktop.locator(".height-warning").isVisible();
    report.extendedHeightValue = await heightNumber.inputValue();

    if (modelZip) {
      await desktop.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
      await desktop.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 120000 }).catch(() => undefined);
      await desktop.waitForFunction(() => document.body.innerText.includes("顶点") || document.body.innerText.includes("Vertices"), null, { timeout: 120000 });
      report.modelBody = (await desktop.locator("body").innerText()).slice(0, 2600);
      report.modelCanvasCount = await desktop.locator("canvas").count();
      await desktop.screenshot({ path: "test-model.png", fullPage: true });
    }

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    mobile.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(`mobile: ${message.text()}`);
    });
    mobile.on("pageerror", (error) => report.pageErrors.push(`mobile: ${error.message}`));
    await mobile.goto(appUrl, { waitUntil: "networkidle" });
    report.mobile = {
      overflow: await overflowReport(mobile),
      body: (await mobile.locator("body").innerText()).slice(0, 900),
    };
    await mobile.screenshot({ path: "test-mobile.png", fullPage: true });
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
