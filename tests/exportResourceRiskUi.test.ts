import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("export resource warnings are bound to document, format, and bundle configuration", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  assert.match(source, /exportResourceRiskFingerprint\([\s\S]*resultId,[\s\S]*format,[\s\S]*bundleFormats/);
  assert.match(source, /fingerprint: exportResourceRiskFingerprint\(/);
  assert.match(source, /currentResourceFingerprint !== \(pendingExport\.resourceRisk\?\.fingerprint \?\? null\)/);
  assert.match(source, /currentBundleConfiguration !== pendingBundleConfiguration/);
  assert.match(source, /resourceRiskAccepted: true/);
  const performStart = source.indexOf("const performExport = useCallback");
  const performEnd = source.indexOf("const requestExport = async", performStart);
  const performExport = source.slice(performStart, performEnd);
  const confirmStart = source.indexOf("const confirmPendingExport = () =>");
  const confirmEnd = source.indexOf("const openSurvivalTools", confirmStart);
  const confirmExport = source.slice(confirmStart, confirmEnd);
  assert.match(performExport, /request\.resourceRisk && !request\.resourceRiskAccepted/);
  assert.doesNotMatch(confirmExport, /request\.resourceRisk/);
  assert.match(confirmExport, /performExport\(\{ \.\.\.pendingExport, resourceRiskAccepted: true \}\)/);
});

test("resource warnings are not rendered as unavailable export formats", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  assert.match(source, /const unavailable = Boolean\(preflight && !preflight\.allowed/);
  assert.match(source, /preflight\?\.requiresConfirmation[\s\S]*exportResourceRisk\.preflightWarning/);
  assert.match(source, /pendingExport\?\.resourceRisk[\s\S]*exportResourceRisk\.body/);
});

test("App does not pass the Web warning threshold as a ZIP output limit", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  assert.doesNotMatch(source, /maxOutputBytes:\s*DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES/);
  assert.match(source, /DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES[\s\S]*resourceRiskReasons\.push\("webRetention"\)/);
});

test("Bedrock resource warnings do not enter the Java extreme-height confirmation branch", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  assert.match(
    source,
    /const experimental = !isBedrockExportFormat\(format\)\s*&& confirmationHeight > EXTENDED_WORLD_HEIGHT/,
  );
  assert.match(
    source,
    /if \(!pendingExport\.experimental\) \{\s*void performExport\(\{ \.\.\.pendingExport, resourceRiskAccepted: true \}\)/,
  );
  assert.match(
    source,
    /!isBedrockExportFormat\(pendingExport\.format\)\s*&& pendingExport\.safety\.configurationFingerprint !==/,
  );
});
