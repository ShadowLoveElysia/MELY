import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("4064 product flow wires three distinct confirmations and final fingerprints", async () => {
  const [app, sidebar] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/components/Sidebar.tsx", "utf8"),
  ]);

  assert.match(sidebar, /onExperimentalHeightUnlock/);
  assert.doesNotMatch(sidebar, /disabled=\{!extendedHeightAvailable\}/);
  assert.doesNotMatch(sidebar, /disabled=\{!experimentalHeightAvailable\}/);
  assert.match(app, /confirmExtremeUnlock\(/);
  assert.match(app, /confirmExtremeEnvironment\(/);
  assert.match(app, /confirmExtremeExport\(/);
  assert.match(app, /createExtremeHeightConfigurationFingerprint\(/);
  assert.match(app, /createExtremeExportFingerprint\(/);
  assert.match(app, /extremeExportPhraseInput/);
  assert.match(app, /clearExtremeExportConfirmation/);
  assert.match(app, /confirmations: extremeConfirmationsRef\.current/);
  assert.match(app, /const checked = event\.currentTarget\.checked;[\s\S]*?\[key\]: checked/);
  assert.doesNotMatch(app, /\[key\]: event\.currentTarget\.checked/);
  assert.match(app, /contentHash\?: string/);
  assert.match(app, /projectionDocumentRef\.current\.contentHash !== pendingExport\.resultId/);
  assert.doesNotMatch(app, /documentResultId\(projectionDocumentRef\.current\.document\)/);
});

test("registered versions keep generation and both height unlock controls actionable", async () => {
  const [app, sidebar] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/components/Sidebar.tsx", "utf8"),
  ]);

  assert.doesNotMatch(app, /generationDisabledReason=/);
  assert.doesNotMatch(app, /maximumVerifiedHeight/);
  assert.doesNotMatch(app, /extendedHeightVerification/);
  assert.doesNotMatch(sidebar, /generationDisabledReason/);
  assert.doesNotMatch(sidebar, /extendedHeightAvailable/);
  assert.doesNotMatch(sidebar, /experimentalHeightAvailable/);
  assert.match(sidebar, /role="status"/);
  assert.match(sidebar, /onClick=\{onExtendedHeightToggle\}/);
  assert.match(sidebar, /onClick=\{onExperimentalHeightUnlock\}/);
  assert.match(sidebar, /disabled=\{!modelStats \|\| processing \|\| modelLoading \|\| !motionReady\}/);
});

test("2032 and 4064 unlock actions initialize a complete dimension declaration", async () => {
  const app = await readFile("src/App.tsx", "utf8");

  assert.match(app, /const unlockExtendedHeight = \(\) => \{[\s\S]*?setHeightMode\("extended_2032"\);[\s\S]*?setTargetDimensionMinY\(-1024\);[\s\S]*?setTargetDimensionHeight\(EXTENDED_WORLD_HEIGHT\);[\s\S]*?setPlacementBottomY\(-1024\);/);
  assert.match(app, /const beginExtremeHeightUnlock = \(\) => \{[\s\S]*?setTargetDimensionMinY\(-2032\);[\s\S]*?setTargetDimensionHeight\(EXPERIMENTAL_WORLD_HEIGHT\);[\s\S]*?setPlacementBottomY\(-2032\);[\s\S]*?setExtremeDialogStage\("unlock"\);/);
  assert.match(app, /disabled: !currentExtremeFingerprint/);
  assert.match(app, /disabled: !Object\.values\(extremeEnvironmentChecks\)\.every\(Boolean\)/);
});

test("experimental preflight can enter its final confirmation dialog", async () => {
  const app = await readFile("src/App.tsx", "utf8");
  assert.match(app, /preflight\.reason === "HEIGHT_EXTREME_CONFIRMATION_REQUIRED"/);
  assert.match(app, /!preflight\.allowed && !needsExtremeExportConfirmation/);
  assert.match(app, /!preflight\.allowed && !awaitsExtremeConfirmation/);
});
