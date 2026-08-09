const { existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");
const { writePmdFixtureSet } = require("./fixtures/generate-minimal-pmd.cjs");
const { writeComplexVmd } = require("./fixtures/generate-complex-vmd.cjs");

const projectRoot = resolve(__dirname, "..");
const outputPath = resolve(
  process.env.MELY_INPUT_AUDIT_OUTPUT
    || join(projectRoot, "release-validation/mmd-input-audit/report.json"),
);
const outputRoot = dirname(outputPath);
const fixtureDirectory = join(outputRoot, "fixture-package");
const motionPath = join(outputRoot, "mely-complex-motion-e2e.vmd");
const appUrl = process.env.MELY_INPUT_AUDIT_URL
  || "http://127.0.0.1:4208/scripts/audits/mmd-core.html";
const edgePath = process.env.MELY_EDGE_PATH
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const playwrightPath = process.env.MELY_PLAYWRIGHT_PATH
  || join(
    process.env.USERPROFILE || "",
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );

const reportBase = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  appUrl,
  fixtureDirectory,
  motionPath,
  consoleErrors: [],
  pageErrors: [],
};

const writeReport = async (report) => {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
};

const approx = (value, expected, tolerance = 1e-4) => (
  Number.isFinite(value) && Math.abs(value - expected) <= tolerance
);

const morphWeight = (frame, name) => frame.morphs.find((morph) => morph.name === name)?.weight;

const main = async () => {
  if (!existsSync(edgePath)) throw new Error(`Edge path does not exist: ${edgePath}`);
  if (!existsSync(playwrightPath)) throw new Error(`Playwright path does not exist: ${playwrightPath}`);
  await mkdir(outputRoot, { recursive: true });
  const fixtures = await writePmdFixtureSet(fixtureDirectory);
  const motionFixture = await writeComplexVmd(motionPath);

  const { chromium } = require(playwrightPath);
  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(120_000);
    page.on("console", (message) => {
      if (message.type() === "error") reportBase.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => reportBase.pageErrors.push(error.message));
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => window.__melyAuditReady === true);
    await page.locator("#folder-files").setInputFiles(fixtureDirectory);
    await page.locator("#complex-motion-file").setInputFiles(motionPath);
    const audit = await page.evaluate(async () => window.__melyRunFixtureAudit());

    const frame15Smile = morphWeight(audit.frames.frame15, "smile");
    const frame30Smile = morphWeight(audit.frames.frame30, "smile");
    const poseSmile = audit.frames.frame30.pose.morphs?.find((morph) => morph.name === "smile")?.weight;
    const assertions = {
      folderPathsPreserved: audit.package.paths.length === 2
        && audit.package.paths.every((path) => path.includes("fixture-package/")),
      twoPmdCandidates: audit.package.candidateCount === 2,
      characterSelectedFirst: /character\.pmd$/i.test(audit.package.primaryPath),
      pmdLoaded: audit.primary.stats.format === "pmd"
        && audit.primary.stats.vertexCount === 16
        && audit.primary.stats.boneCount === 5,
      missingTextureWarning: audit.primary.stats.textureWarnings >= 1
        && audit.primary.textureWarnings.some((warning) => warning.includes("missing.png")),
      complexMotionTracks: audit.motion.maxFrame === 30
        && audit.motion.boneTrackCount === 4
        && audit.motion.morphTrackCount === 1,
      frame15Morph: approx(frame15Smile, 0.5),
      frame30Morph: approx(frame30Smile, 1),
      frame0DiffersFrom15: audit.frames.differences.frame0To15.changedVertices > 0,
      frame15DiffersFrom30: audit.frames.differences.frame15To30.changedVertices > 0,
      poseContainsSmile: approx(poseSmile, 1),
      poseContainsAnimatedBones: audit.frames.frame30.pose.bones.some((bone) => bone.name === "upper")
        && audit.frames.frame30.pose.bones.some((bone) => bone.name === "root"),
      ikGoalAccepted: audit.manualIk.changed === true,
      ikChangedLink: audit.manualIk.changedLinks > 0,
      ikChangedVertices: audit.manualIk.vertexDifference.changedVertices > 0,
      accessorySwitched: /accessory\.pmd$/i.test(audit.switch.selectedPath)
        && audit.switch.stats.name === "MELY Accessory"
        && audit.switch.stats.morphCount === 0,
      previousModelDisposed: audit.switch.previousModelDisposed === true,
      browserClean: reportBase.consoleErrors.length === 0 && reportBase.pageErrors.length === 0,
    };
    const status = Object.values(assertions).every(Boolean) ? "passed" : "failed";
    const report = {
      ...reportBase,
      status,
      fixtures,
      motionFixture,
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
  await writeReport({
    ...reportBase,
    status: "failed",
    failure: error instanceof Error ? error.stack || error.message : String(error),
  }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
