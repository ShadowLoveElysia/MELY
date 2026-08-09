const { mkdir, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const outputPath = resolve(
  process.env.MELY_AUDIT_OUTPUT
    || join(projectRoot, "release-validation/mmd-core-audit/report.json"),
);
const modelPath = resolve(process.env.MELY_AUDIT_MODEL || "");
const motionPath = resolve(
  process.env.MELY_AUDIT_MOTION
    || join(projectRoot, "tests/fixtures/mely-motion-e2e.vmd"),
);
const appUrl = process.env.MELY_AUDIT_URL
  || "http://127.0.0.1:4199/scripts/audits/mmd-core.html";
const edgePath = process.env.MELY_EDGE_PATH
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const playwrightPath = process.env.MELY_PLAYWRIGHT_PATH
  || join(
    process.env.USERPROFILE || "",
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );

const baseReport = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  appUrl,
  modelPath,
  motionPath,
  edgePath,
  scope: {
    minimumLinearSamples: 1000,
    requestedLinearSamples: 4096,
    maximumErrorTolerance: 1e-4,
    realModelReference: [
      "THREE.SkinnedMesh.getVertexPosition",
      "Explicit bind/morph/weighted-bone BDEF formula",
    ],
    nonlinearCoverage: "SDEF, QDEF, sparse morph, and morph-before-skinning are validated by mmdSnapshot.test.ts.",
    limitation: "Three.js getVertexPosition uses linear skinning and is not a valid numerical reference for MMD SDEF or QDEF vertices.",
  },
  consoleErrors: [],
  pageErrors: [],
};

const writeReport = async (report) => {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
};

const fail = async (message, details = {}) => {
  const report = { ...baseReport, status: "failed", failure: message, ...details };
  await writeReport(report);
  throw new Error(message);
};

const main = async () => {
  if (!process.env.MELY_AUDIT_MODEL) {
    await fail("MELY_AUDIT_MODEL is required");
  }
  for (const [label, path] of [["model", modelPath], ["motion", motionPath], ["Edge", edgePath]]) {
    if (!existsSync(path)) await fail(`${label} path does not exist: ${path}`);
  }
  if (!existsSync(playwrightPath)) await fail(`Playwright path does not exist: ${playwrightPath}`);

  const { chromium } = require(playwrightPath);
  const browser = await chromium.launch({
    headless: true,
    executablePath: edgePath,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(240_000);
    page.on("console", (message) => {
      if (message.type() === "error") baseReport.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => baseReport.pageErrors.push(error.message));

    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => window.__melyAuditReady === true);
    await page.locator("#model-files").setInputFiles(modelPath);
    await page.locator("#motion-file").setInputFiles(motionPath);
    const audit = await page.evaluate(async () => window.__melyRunSnapshotAudit({
      sampleCount: 4096,
      targetFrame: 30,
    }));

    const assertions = {
      minimumSampleCount: audit.references.three.sampleCount >= baseReport.scope.minimumLinearSamples,
      threeMaximumError: audit.references.three.maximumError <= audit.references.three.tolerance,
      manualMaximumError: audit.references.manualBdef.maximumError <= audit.references.manualBdef.tolerance,
      poseChanged: audit.poseDifference.changedVertices > 0,
    };
    const status = Object.values(assertions).every(Boolean) ? "passed" : "failed";
    const report = {
      ...baseReport,
      status,
      assertions,
      audit,
    };
    await writeReport(report);
    process.stdout.write(`${JSON.stringify({ outputPath, status, assertions }, null, 2)}\n`);
    if (status !== "passed") process.exitCode = 1;
  } finally {
    await browser.close();
  }
};

main().catch(async (error) => {
  if (!existsSync(outputPath)) {
    await writeReport({
      ...baseReport,
      status: "failed",
      failure: error instanceof Error ? error.stack || error.message : String(error),
    }).catch(() => undefined);
  }
  console.error(error);
  process.exitCode = 1;
});
