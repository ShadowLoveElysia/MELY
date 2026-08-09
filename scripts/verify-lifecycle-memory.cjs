const { execFile } = require("node:child_process");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");
const nbt = require("prismarine-nbt");

const execFileAsync = promisify(execFile);
const projectRoot = resolve(__dirname, "..");
const appUrl = process.env.MELY_URL || "http://127.0.0.1:4211/";
const modelZip = process.env.MELY_MODEL_ZIP;
const fixturePath = resolve(
  process.env.MELY_SWITCH_FIXTURE || join(projectRoot, "tests/fixtures/mely-input-e2e.pmd"),
);
const browserPath = process.env.MELY_BROWSER_PATH;
const playwrightPath = process.env.MELY_PLAYWRIGHT_MODULE || "playwright";
const iterations = Number(process.env.MELY_LIFECYCLE_ITERATIONS || 10);
const outputDirectory = resolve(
  process.env.MELY_OUTPUT_DIRECTORY || join(projectRoot, "release-validation/lifecycle-memory"),
);
const reportPath = resolve(
  process.env.MELY_REPORT_PATH || join(outputDirectory, "report.json"),
);
const TWO_GIB = 2 * 1024 ** 3;
const RECOVERY_RATIO_LIMIT = 1.2;
const MIB = 1024 ** 2;
const SAMPLING_INTERVAL_MS = 350;
const MEASUREMENT_MAX_ATTEMPTS = 3;
const MEASUREMENT_RETRY_DELAY_MS = 200;
const PROCESS_QUERY_TIMEOUT_MS = 10_000;

const delay = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));

const serializeError = (error) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: typeof error.code === "string" ? error.code : undefined,
    };
  }
  return { name: "Error", message: String(error) };
};

const retryOperation = async (operation, {
  maxAttempts = MEASUREMENT_MAX_ATTEMPTS,
  retryDelayMs = MEASUREMENT_RETRY_DELAY_MS,
  delayFn = delay,
  onFailure,
} = {}) => {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt, failures };
    } catch (error) {
      const failure = { attempt, maxAttempts, error };
      failures.push(failure);
      await onFailure?.(failure);
      if (attempt === maxAttempts) throw error;
      await delayFn(retryDelayMs * attempt);
    }
  }
  throw new Error("Retry loop completed without a result");
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const isRecoveryRatioWithinLimit = (ratio, limit = RECOVERY_RATIO_LIMIT) => (
  Number.isFinite(ratio)
  && Number.isFinite(limit)
  && limit > 0
  && ratio <= limit
);

const processWorkingSet = async (processInfo) => {
  const processIds = processInfo.map((process) => Number(process.id))
    .filter((processId) => Number.isInteger(processId) && processId > 0);
  if (!processIds.length) return { totalBytes: 0, byType: {}, processes: [] };
  const script = [
    `$ids = @(${processIds.join(",")})`,
    "$rows = Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ id = [int]$_.Id; workingSetBytes = [int64]$_.WorkingSet64 } }",
    "@($rows) | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const typeById = new Map(processInfo.map((process) => [Number(process.id), process.type || "unknown"]));
  const processes = rows.map((row) => ({
    id: Number(row.id),
    type: typeById.get(Number(row.id)) || "unknown",
    workingSetBytes: Number(row.workingSetBytes) || 0,
  }));
  const byType = {};
  for (const process of processes) {
    byType[process.type] = (byType[process.type] || 0) + process.workingSetBytes;
  }
  return {
    totalBytes: processes.reduce((sum, process) => sum + process.workingSetBytes, 0),
    byType,
    processes,
  };
};

const validateConfiguration = () => {
  if (!modelZip) throw new Error("MELY_MODEL_ZIP is required");
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("MELY_LIFECYCLE_ITERATIONS must be a positive integer");
  }
};

const stablePhaseValue = (samples, phase, tailCount = 10) => {
  const values = samples
    .filter((sample) => sample.phase === phase)
    .slice(-tailCount)
    .map((sample) => sample.workingSetBytes);
  return { sampleCount: values.length, medianBytes: median(values), lastBytes: values.at(-1) || 0 };
};

const metricValue = (metrics, name) => metrics.find((metric) => metric.name === name)?.value || 0;

const collectLivePageMemory = async (pageCdp) => {
  await pageCdp.send("HeapProfiler.collectGarbage");
  await delay(250);
  const [{ metrics }, counters] = await Promise.all([
    pageCdp.send("Performance.getMetrics"),
    pageCdp.send("Memory.getDOMCounters"),
  ]);
  return {
    jsHeapUsedBytes: metricValue(metrics, "JSHeapUsedSize"),
    jsHeapTotalBytes: metricValue(metrics, "JSHeapTotalSize"),
    documents: counters.documents,
    nodes: counters.nodes,
    jsEventListeners: counters.jsEventListeners,
  };
};

const linearSlope = (values) => {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    const xDelta = index - xMean;
    numerator += xDelta * (value - yMean);
    denominator += xDelta * xDelta;
  });
  return denominator > 0 ? numerator / denominator : 0;
};

const waitForModel = async (page, expectedFormat, timeout = 180_000) => {
  await page.locator(".drop-zone--loading").waitFor({ state: "hidden", timeout });
  await page.locator(".model-summary").waitFor({ state: "visible", timeout });
  await page.waitForFunction(
    (format) => document.querySelector(".model-summary__header small")?.textContent?.trim() === format,
    expectedFormat,
    { timeout },
  );
  return {
    name: await page.locator(".model-summary__header strong").innerText(),
    format: await page.locator(".model-summary__header small").innerText(),
  };
};

const loadModel = async (page, input, path, expectedFormat) => {
  await input.setInputFiles(path);
  return waitForModel(page, expectedFormat);
};

const generateProjection = async (page) => {
  const button = page.getByRole("button", { name: "Generate hologram", exact: true });
  await button.waitFor({ state: "visible" });
  if (!await button.isEnabled()) throw new Error("Hologram generation is disabled");
  await button.click();
  await page.waitForFunction(() => Boolean(document.querySelector(".progress-block")), null, {
    timeout: 15_000,
  });
  await page.waitForFunction(() => {
    const progress = document.querySelector(".progress-block");
    const exportButton = document.querySelector(".export-button");
    return !progress && exportButton instanceof HTMLButtonElement && !exportButton.disabled;
  }, null, { timeout: 300_000 });
};

const startGenerationForCancellation = async (page) => {
  await page.getByRole("button", { name: /Solid sculpture/, exact: false }).click();
  const button = page.getByRole("button", { name: "Generate solid projection", exact: true });
  if (!await button.isEnabled()) throw new Error("Cancellation probe cannot start generation");
  await button.click();
  await page.waitForFunction(() => Boolean(document.querySelector(".progress-block")), null, {
    timeout: 15_000,
  });
};

const exportLitematic = async (page, outputPath) => {
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator(".export-button").click();
  const exportDialog = page.getByRole("dialog").filter({ hasText: "Export center" });
  await exportDialog.waitFor({ state: "visible" });
  await exportDialog.getByRole("button", { name: /Litematica projection/ }).click();
  const download = await downloadPromise;
  await download.saveAs(outputPath);
  await page.waitForFunction(() => {
    const exportButton = document.querySelector(".export-button");
    return exportButton instanceof HTMLButtonElement && !exportButton.disabled;
  }, null, { timeout: 30_000 });
  const bytes = await readFile(outputPath);
  const parsed = await nbt.parse(bytes, "big");
  const root = nbt.simplify(parsed.parsed);
  if (root.Version !== 6 || root.MinecraftDataVersion !== 3465 || root.Metadata.TotalBlocks <= 0) {
    throw new Error(`Invalid Litematica export: ${JSON.stringify({
      version: root.Version,
      dataVersion: root.MinecraftDataVersion,
      blocks: root.Metadata.TotalBlocks,
    })}`);
  }
  return {
    byteLength: bytes.byteLength,
    version: root.Version,
    dataVersion: root.MinecraftDataVersion,
    blocks: root.Metadata.TotalBlocks,
    regions: root.Metadata.RegionCount,
    dimensions: root.Metadata.EnclosingSize,
  };
};

const runCycle = async ({ page, input, index, setPhase, outputDirectory }) => {
  const prefix = index === 0 ? "warmup" : `round-${index}`;
  const cycle = { index, prefix, startedAt: new Date().toISOString() };
  let startedAt = Date.now();

  setPhase(`${prefix}:complete-generation`);
  await generateProjection(page);
  cycle.generationMs = Date.now() - startedAt;

  setPhase(`${prefix}:export`);
  startedAt = Date.now();
  cycle.export = await exportLitematic(page, join(outputDirectory, `${prefix}.litematic`));
  cycle.exportMs = Date.now() - startedAt;

  setPhase(`${prefix}:start-cancel`);
  await startGenerationForCancellation(page);
  cycle.cancelProgressObserved = true;

  setPhase(`${prefix}:switch-to-fixture`);
  startedAt = Date.now();
  cycle.fixture = await loadModel(page, input, fixturePath, "PMD");
  cycle.switchToFixtureMs = Date.now() - startedAt;
  cycle.cancelledByReplacement = await page.locator(".progress-block").count() === 0;

  setPhase(`${prefix}:switch-to-real`);
  startedAt = Date.now();
  cycle.real = await loadModel(page, input, modelZip, "PMX");
  cycle.switchToRealMs = Date.now() - startedAt;
  await page.getByRole("button", { name: /Ethereal hologram/, exact: false }).click();
  cycle.finishedAt = new Date().toISOString();
  return cycle;
};

const run = async () => {
  validateConfiguration();
  const { chromium } = require(playwrightPath);
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    appUrl,
    modelZip,
    fixturePath,
    iterations,
    memoryLimitBytes: TWO_GIB,
    recoveryRatioLimit: RECOVERY_RATIO_LIMIT,
    consoleErrors: [],
    pageErrors: [],
    samples: [],
    measurementErrors: [],
    measurementRecoveredFailureCount: 0,
    sampling: {
      status: "running",
      intervalMs: SAMPLING_INTERVAL_MS,
      maxAttemptsPerOperation: MEASUREMENT_MAX_ATTEMPTS,
      retryDelayMs: MEASUREMENT_RETRY_DELAY_MS,
      sampleAttempts: 0,
      successfulSamples: 0,
      recoveredFailureCount: 0,
      errors: [],
      terminalError: null,
    },
    phasePeaks: {},
    phaseTypePeaks: {},
    cycles: [],
    checkpoints: [],
    peakWorkingSetBytes: 0,
  };

  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const browserCdp = await browser.newBrowserCDPSession();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const pageCdp = await page.context().newCDPSession(page);
  await pageCdp.send("Performance.enable");
  await pageCdp.send("HeapProfiler.enable");
  page.setDefaultTimeout(180_000);
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));

  let phase = "startup";
  let sampling = true;
  let samplingError;
  const recordMeasurement = async ({ scope, source }, operation) => {
    const operationErrors = [];
    try {
      const result = await retryOperation(operation, {
        onFailure: ({ attempt, maxAttempts, error }) => {
          const entry = {
            timestamp: new Date().toISOString(),
            elapsedMs: Date.now() - Date.parse(report.generatedAt),
            phase,
            scope,
            source,
            attempt,
            maxAttempts,
            recovered: false,
            error: serializeError(error),
          };
          operationErrors.push(entry);
          report.measurementErrors.push(entry);
          if (scope === "sampler") report.sampling.errors.push(entry);
        },
      });
      for (const entry of operationErrors) entry.recovered = true;
      report.measurementRecoveredFailureCount += operationErrors.length;
      if (scope === "sampler") {
        report.sampling.recoveredFailureCount += operationErrors.length;
      }
      return result.value;
    } catch (error) {
      const wrapped = new Error(
        `${source} failed after ${MEASUREMENT_MAX_ATTEMPTS} attempts: ${serializeError(error).message}`,
        { cause: error },
      );
      wrapped.measurementSource = source;
      throw wrapped;
    }
  };
  const assertSamplerHealthy = (checkpoint) => {
    if (!samplingError) return;
    throw new Error(
      `Memory sampler failed before ${checkpoint}: ${serializeError(samplingError).message}`,
      { cause: samplingError },
    );
  };
  const assertPhaseSamples = (value, phaseName, minimum = 5) => {
    if (value.sampleCount < minimum || value.medianBytes <= 0) {
      throw new Error(`Insufficient ${phaseName} samples: ${JSON.stringify(value)}`);
    }
  };
  const setPhase = (value) => {
    phase = value;
  };
  const sampler = (async () => {
    while (sampling) {
      try {
        report.sampling.sampleAttempts += 1;
        const { processInfo } = await recordMeasurement(
          { scope: "sampler", source: "cdp.SystemInfo.getProcessInfo" },
          async () => {
            const result = await browserCdp.send("SystemInfo.getProcessInfo");
            if (!Array.isArray(result.processInfo) || result.processInfo.length === 0) {
              throw new Error("CDP returned an empty browser process tree");
            }
            return result;
          },
        );
        const workingSet = await recordMeasurement(
          { scope: "sampler", source: "powershell.Get-Process" },
          async () => {
            const result = await processWorkingSet(processInfo);
            if (result.processes.length === 0 || result.totalBytes <= 0) {
              throw new Error("PowerShell returned no live browser working-set data");
            }
            return result;
          },
        );
        report.samples.push({
          elapsedMs: Date.now() - Date.parse(report.generatedAt),
          phase,
          processCount: workingSet.processes.length,
          workingSetBytes: workingSet.totalBytes,
          workingSetByType: workingSet.byType,
        });
        report.sampling.successfulSamples += 1;
        report.peakWorkingSetBytes = Math.max(report.peakWorkingSetBytes, workingSet.totalBytes);
        report.phasePeaks[phase] = Math.max(report.phasePeaks[phase] || 0, workingSet.totalBytes);
        const phaseTypes = report.phaseTypePeaks[phase] || {};
        for (const [type, bytes] of Object.entries(workingSet.byType)) {
          phaseTypes[type] = Math.max(phaseTypes[type] || 0, bytes);
        }
        report.phaseTypePeaks[phase] = phaseTypes;
      } catch (error) {
        samplingError = error;
        report.sampling.status = "failed";
        report.sampling.terminalError = {
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - Date.parse(report.generatedAt),
          phase,
          source: error?.measurementSource || "sampler",
          error: serializeError(error),
        };
        break;
      }
      await delay(SAMPLING_INTERVAL_MS);
    }
  })();

  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".locale-control select").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".locale-control select").selectOption("en-US");
    const input = page.locator('input[type="file"][accept*=".pmx"]');

    setPhase("initial-model-load");
    report.initialModel = await loadModel(page, input, modelZip, "PMX");

    report.warmup = await runCycle({ page, input, index: 0, setPhase, outputDirectory });

    setPhase("baseline-settle");
    await delay(10_000);
    assertSamplerHealthy("baseline-settle");
    report.baseline = stablePhaseValue(report.samples, "baseline-settle");
    assertPhaseSamples(report.baseline, "baseline-settle");
    report.baseline.livePageMemory = await recordMeasurement(
      { scope: "checkpoint", source: "cdp.livePageMemory.baseline" },
      () => collectLivePageMemory(pageCdp),
    );
    assertSamplerHealthy("baseline checkpoint");
    report.checkpoints.push({
      name: "baseline",
      index: 0,
      workingSet: report.baseline,
      livePageMemory: report.baseline.livePageMemory,
    });
    for (let index = 1; index <= iterations; index += 1) {
      const cycle = await runCycle({ page, input, index, setPhase, outputDirectory });
      setPhase(`${cycle.prefix}:settle`);
      await delay(5_000);
      assertSamplerHealthy(`${cycle.prefix}:settle`);
      cycle.settledWorkingSet = stablePhaseValue(report.samples, `${cycle.prefix}:settle`, 6);
      assertPhaseSamples(cycle.settledWorkingSet, `${cycle.prefix}:settle`);
      cycle.livePageMemory = await recordMeasurement(
        { scope: "checkpoint", source: `cdp.livePageMemory.${cycle.prefix}` },
        () => collectLivePageMemory(pageCdp),
      );
      assertSamplerHealthy(`${cycle.prefix} checkpoint`);
      report.checkpoints.push({
        name: cycle.prefix,
        index,
        workingSet: cycle.settledWorkingSet,
        livePageMemory: cycle.livePageMemory,
      });
      report.cycles.push(cycle);
    }

    setPhase("recovery");
    await delay(30_000);
    assertSamplerHealthy("recovery");
    report.recovery = stablePhaseValue(report.samples, "recovery");
    assertPhaseSamples(report.recovery, "recovery");
    report.recovery.livePageMemory = await recordMeasurement(
      { scope: "checkpoint", source: "cdp.livePageMemory.recovery" },
      () => collectLivePageMemory(pageCdp),
    );
    assertSamplerHealthy("recovery checkpoint");
    report.recoveryRatio = report.recovery.medianBytes / report.baseline.medianBytes;
    report.recoveryRatioWithinLimit = isRecoveryRatioWithinLimit(report.recoveryRatio);
    report.warmup.peakWorkingSetBytes = Math.max(0, ...report.samples
      .filter((sample) => sample.phase.startsWith("warmup:"))
      .map((sample) => sample.workingSetBytes));
    report.cycles.forEach((cycle) => {
      cycle.peakWorkingSetBytes = Math.max(0, ...report.samples
        .filter((sample) => sample.phase.startsWith(`${cycle.prefix}:`))
        .map((sample) => sample.workingSetBytes));
    });
    report.underTwoGiB = report.peakWorkingSetBytes < TWO_GIB;
    report.workingSetPeakRecoveryRatio = report.recovery.medianBytes / report.peakWorkingSetBytes;
    report.recoveredFromPeak = report.recovery.sampleCount >= 5
      && report.recovery.medianBytes <= report.peakWorkingSetBytes * 0.9;
    const heapAllowance = Math.max(
      report.baseline.livePageMemory.jsHeapUsedBytes * 1.2,
      report.baseline.livePageMemory.jsHeapUsedBytes + 32 * MIB,
    );
    report.liveHeapRecovered = report.recovery.livePageMemory.jsHeapUsedBytes <= heapAllowance;
    const trendCheckpoints = report.checkpoints.slice(Math.max(0, report.checkpoints.length - 5));
    report.workingSetTrendBytesPerCycle = linearSlope(
      trendCheckpoints.map((checkpoint) => checkpoint.workingSet.medianBytes),
    );
    report.liveHeapTrendBytesPerCycle = linearSlope(
      trendCheckpoints.map((checkpoint) => checkpoint.livePageMemory.jsHeapUsedBytes),
    );
    report.workingSetTrendStable = iterations < 3
      || report.workingSetTrendBytesPerCycle <= 32 * MIB;
    report.liveHeapTrendStable = iterations < 3
      || report.liveHeapTrendBytesPerCycle <= 8 * MIB;
    report.assertions = {
      iterationsCompleted: report.cycles.length === iterations,
      everyCancellationObserved: report.cycles.every((cycle) => (
        cycle.cancelProgressObserved && cycle.cancelledByReplacement
      )),
      everyExportParsed: report.cycles.every((cycle) => (
        cycle.export?.version === 6
        && cycle.export?.dataVersion === 3465
        && cycle.export?.blocks > 0
      )),
      noConsoleErrors: report.consoleErrors.length === 0,
      noPageErrors: report.pageErrors.length === 0,
      samplingHealthy: !samplingError,
      everyCheckpointSampled: report.checkpoints.every((checkpoint) => (
        checkpoint.workingSet.sampleCount >= 5
        && checkpoint.workingSet.medianBytes > 0
      )),
      underTwoGiB: report.underTwoGiB,
      recoveryRatioWithinLimit: report.recoveryRatioWithinLimit,
      recoveredFromPeak: report.recoveredFromPeak,
      liveHeapRecovered: report.liveHeapRecovered,
      workingSetTrendStable: report.workingSetTrendStable,
      liveHeapTrendStable: report.liveHeapTrendStable,
    };
    if (!Object.values(report.assertions).every(Boolean)) {
      throw new Error(`Lifecycle assertions failed: ${JSON.stringify(report.assertions)}`);
    }
    await page.screenshot({ path: join(outputDirectory, "final.png"), fullPage: true });
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    sampling = false;
    await sampler;
    if (report.sampling.status === "running") report.sampling.status = "stopped";
    report.sampling.finishedAt = new Date().toISOString();
    if (samplingError) {
      report.samplingError = serializeError(samplingError);
      if (report.assertions) report.assertions.samplingHealthy = false;
      if (!report.error) {
        report.error = `${report.samplingError.name}: ${report.samplingError.message}`;
      }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      reportPath,
      error: report.error,
      peakWorkingSetBytes: report.peakWorkingSetBytes,
      baseline: report.baseline,
      recovery: report.recovery,
      recoveryRatio: report.recoveryRatio,
      recoveryRatioLimit: report.recoveryRatioLimit,
      recoveryRatioWithinLimit: report.recoveryRatioWithinLimit,
      workingSetPeakRecoveryRatio: report.workingSetPeakRecoveryRatio,
      workingSetTrendBytesPerCycle: report.workingSetTrendBytesPerCycle,
      liveHeapTrendBytesPerCycle: report.liveHeapTrendBytesPerCycle,
      sampling: report.sampling,
      samplingError: report.samplingError,
      assertions: report.assertions,
    }, null, 2)}\n`);
    await browser.close();
  }

  if (samplingError) throw samplingError;
};

module.exports = {
  RECOVERY_RATIO_LIMIT,
  isRecoveryRatioWithinLimit,
  retryOperation,
  serializeError,
  stablePhaseValue,
};

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
