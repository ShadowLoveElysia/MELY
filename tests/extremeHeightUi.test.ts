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
  assert.match(app, /requiredHeight: "requiredHeight" in preflight[\s\S]*?\? preflight\.requiredHeight/);
  assert.match(app, /targetDimensionHeight: typeof document\.metadata\?\.targetDimensionMinY/);
  assert.match(app, /extendedExport\.projectionHeight/);
  assert.match(app, /extremeExportPhrase\(pendingExport\.requiredHeight\)/);
  assert.doesNotMatch(app, /pendingExport\.safetyHeight/);
  assert.match(app, /const invalidateExtremeAuthorization = useCallback/);
  assert.match(app, /const \[extremeDialogOrigin, setExtremeDialogOrigin\]/);
  assert.match(app, /if \(extremeDialogOrigin === "reconfirm"\) return/);
  assert.match(app, /experimentalHeightConfirmed=\{extremeEnvironmentConfirmed\}/);
  assert.match(sidebar, /sidebar\.scale\.experimental4064Reconfirm/);
  assert.doesNotMatch(app, /if \(heightMode === "experimental_4064"\) \{[\s\S]{0,320}?setHeightMode\("extended_2032"\)/);
  assert.doesNotMatch(app, /if \(heightMode === "experimental_4064"\) \{[\s\S]{0,420}?Math\.min\([\s\S]*?EXTENDED_WORLD_HEIGHT/);
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
  assert.match(app, /const needsExtremeEnvironmentConfirmation = !isBedrockExportFormat\(format\)/);
  assert.match(app, /!hasExtremeEnvironmentConfirmation\(/);
  assert.match(app, /setExtremeDialogOrigin\("reconfirm"\);[\s\S]*?setExtremeDialogStage\("unlock"\)/);
  assert.match(app, /!preflight\.allowed && !needsExtremeExportConfirmation/);
  assert.match(app, /!preflight\.allowed && !awaitsExtremeConfirmation/);
});

test("final confirmation distinguishes projection height from declared world height", async () => {
  const [app, zh, en, ja] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/i18n/locales/zh-CN.ts", "utf8"),
    readFile("src/i18n/locales/en-US.ts", "utf8"),
    readFile("src/i18n/locales/ja-JP.ts", "utf8"),
  ]);

  assert.match(app, /height: number\(pendingExport\?\.targetDimensionHeight/);
  assert.match(app, /height: number\(pendingExport\.requiredHeight\)/);
  assert.match(app, /pendingExport\.targetDimensionHeight !== pendingExport\.requiredHeight/);
  assert.match(app, /confirmationHeight > EXTENDED_WORLD_HEIGHT/);
  for (const locale of [zh, en, ja]) {
    assert.match(locale, /"extendedExport\.body": "[^"]*\{\{height\}\}[^"]*\{\{vanilla\}\}/);
    assert.match(locale, /"extendedExport\.projectionHeight": "[^"]*\{\{height\}\}/);
  }
});
