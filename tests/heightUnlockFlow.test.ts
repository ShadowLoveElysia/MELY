import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  confirmExtremeEnvironment,
  confirmExtremeExport,
  confirmExtremeUnlock,
  createExtremeExportFingerprint,
  createExtremeHeightConfigurationFingerprint,
  createExtremeHeightConfirmationState,
  createHeightProfileFingerprint,
  preflightProjectionHeight,
  type ExtremeHeightFingerprintInput,
} from "../src/core/heightSafety";
import { requireJavaVersionProfile } from "../src/core/minecraftVersions";

test("2032 is allowed after selecting extended mode and declaring a valid dimension", () => {
  const profile = requireJavaVersionProfile("1.20.1");
  assert.equal(profile.maximumVerifiedHeight, null);

  const preflight = preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "extended_2032",
    targetHeight: 2032,
    datapackAcknowledged: true,
    bounds: {
      min: [0, 0, 0],
      max: [0, 2031, 0],
      dimensions: [1, 2032, 1],
    },
    placementBottomY: -1024,
    targetDimension: { minY: -1024, height: 2032 },
  });

  assert.equal(preflight.allowed, true);
  assert.equal(preflight.errorCode, null);
  assert.ok(preflight.warnings.includes("HEIGHT_EXTENSION_UNTESTED_FOR_VERSION"));
});

test("4064 passes after unlock, environment, and export confirmations", () => {
  const profile = requireJavaVersionProfile("1.20.1");
  const input: ExtremeHeightFingerprintInput = {
    projectId: "extreme-project",
    resultId: "extreme-result",
    generationMode: "hologram",
    generationParameters: { sampleSpacing: 3, interiorDensity: 0 },
    versionId: profile.id,
    profileFingerprint: createHeightProfileFingerprint(profile),
    targetHeight: 4064,
    actualHeight: 4064,
    bounds: {
      min: [0, 0, 0],
      max: [0, 4063, 0],
      dimensions: [1, 4064, 1],
    },
    targetDimension: { id: "declared", minY: -2032, height: 4064 },
    placementBottomY: -2032,
    edition: "java",
    exportFormat: "litematic",
    resourceEstimate: { blocks: 4064 },
  };
  const configurationFingerprint = createExtremeHeightConfigurationFingerprint(input);
  const exportFingerprint = createExtremeExportFingerprint(input);
  const unlocked = confirmExtremeUnlock(
    createExtremeHeightConfirmationState(),
    configurationFingerprint,
    "unlock",
    1,
  );
  const environmentConfirmed = confirmExtremeEnvironment(
    unlocked,
    configurationFingerprint,
    "environment",
    2,
  );
  const exportConfirmed = confirmExtremeExport(
    environmentConfirmed,
    configurationFingerprint,
    exportFingerprint,
    "导出 4064",
    4064,
    "export",
    3,
  );

  const preflight = preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "experimental_4064",
    targetHeight: 4064,
    datapackAcknowledged: true,
    bounds: input.bounds,
    placementBottomY: input.placementBottomY,
    targetDimension: input.targetDimension,
    confirmations: exportConfirmed,
    configurationFingerprint,
    exportFingerprint,
  });
  assert.equal(preflight.allowed, true);
  assert.equal(preflight.errorCode, null);
  assert.ok(preflight.warnings.includes("HEIGHT_EXTENSION_UNTESTED_FOR_VERSION"));
});

const buttonOpeningTag = (source: string, handler: string) => {
  const handlerIndex = source.indexOf(`onClick={${handler}}`);
  assert.notEqual(handlerIndex, -1, `${handler} must remain connected`);
  const buttonIndex = source.lastIndexOf("<button", handlerIndex);
  assert.notEqual(buttonIndex, -1, `${handler} must be attached to a button`);
  return source.slice(buttonIndex, handlerIndex + `onClick={${handler}}`.length);
};

test("height unlock controls and generation are not disabled by verification status", async () => {
  const [app, sidebar] = await Promise.all([
    readFile("src/App.tsx", "utf8"),
    readFile("src/components/Sidebar.tsx", "utf8"),
  ]);

  assert.doesNotMatch(app, /generationDisabledReason/);
  assert.doesNotMatch(sidebar, /generationDisabledReason/);
  assert.doesNotMatch(app, /extendedHeightAvailable|experimentalHeightAvailable/);
  assert.doesNotMatch(sidebar, /extendedHeightAvailable|experimentalHeightAvailable/);
  assert.doesNotMatch(buttonOpeningTag(sidebar, "onExtendedHeightToggle"), /disabled\s*=/);
  assert.doesNotMatch(buttonOpeningTag(sidebar, "onExperimentalHeightUnlock"), /disabled\s*=/);
  assert.match(app, /onExtendedHeightToggle={toggleExtendedHeight}/);
  assert.match(app, /onExperimentalHeightUnlock={beginExtremeHeightUnlock}/);

  const generateStart = app.indexOf("const generate = useCallback");
  const generateEnd = app.indexOf("\n  useEffect(", generateStart);
  assert.notEqual(generateStart, -1);
  assert.notEqual(generateEnd, -1);
  const generateSource = app.slice(generateStart, generateEnd);
  assert.match(generateSource, /preflightGenerationHeight/);
  assert.doesNotMatch(generateSource, /releaseStatus\s*!==\s*["']verified["']/);
});

