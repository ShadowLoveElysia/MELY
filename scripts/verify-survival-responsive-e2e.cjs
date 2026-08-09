const { createHash } = require("node:crypto");
const { mkdir, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const { chromium } = require(process.env.MELY_PLAYWRIGHT_MODULE || "playwright");

const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4217/";
const modelZip = process.env.MELY_MODEL_ZIP;
const browserPath = process.env.MELY_BROWSER_PATH;
const targetHeight = Number(process.env.MELY_TARGET_HEIGHT || 320);
const supportBlockCount = Number(process.env.MELY_SUPPORT_BLOCK_COUNT || 3457);
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY || join(projectRoot, "release-validation/survival-responsive-e2e"),
);
const reportPath = resolve(process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"));
const viewports = [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "1024x680", width: 1024, height: 680 },
  { id: "390x844", width: 390, height: 844, touch: true },
];

if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");
if (!Number.isInteger(targetHeight) || targetHeight < 32 || targetHeight > 384) {
  throw new Error("MELY_TARGET_HEIGHT must be an integer from 32 to 384");
}
if (!Number.isSafeInteger(supportBlockCount) || supportBlockCount <= 0) {
  throw new Error("MELY_SUPPORT_BLOCK_COUNT must be a positive safe integer");
}

const delay = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const number = new Intl.NumberFormat("en-US");
const parseNumber = (text) => Number(String(text).replace(/[^\d-]/g, ""));

const addAssertion = (report, name, passed, details) => {
  report.assertions[name] = Boolean(passed);
  if (!passed) report.failures.push({ assertion: name, details });
};

const screenshot = async (page, report, name) => {
  const path = join(outputDirectory, `${name}.png`);
  const bytes = await page.screenshot({ path, type: "png" });
  report.screenshots[name] = { path, sha256: sha256(bytes), bytes: bytes.byteLength };
};

const auditIconButtonLabels = async (page, scopeSelector = "body") => page.evaluate((selector) => {
  const scope = document.querySelector(selector);
  if (!(scope instanceof HTMLElement)) throw new Error(`Accessibility scope is unavailable: ${selector}`);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  return [...scope.querySelectorAll("button")]
    .filter((button) => visible(button))
    .filter((button) => !(button.textContent ?? "").trim())
    .map((button) => ({
      ariaLabel: button.getAttribute("aria-label") ?? "",
      title: button.getAttribute("title") ?? "",
      className: button.className,
    }));
}, scopeSelector);

const auditModalKeyboard = async (page, trigger, dialog) => {
  const triggerId = `mely-a11y-trigger-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await trigger.evaluate((element, id) => element.setAttribute("data-mely-a11y-trigger", id), triggerId);
  await trigger.focus();
  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
    return modal instanceof HTMLElement && modal.contains(document.activeElement);
  });

  const focusable = await dialog.evaluate((modal) => {
    const selector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const elements = [...modal.querySelectorAll(selector)]
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
    elements.forEach((element, index) => element.setAttribute("data-mely-a11y-index", String(index)));
    return elements.map((element, index) => ({
      index,
      label: element.getAttribute("aria-label")
        || element.getAttribute("title")
        || element.textContent?.trim()
        || element.tagName,
    }));
  });
  if (!focusable.length) throw new Error("Modal does not expose a focusable control");

  const first = dialog.locator('[data-mely-a11y-index="0"]');
  const last = dialog.locator(`[data-mely-a11y-index="${focusable.length - 1}"]`);
  await last.focus();
  await page.keyboard.press("Tab");
  const wrapsForward = await first.evaluate((element) => document.activeElement === element);
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  const wrapsBackward = await last.evaluate((element) => document.activeElement === element);
  const focusStayedInside = await dialog.evaluate((modal) => modal.contains(document.activeElement));

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction((id) => (
    document.activeElement?.getAttribute("data-mely-a11y-trigger") === id
  ), triggerId);
  const focusReturned = await trigger.evaluate((element) => document.activeElement === element);
  await trigger.evaluate((element) => element.removeAttribute("data-mely-a11y-trigger"));

  return {
    initialFocusWasInside: true,
    focusable,
    wrapsForward,
    wrapsBackward,
    focusStayedInside,
    escapeClosed: true,
    focusReturned,
  };
};

const captureProjectionResult = async (page) => {
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
};

const generateRealProjection = async (page, report) => {
  const startedAt = Date.now();
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".locale-control select").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(".locale-control select").selectOption("en-US");
  await page.evaluate(() => localStorage.clear());

  await page.locator('input[type="file"][accept*=".pmx"]').setInputFiles(modelZip);
  await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout: 180_000 }).catch(() => undefined);
  await page.locator(".model-summary").waitFor({ state: "visible", timeout: 180_000 });
  report.modelName = await page.locator(".model-summary__header strong").innerText();
  report.timingsMs.modelLoad = Date.now() - startedAt;

  const heightInput = page.locator(".slider-number input").first();
  await heightInput.fill(String(targetHeight));
  await heightInput.press("Enter");
  report.actualHeight = Number(await heightInput.inputValue());

  const generationStartedAt = Date.now();
  const generate = page.getByRole("button", { name: "Generate hologram", exact: true });
  if (!await generate.isEnabled()) throw new Error("Generate hologram is disabled");
  await generate.click();
  await page.waitForFunction(() => {
    const result = window.__melyProjectionResult;
    const exportButton = document.querySelector(".export-button");
    return result
      && result.kind !== "solid"
      && !document.querySelector(".progress-block")
      && exportButton instanceof HTMLButtonElement
      && !exportButton.disabled;
  }, null, { timeout: 600_000 });
  report.timingsMs.generation = Date.now() - generationStartedAt;
};

const coreAudit = async (page) => page.evaluate(async ({ supportBlockCount }) => {
  const result = window.__melyProjectionResult;
  if (!result || result.kind === "solid") throw new Error("Hologram projection result is unavailable");

  const projectionModule = await import("/src/core/projectionDocument.ts");
  const survivalModule = await import("/src/components/survivalToolsModel.ts");
  const layerModule = await import("/src/core/layerGuide.ts");
  const document = projectionModule.createProjectionDocumentFromResult(result, {
    edition: "java",
    minecraftVersion: "1.20.1",
    metadata: { name: "MELY survival audit", targetHeight: 320 },
  });
  const basePlan = survivalModule.createProjectionMaterialPlan(document);
  const supportPlan = survivalModule.createProjectionMaterialPlan(document, {
    includeSupportBlocks: true,
    supportBlockId: "minecraft:cobblestone",
    supportBlockCount,
  });

  const summarizePlan = (plan) => ({
    totalBlocks: plan.totalBlocks,
    totalStorageSlots: plan.totalStorageSlots,
    totalLargeChests: plan.totalLargeChests,
    totalShulkerBoxes: plan.totalShulkerBoxes,
    requirements: plan.requirements.map((entry) => ({ ...entry })),
    chests: plan.chests.map((chest) => ({
      index: chest.index,
      usedSlots: chest.usedSlots,
      freeSlots: chest.freeSlots,
      allocations: chest.allocations.map((allocation) => ({ ...allocation })),
    })),
  });

  const directCounts = new Map();
  for (const material of result.materials) {
    const blockId = material === 0
      ? "minecraft:end_rod"
      : material === 1
        ? "minecraft:white_stained_glass_pane"
        : `unknown:${material}`;
    directCounts.set(blockId, (directCounts.get(blockId) ?? 0) + 1);
  }
  const projectionCounts = new Map(basePlan.requirements.map((entry) => [entry.blockId, entry.count]));
  const materialCountsMatch = directCounts.size === projectionCounts.size
    && [...directCounts].every(([blockId, count]) => projectionCounts.get(blockId) === count);

  const breakdownsRecompose = supportPlan.requirements.every((entry) => (
    entry.count === entry.shulkerBoxes * 27 * entry.stackSize
      + entry.stacks * entry.stackSize
      + entry.looseItems
    && entry.stacks >= 0
    && entry.stacks < 27
    && entry.looseItems >= 0
    && entry.looseItems < entry.stackSize
  ));
  const allocationCounts = new Map();
  let chestSlotsValid = true;
  for (const chest of supportPlan.chests) {
    let expectedStart = 1;
    let usedSlots = 0;
    for (const allocation of chest.allocations) {
      allocationCounts.set(
        allocation.blockId,
        (allocationCounts.get(allocation.blockId) ?? 0) + allocation.itemCount,
      );
      const stackSize = supportPlan.requirements.find((entry) => entry.blockId === allocation.blockId)?.stackSize ?? 64;
      chestSlotsValid = chestSlotsValid
        && allocation.startSlot === expectedStart
        && allocation.slotCount === Math.ceil(allocation.itemCount / stackSize)
        && allocation.itemCount === allocation.fullStacks * stackSize + allocation.looseItems
        && allocation.looseItems >= 0
        && allocation.looseItems < stackSize;
      expectedStart += allocation.slotCount;
      usedSlots += allocation.slotCount;
    }
    chestSlotsValid = chestSlotsValid
      && usedSlots === chest.usedSlots
      && chest.usedSlots + chest.freeSlots === 54
      && chest.usedSlots <= 54;
  }
  const allocationsConserved = supportPlan.requirements.every((entry) => (
    allocationCounts.get(entry.blockId) === entry.count
  )) && [...allocationCounts.values()].reduce((sum, count) => sum + count, 0) === supportPlan.totalBlocks;
  const mixedCategoryChests = supportPlan.chests.filter((chest) => (
    new Set(chest.allocations.map((allocation) => allocation.category)).size > 1
  )).map((chest) => ({
    index: chest.index,
    categories: [...new Set(chest.allocations.map((allocation) => allocation.category))],
    blocks: chest.allocations.map((allocation) => allocation.blockId),
  }));
  const mixedSupportChests = supportPlan.chests.filter((chest) => {
    const categories = new Set(chest.allocations.map((allocation) => allocation.category));
    return categories.has("support") && categories.size > 1;
  }).map((chest) => ({
    index: chest.index,
    categories: [...new Set(chest.allocations.map((allocation) => allocation.category))],
    blocks: chest.allocations.map((allocation) => allocation.blockId),
  }));

  const layerInput = survivalModule.createProjectionLayerInput(document);
  const fixedIndex = { x: 0, y: 1, z: 2 };
  const summarizeSlice = (slice) => ({
    coordinate: slice.coordinate,
    uAxis: slice.uAxis,
    vAxis: slice.vAxis,
    bounds: slice.bounds,
    blockCount: slice.blockCount,
    legend: slice.legend.map((entry) => ({
      blockId: entry.paletteEntry.blockId,
      paletteIndex: entry.paletteIndex,
      count: entry.count,
    })),
    firstPixel: slice.pixels[0]
      ? {
          position: [...slice.pixels[0].position],
          u: slice.pixels[0].u,
          v: slice.pixels[0].v,
        }
      : null,
  });
  const axes = {};
  for (const axis of ["x", "y", "z"]) {
    const coordinates = [...layerModule.listOccupiedLayerCoordinates(layerInput, axis)];
    let sliceBlockTotal = 0;
    let coordinateMismatches = 0;
    let legendMismatches = 0;
    const seenSources = new Set();
    const aggregateLegend = new Map();
    for (const coordinate of coordinates) {
      const slice = layerModule.createLayerGuideSlice(layerInput, axis, coordinate);
      sliceBlockTotal += slice.blockCount;
      const legendTotal = slice.legend.reduce((sum, entry) => sum + entry.count, 0);
      if (legendTotal !== slice.blockCount) legendMismatches += 1;
      for (const entry of slice.legend) {
        const blockId = entry.paletteEntry.blockId;
        aggregateLegend.set(blockId, (aggregateLegend.get(blockId) ?? 0) + entry.count);
      }
      for (const pixel of slice.pixels) {
        if (pixel.position[fixedIndex[axis]] !== coordinate) coordinateMismatches += 1;
        seenSources.add(pixel.sourceIndex);
      }
    }
    const firstCoordinate = coordinates[0] ?? 0;
    const nextCoordinate = coordinates[1] ?? null;
    const middleCoordinate = coordinates[Math.floor(coordinates.length / 2)] ?? firstCoordinate;
    const lastCoordinate = coordinates.at(-1) ?? firstCoordinate;
    const sampleCoordinates = [...new Set([firstCoordinate, middleCoordinate, lastCoordinate])];
    axes[axis] = {
      coordinateCount: coordinates.length,
      firstCoordinate,
      nextCoordinate,
      lastCoordinate,
      sliceBlockTotal,
      uniqueSourceCount: seenSources.size,
      coordinateMismatches,
      legendMismatches,
      aggregateLegend: [...aggregateLegend].sort(([left], [right]) => left.localeCompare(right)),
      samples: sampleCoordinates.map((coordinate) => summarizeSlice(
        layerModule.createLayerGuideSlice(layerInput, axis, coordinate),
      )),
      firstSlice: summarizeSlice(layerModule.createLayerGuideSlice(layerInput, axis, firstCoordinate)),
      nextSlice: nextCoordinate === null
        ? null
        : summarizeSlice(layerModule.createLayerGuideSlice(layerInput, axis, nextCoordinate)),
    };
  }

  return {
    projection: {
      resultBlockCount: result.positions.length / 3,
      documentBlockCount: document.blockCount,
      bounds: document.bounds,
      palette: document.palette,
      directCounts: [...directCounts].sort(([left], [right]) => left.localeCompare(right)),
      projectionCounts: [...projectionCounts].sort(([left], [right]) => left.localeCompare(right)),
    },
    basePlan: summarizePlan(basePlan),
    supportPlan: summarizePlan(supportPlan),
    checks: {
      materialCountsMatch,
      breakdownsRecompose,
      allocationsConserved,
      chestSlotsValid,
      supportIncluded: supportPlan.requirements.some((entry) => (
        entry.blockId === "minecraft:cobblestone"
          && entry.category === "support"
          && entry.count === supportBlockCount
      )),
      categoryPureChests: mixedCategoryChests.length === 0,
      supportChestsIsolated: mixedSupportChests.length === 0,
    },
    mixedCategoryChests,
    mixedSupportChests,
    axes,
    layerIndexStats: survivalModule.getProjectionLayerIndexStats(layerInput),
  };
}, { supportBlockCount });

const materialUi = async (page) => page.evaluate(() => ({
  summary: [...document.querySelectorAll(".survival-summary > div")].map((entry) => ({
    value: entry.querySelector("strong")?.textContent?.trim() ?? "",
    label: entry.querySelector("span")?.textContent?.trim() ?? "",
  })),
  rows: [...document.querySelectorAll(".survival-table tbody tr")].map((row) => ({
    blockId: row.querySelector("code")?.textContent?.trim() ?? "",
    cells: [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() ?? ""),
  })),
}));

const verifyMaterialUi = (actual, plan) => {
  const expectedSummary = [
    plan.totalBlocks,
    plan.requirements.length,
    plan.totalLargeChests,
    plan.totalShulkerBoxes,
  ];
  const summaryMatches = actual.summary.length === expectedSummary.length
    && actual.summary.every((entry, index) => parseNumber(entry.value) === expectedSummary[index]);
  const rowById = new Map(actual.rows.map((row) => [row.blockId, row]));
  const rowsMatch = plan.requirements.every((requirement) => {
    const row = rowById.get(requirement.blockId);
    if (!row || row.cells.length < 4) return false;
    const expectedBreakdown = `${number.format(requirement.shulkerBoxes)} boxes + ${number.format(requirement.stacks)} stacks + ${number.format(requirement.looseItems)} items`;
    return parseNumber(row.cells[2]) === requirement.count && row.cells[3] === expectedBreakdown;
  });
  return { summaryMatches, rowsMatch, expectedSummary, actual };
};

const collectChestUi = async (page) => {
  await page.getByRole("tab", { name: "Chest planner", exact: true }).click();
  const chests = [];
  let pageCount = 0;
  while (true) {
    pageCount += 1;
    const visible = await page.locator(".chest-item").evaluateAll((items) => items.map((item) => ({
      index: Number(item.querySelector("strong")?.textContent?.match(/\d[\d,]*/)?.[0]?.replaceAll(",", "") ?? 0),
      allocations: [...item.querySelectorAll(".chest-allocations > div")].map((allocation) => {
        const spans = [...allocation.querySelectorAll("span")];
        return {
          blockId: allocation.querySelector("code")?.textContent?.trim() ?? "",
          itemCount: Number(spans.at(-1)?.textContent?.match(/\d[\d,]*/)?.[0]?.replaceAll(",", "") ?? 0),
        };
      }),
    })));
    chests.push(...visible);
    const next = page.getByRole("button", { name: "Next chest page", exact: true });
    if (await next.count() === 0 || await next.isDisabled()) break;
    await next.click();
    if (pageCount > 100) throw new Error("Chest pagination did not terminate");
  }
  return { chests, pagesVisited: pageCount };
};

const verifyChestUi = (actual, plan) => {
  const chestsMatch = actual.chests.length === plan.chests.length
    && plan.chests.every((expected, index) => {
      const observed = actual.chests[index];
      return observed?.index === expected.index
        && observed.allocations.length === expected.allocations.length
        && expected.allocations.every((allocation, allocationIndex) => (
          observed.allocations[allocationIndex]?.blockId === allocation.blockId
            && observed.allocations[allocationIndex]?.itemCount === allocation.itemCount
        ));
    });
  return { chestsMatch, actual };
};

const layerUiSnapshot = async (page) => page.evaluate(() => ({
  coordinate: Number(document.querySelector(".layer-coordinate-input input")?.value),
  progress: document.querySelector(".layer-progress-row > span:first-child")?.textContent?.trim() ?? "",
  blocks: document.querySelector(".layer-progress-row > span:nth-child(2)")?.textContent?.trim() ?? "",
  completed: Boolean(document.querySelector(".layer-progress-row input[type=checkbox]")?.checked),
  legend: [...document.querySelectorAll(".layer-legend > div")].map((entry) => ({
    blockId: entry.querySelector("code")?.textContent?.trim() ?? "",
    count: Number(entry.querySelector("span:last-child")?.textContent?.replace(/[^\d-]/g, "") ?? 0),
  })),
}));

const moveToLayerPixel = async (page, sample) => {
  if (!sample.bounds || !sample.firstPixel) return null;
  const canvas = page.locator(".layer-canvas-host canvas");
  const box = await canvas.boundingBox();
  if (!box) return null;
  const padding = 38;
  const availableWidth = Math.max(1, box.width - padding * 2);
  const availableHeight = Math.max(1, box.height - padding * 2);
  const scale = Math.max(Number.EPSILON, Math.min(
    38,
    availableWidth / sample.bounds.dimensions[0],
    availableHeight / sample.bounds.dimensions[1],
  ));
  const contentWidth = sample.bounds.dimensions[0] * scale;
  const contentHeight = sample.bounds.dimensions[1] * scale;
  const originX = (box.width - contentWidth) / 2;
  const originY = (box.height - contentHeight) / 2;
  const clientX = box.x + originX + (sample.firstPixel.u - sample.bounds.min[0] + 0.5) * scale;
  const clientY = box.y + originY + (sample.bounds.max[1] - sample.firstPixel.v + 0.5) * scale;
  await page.mouse.move(clientX, clientY);
  const hover = page.locator(".layer-hover");
  await hover.waitFor({ state: "visible", timeout: 5_000 });
  return hover.innerText();
};

const verifyLayerUi = async (page, core) => {
  await page.getByRole("tab", { name: "Layer guide", exact: true }).click();
  const report = {};
  for (const axis of ["x", "y", "z"]) {
    const expected = core.axes[axis];
    await page.getByRole("button", { name: `${axis.toUpperCase()} axis`, exact: true }).click();
    const coordinateInput = page.locator(".layer-coordinate-input input");
    await coordinateInput.fill(String(expected.firstCoordinate));
    await page.waitForFunction((coordinate) => (
      Number(document.querySelector(".layer-coordinate-input input")?.value) === coordinate
    ), expected.firstCoordinate);
    await delay(120);
    const first = await layerUiSnapshot(page);
    const expectedLegend = new Map(expected.firstSlice.legend.map((entry) => [entry.blockId, entry.count]));
    const legendMatches = first.legend.length === expectedLegend.size
      && first.legend.every((entry) => expectedLegend.get(entry.blockId) === entry.count);
    const hoverText = await moveToLayerPixel(page, expected.firstSlice);
    const positionText = expected.firstSlice.firstPixel
      ? `X ${expected.firstSlice.firstPixel.position[0]} · Y ${expected.firstSlice.firstPixel.position[1]} · Z ${expected.firstSlice.firstPixel.position[2]}`
      : null;
    await page.mouse.move(1, 1);

    const previous = page.getByRole("button", { name: "Previous occupied slice", exact: true });
    const next = page.getByRole("button", { name: "Next occupied slice", exact: true });
    const previousDisabledAtFirst = await previous.isDisabled();
    let nextCoordinate = null;
    if (expected.nextCoordinate !== null) {
      await next.click();
      await page.waitForFunction((coordinate) => (
        Number(document.querySelector(".layer-coordinate-input input")?.value) === coordinate
      ), expected.nextCoordinate);
      nextCoordinate = Number(await coordinateInput.inputValue());
      await coordinateInput.fill(String(expected.firstCoordinate));
    }

    const completed = page.locator(".layer-progress-row input[type=checkbox]");
    await completed.check();
    await page.waitForFunction(() => document.querySelector(".layer-progress-row > span:first-child")?.textContent?.includes("1 /"));
    const afterCompletion = await layerUiSnapshot(page);
    report[axis] = {
      first,
      expectedFirst: expected.firstSlice,
      legendMatches,
      hoverText,
      positionText,
      hoverMatches: positionText === null || hoverText?.includes(positionText),
      previousDisabledAtFirst,
      expectedNextCoordinate: expected.nextCoordinate,
      nextCoordinate,
      nextNavigationMatches: expected.nextCoordinate === nextCoordinate,
      completionMatches: afterCompletion.completed
        && afterCompletion.progress.includes(`1 / ${number.format(expected.coordinateCount)}`),
      afterCompletion,
    };
  }
  return report;
};

const overflowAndControls = async (page) => page.evaluate(() => {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const dialog = document.querySelector(".survival-tools");
  if (!(dialog instanceof HTMLElement)) throw new Error("Survival dialog is unavailable");
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const clippedByScroller = (element) => {
    let current = element.parentElement;
    while (current && current !== dialog) {
      const style = getComputedStyle(current);
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) return true;
      current = current.parentElement;
    }
    return false;
  };
  const horizontalOffenders = [...dialog.querySelectorAll("*")]
    .filter((element) => visible(element))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return (rect.left < -1 || rect.right > viewportWidth + 1) && !clippedByScroller(element);
    })
    .slice(0, 20)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        text: element.textContent?.trim().slice(0, 100) ?? "",
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      };
    });
  const controls = [...dialog.querySelectorAll("button, input, select, [role=tab]")]
    .filter((element) => visible(element));
  const outsideControls = [];
  const occludedControls = [];
  for (const element of controls) {
    const rect = element.getBoundingClientRect();
    const label = element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.textContent?.trim().slice(0, 80)
      || element.tagName;
    if (rect.left < -1 || rect.right > viewportWidth + 1 || rect.top < -1 || rect.bottom > viewportHeight + 1) {
      outsideControls.push({ label, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      continue;
    }
    const centerX = Math.min(viewportWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const centerY = Math.min(viewportHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(centerX, centerY);
    if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) {
      occludedControls.push({ label, hit: hit.tagName, hitClass: hit.className });
    }
  }
  const internalScrollers = [...dialog.querySelectorAll("*")]
    .filter((element) => element.scrollWidth > element.clientWidth + 1)
    .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowX))
    .map((element) => ({
      className: typeof element.className === "string" ? element.className : "",
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  const dialogRect = dialog.getBoundingClientRect();
  return {
    viewportWidth,
    viewportHeight,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    dialogRect: {
      left: dialogRect.left,
      right: dialogRect.right,
      top: dialogRect.top,
      bottom: dialogRect.bottom,
    },
    horizontalOffenders,
    outsideControls,
    occludedControls,
    internalScrollers,
    noPageOverflow: document.documentElement.scrollWidth <= viewportWidth + 1
      && document.body.scrollWidth <= viewportWidth + 1
      && dialogRect.left >= -1
      && dialogRect.right <= viewportWidth + 1,
    controlsReachable: outsideControls.length === 0 && occludedControls.length === 0,
  };
});

const touchNextLayer = async (page, expected) => {
  await page.getByRole("tab", { name: "Layer guide", exact: true }).tap();
  await page.getByRole("button", { name: "Y axis", exact: true }).tap();
  const coordinate = page.locator(".layer-coordinate-input input");
  await coordinate.fill(String(expected.firstCoordinate));
  if (expected.nextCoordinate === null) return { skipped: true, reason: "Only one Y layer is occupied" };
  const next = page.getByRole("button", { name: "Next occupied slice", exact: true });
  const box = await next.boundingBox();
  if (!box) throw new Error("Mobile next-layer control is not visible");
  const before = Number(await coordinate.inputValue());
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction((value) => (
    Number(document.querySelector(".layer-coordinate-input input")?.value) === value
  ), expected.nextCoordinate);
  return {
    pointer: "touchscreen.tap",
    before,
    after: Number(await coordinate.inputValue()),
    expected: expected.nextCoordinate,
  };
};

const runResponsiveAudit = async (page, report, core) => {
  const tabNames = ["Material list", "Chest planner", "Layer guide"];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await delay(160);
    const viewportReport = { tabs: {} };
    for (const tabName of tabNames) {
      const tab = page.getByRole("tab", { name: tabName, exact: true });
      if (viewport.touch) await tab.tap();
      else await tab.click();
      await delay(100);
      viewportReport.tabs[tabName] = await overflowAndControls(page);
    }
    if (viewport.touch) {
      viewportReport.touchLayerSwitch = await touchNextLayer(page, core.axes.y);
    }
    await page.getByRole("tab", { name: "Material list", exact: true }).click();
    await screenshot(page, report, `${viewport.id}-materials`);
    await page.getByRole("tab", { name: "Layer guide", exact: true }).click();
    await screenshot(page, report, `${viewport.id}-layers`);
    if (viewport.id === "1440x900") {
      await page.getByRole("tab", { name: "Chest planner", exact: true }).click();
      await screenshot(page, report, `${viewport.id}-chests`);
    }
    viewportReport.noPageOverflow = Object.values(viewportReport.tabs).every((entry) => entry.noPageOverflow);
    viewportReport.noUnclippedHorizontalOffenders = Object.values(viewportReport.tabs)
      .every((entry) => entry.horizontalOffenders.length === 0);
    viewportReport.controlsReachable = Object.values(viewportReport.tabs)
      .every((entry) => entry.controlsReachable);
    report.viewports[viewport.id] = viewportReport;
  }
};

const verifyProgressPersistence = async (page, core) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".survival-header > button").click();
  await page.locator(".survival-tools").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Survival building guide", exact: true }).click();
  await page.locator(".survival-tools").waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Layer guide", exact: true }).click();
  const axes = {};
  for (const axis of ["x", "y", "z"]) {
    await page.getByRole("button", { name: `${axis.toUpperCase()} axis`, exact: true }).click();
    const snapshot = await layerUiSnapshot(page);
    axes[axis] = {
      ...snapshot,
      persisted: snapshot.progress.includes(`1 / ${number.format(core.axes[axis].coordinateCount)}`),
    };
  }
  return {
    axes,
    allPersisted: Object.values(axes).every((entry) => entry.persisted),
    storage: await page.evaluate(() => Object.keys(localStorage)
      .filter((key) => key.startsWith("mely:survival-guide:v1:"))
      .sort()
      .map((key) => ({ key, value: localStorage.getItem(key) }))),
  };
};

const run = async () => {
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    appUrl,
    modelZip,
    targetHeight,
    supportBlockCount,
    consoleErrors: [],
    pageErrors: [],
    timingsMs: {},
    assertions: {},
    failures: [],
    screenshots: {},
    viewports: {},
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await captureProjectionResult(page);

  try {
    await generateRealProjection(page, report);
    report.core = await coreAudit(page);
    addAssertion(report, "targetHeightIs320", report.actualHeight === targetHeight, {
      expected: targetHeight,
      actual: report.actualHeight,
    });
    addAssertion(
      report,
      "projectionBlockCountConserved",
      report.core.projection.resultBlockCount === report.core.projection.documentBlockCount
        && report.core.basePlan.totalBlocks === report.core.projection.documentBlockCount,
      report.core.projection,
    );
    addAssertion(report, "materialCountsConserved", report.core.checks.materialCountsMatch, {
      direct: report.core.projection.directCounts,
      planned: report.core.projection.projectionCounts,
    });
    addAssertion(report, "shulkerStackLooseRecompose", report.core.checks.breakdownsRecompose, {
      requirements: report.core.supportPlan.requirements,
    });
    addAssertion(report, "supportCountIncluded", report.core.checks.supportIncluded, {
      supportBlockCount,
      requirements: report.core.supportPlan.requirements,
    });
    addAssertion(report, "chestAllocationsConserved", report.core.checks.allocationsConserved, {
      totalBlocks: report.core.supportPlan.totalBlocks,
      chests: report.core.supportPlan.chests,
    });
    addAssertion(report, "chestSlotsValid", report.core.checks.chestSlotsValid, {
      chests: report.core.supportPlan.chests,
    });
    addAssertion(report, "categoryPureChests", report.core.checks.categoryPureChests, {
      mixedCategoryChests: report.core.mixedCategoryChests,
    });
    addAssertion(report, "supportChestsIsolated", report.core.checks.supportChestsIsolated, {
      mixedSupportChests: report.core.mixedSupportChests,
    });
    for (const axis of ["x", "y", "z"]) {
      const data = report.core.axes[axis];
      addAssertion(report, `${axis}AllLayersConserveBlocks`, (
        data.sliceBlockTotal === report.core.projection.documentBlockCount
          && data.uniqueSourceCount === report.core.projection.documentBlockCount
          && data.coordinateMismatches === 0
          && data.legendMismatches === 0
      ), data);
      addAssertion(report, `${axis}AggregateLegendConserved`, (
        JSON.stringify(data.aggregateLegend) === JSON.stringify(report.core.projection.projectionCounts)
      ), {
        aggregateLegend: data.aggregateLegend,
        projectionCounts: report.core.projection.projectionCounts,
      });
    }

    const heightUnlock = page.locator(".height-unlock");
    report.accessibility = {
      iconButtons: {
        base: await auditIconButtonLabels(page),
      },
      heightDialog: await auditModalKeyboard(
        page,
        heightUnlock,
        page.getByRole("dialog", { name: "Extended-height warning" }),
      ),
    };
    addAssertion(report, "heightDialogFocusTrap", (
      report.accessibility.heightDialog.initialFocusWasInside
        && report.accessibility.heightDialog.wrapsForward
        && report.accessibility.heightDialog.wrapsBackward
        && report.accessibility.heightDialog.focusStayedInside
        && report.accessibility.heightDialog.escapeClosed
        && report.accessibility.heightDialog.focusReturned
    ), report.accessibility.heightDialog);

    const survivalTrigger = page.getByRole("button", { name: "Survival building guide", exact: true });
    report.accessibility.survivalDialog = await auditModalKeyboard(
      page,
      survivalTrigger,
      page.getByRole("dialog", { name: "Survival building guide" }),
    );
    addAssertion(report, "survivalDialogFocusTrap", (
      report.accessibility.survivalDialog.initialFocusWasInside
        && report.accessibility.survivalDialog.wrapsForward
        && report.accessibility.survivalDialog.wrapsBackward
        && report.accessibility.survivalDialog.focusStayedInside
        && report.accessibility.survivalDialog.escapeClosed
        && report.accessibility.survivalDialog.focusReturned
    ), report.accessibility.survivalDialog);

    await survivalTrigger.click();
    await page.locator(".survival-tools").waitFor({ state: "visible" });
    report.accessibility.iconButtons.survival = await auditIconButtonLabels(page, ".survival-tools");
    const unlabeledIconButtons = [
      ...report.accessibility.iconButtons.base,
      ...report.accessibility.iconButtons.survival,
    ].filter((button) => !button.ariaLabel || !button.title);
    addAssertion(report, "iconButtonsHaveLocalizedLabelsAndTooltips", unlabeledIconButtons.length === 0, {
      unlabeledIconButtons,
      scans: report.accessibility.iconButtons,
    });
    report.materialUiBase = verifyMaterialUi(await materialUi(page), report.core.basePlan);
    addAssertion(report, "baseMaterialUiMatchesPlan", (
      report.materialUiBase.summaryMatches && report.materialUiBase.rowsMatch
    ), report.materialUiBase);

    const supportCheckbox = page.locator(".survival-planning-options input[type=checkbox]");
    await supportCheckbox.check();
    const supportCountInput = page.locator(".survival-support-count input");
    await supportCountInput.fill(String(supportBlockCount));
    await page.waitForFunction((expected) => {
      const value = document.querySelector(".survival-summary > div:first-child strong")?.textContent ?? "";
      return Number(value.replace(/[^\d-]/g, "")) === expected;
    }, report.core.supportPlan.totalBlocks);
    report.materialUiWithSupport = verifyMaterialUi(await materialUi(page), report.core.supportPlan);
    addAssertion(report, "supportMaterialUiMatchesPlan", (
      report.materialUiWithSupport.summaryMatches && report.materialUiWithSupport.rowsMatch
    ), report.materialUiWithSupport);

    report.chestUi = verifyChestUi(await collectChestUi(page), report.core.supportPlan);
    addAssertion(report, "chestUiMatchesPlan", report.chestUi.chestsMatch, report.chestUi);

    report.layerUi = await verifyLayerUi(page, report.core);
    for (const axis of ["x", "y", "z"]) {
      const data = report.layerUi[axis];
      addAssertion(report, `${axis}LayerUiMatches`, (
        data.first.coordinate === report.core.axes[axis].firstCoordinate
          && parseNumber(data.first.blocks) === report.core.axes[axis].firstSlice.blockCount
          && data.legendMatches
          && data.hoverMatches
          && data.previousDisabledAtFirst
          && data.nextNavigationMatches
          && data.completionMatches
      ), data);
    }

    await runResponsiveAudit(page, report, report.core);
    for (const viewport of viewports) {
      const data = report.viewports[viewport.id];
      addAssertion(report, `${viewport.id}NoPageOverflow`, data.noPageOverflow, data);
      addAssertion(report, `${viewport.id}NoUnclippedHorizontalOffenders`, data.noUnclippedHorizontalOffenders, data);
      addAssertion(report, `${viewport.id}ControlsReachable`, data.controlsReachable, data);
      if (viewport.touch) {
        addAssertion(report, `${viewport.id}TouchLayerSwitch`, (
          !data.touchLayerSwitch.skipped
            && data.touchLayerSwitch.after === data.touchLayerSwitch.expected
            && data.touchLayerSwitch.before !== data.touchLayerSwitch.after
        ), data.touchLayerSwitch);
      }
    }

    report.progressPersistence = await verifyProgressPersistence(page, report.core);
    addAssertion(report, "layerProgressPersistsAcrossReopen", report.progressPersistence.allPersisted, {
      progressPersistence: report.progressPersistence,
    });
    addAssertion(report, "noConsoleErrors", report.consoleErrors.length === 0, report.consoleErrors);
    addAssertion(report, "noPageErrors", report.pageErrors.length === 0, report.pageErrors);
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.passed = !report.error && report.failures.length === 0;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      reportPath,
      passed: report.passed,
      error: report.error,
      failures: report.failures,
      screenshots: report.screenshots,
    }, null, 2)}\n`);
    await context.close();
    await browser.close();
  }

  if (report.error) throw new Error(report.error);
  if (report.failures.length) {
    throw new Error(`Survival/responsive assertions failed: ${report.failures.map((entry) => entry.assertion).join(", ")}`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
