import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTargetHeight,
  clearExtremeExportConfirmation,
  COMPATIBILITY_DEFAULT_DIMENSION,
  confirmExtremeEnvironment,
  confirmExtremeExport,
  confirmExtremeUnlock,
  createHeightSafetyState,
  createExtremeExportFingerprint,
  createExtremeHeightConfigurationFingerprint,
  createExtremeHeightConfirmationState,
  DEFAULT_TARGET_HEIGHT,
  evaluateProjectionHeightRisk,
  estimateScaledBlockCount,
  EXPERIMENTAL_WORLD_HEIGHT,
  EXTENDED_WORLD_HEIGHT,
  invalidateExtremeConfirmations,
  lockExtendedHeight,
  preflightGenerationHeight,
  preflightProjectionHeight,
  type ExtremeHeightFingerprintInput,
  type HeightSafetyProfile,
  VANILLA_WORLD_HEIGHT,
} from "../src/core/heightSafety";

test("vanilla and extended height modes clamp to their explicit limits", () => {
  assert.equal(DEFAULT_TARGET_HEIGHT, 320);
  assert.equal(clampTargetHeight(1_200, "vanilla"), VANILLA_WORLD_HEIGHT);
  assert.equal(clampTargetHeight(1_200, "extended"), 1_200);
  assert.equal(clampTargetHeight(9_999, "extended"), EXTENDED_WORLD_HEIGHT);
  assert.equal(clampTargetHeight(Number.NaN, "vanilla"), DEFAULT_TARGET_HEIGHT);
});

test("only a height above 384 requires the destructive export confirmation", () => {
  const boundary = createHeightSafetyState(384, "vanilla");
  const extended = createHeightSafetyState(385, "extended");
  assert.equal(boundary.risk, "safe");
  assert.equal(boundary.requiresExportConfirmation, false);
  assert.equal(extended.risk, "extended");
  assert.equal(extended.requiresExportConfirmation, true);
});

test("height risk uses the selected profile default height instead of a global 384", () => {
  assert.equal(evaluateProjectionHeightRisk(256, null, 256).risk, "safe");
  assert.equal(evaluateProjectionHeightRisk(257, null, 256).risk, "extended");
  assert.equal(evaluateProjectionHeightRisk(384, null, 256).risk, "extended");
});

test("actual projection span cannot bypass the extended-height export confirmation", () => {
  const boundary = evaluateProjectionHeightRisk(320, {
    min: [0, 0, 0],
    max: [10, 383, 10],
    dimensions: [11, 384, 11],
  });
  const oversized = evaluateProjectionHeightRisk(320, {
    min: [0, 0, 0],
    max: [10, 384, 10],
    dimensions: [11, 385, 11],
  });
  const targetDriven = evaluateProjectionHeightRisk(1_200, {
    min: [0, 0, 0],
    max: [10, 319, 10],
    dimensions: [11, 320, 11],
  });

  assert.deepEqual(boundary, {
    targetHeight: 320,
    actualHeight: 384,
    requiredHeight: 384,
    risk: "safe",
    requiresExportConfirmation: false,
  });
  assert.equal(oversized.actualHeight, 385);
  assert.equal(oversized.requiredHeight, 385);
  assert.equal(oversized.requiresExportConfirmation, true);
  assert.equal(targetDriven.requiredHeight, 1_200);
  assert.equal(targetDriven.requiresExportConfirmation, true);
});

test("locking extended height returns to a valid vanilla configuration", () => {
  assert.deepEqual(lockExtendedHeight(1_200), {
    mode: "vanilla",
    maximum: VANILLA_WORLD_HEIGHT,
    targetHeight: VANILLA_WORLD_HEIGHT,
    risk: "safe",
    requiresExportConfirmation: false,
  });
});

test("block estimates distinguish shell-like and filled scaling", () => {
  assert.equal(estimateScaledBlockCount(10_000, 100, 200, true), 40_000);
  assert.equal(estimateScaledBlockCount(10_000, 100, 200, false), 80_000);
  assert.equal(estimateScaledBlockCount(0, 100, 200, true), 0);
});

const syntheticProfile = (
  overrides: Partial<HeightSafetyProfile> = {},
): HeightSafetyProfile => ({
  id: "test-version",
  releaseStatus: "verified",
  heightEra: "modern_datapack",
  defaultDimension: { minY: -64, height: 384 },
  heightCapability: "third_party_extended",
  maximumVerifiedHeight: EXPERIMENTAL_WORLD_HEIGHT,
  verification: { fixture: "synthetic" },
  exporters: {
    litematic: {},
    spongeSchematic: {},
    legacySchematic: null,
  },
  ...overrides,
});

const extremeFingerprintInput = (): ExtremeHeightFingerprintInput => ({
  projectId: "project-a",
  resultId: "result-a",
  generationMode: "hologram",
  generationParameters: { sampleSpacing: 2, interiorDensity: 25 },
  versionId: "test-version",
  profileFingerprint: "profile:v1",
  targetHeight: 4064,
  actualHeight: 4064,
  bounds: {
    min: [0, 0, 0],
    max: [10, 4063, 10],
    dimensions: [11, 4064, 11],
  },
  targetDimension: { id: "overworld", minY: -2032, height: 4064 },
  placementBottomY: -2032,
  edition: "java",
  exportFormat: "litematic",
  resourceEstimate: { blocks: 120_000 },
});

test("generation height preflight enforces modes without requiring verification evidence", () => {
  const profile = syntheticProfile();
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "default",
    targetHeight: 384,
    profile,
  }).allowed, true);
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "extended_2032",
    targetHeight: 2032,
    profile,
  }).errorCode, "HEIGHT_DATAPACK_ACK_REQUIRED");
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "extended_2032",
    targetHeight: 2032,
    datapackAcknowledged: true,
    profile,
  }).allowed, true);
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "extended_2032",
    targetHeight: 2033,
    datapackAcknowledged: true,
    profile,
  }).errorCode, "HEIGHT_EXTREME_CONFIRMATION_REQUIRED");
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "experimental_4064",
    targetHeight: 4065,
    datapackAcknowledged: true,
    profile,
  }).errorCode, "HEIGHT_EXCEEDS_4064");
  assert.equal(preflightGenerationHeight({
    versionId: "unknown",
    heightMode: "default",
    targetHeight: 256,
    profile: null,
  }).errorCode, "JAVA_VERSION_PROFILE_UNKNOWN");
});

test("a 4064 target dimension requires experimental confirmation for a 2032 projection", () => {
  const profile = syntheticProfile();
  const common = {
    versionId: profile.id,
    targetHeight: 2032,
    targetDimension: { minY: -2032, height: 4064 },
    datapackAcknowledged: true,
    profile,
  };

  const extended = preflightGenerationHeight({
    ...common,
    heightMode: "extended_2032",
  });
  assert.equal(extended.requiredHeight, 2032);
  assert.equal(extended.confirmationHeight, 4064);
  assert.equal(extended.requiredMode, "experimental_4064");
  assert.equal(extended.errorCode, "HEIGHT_EXTREME_CONFIRMATION_REQUIRED");

  const configurationFingerprint = "sha256:dimension-extreme";
  const confirmations = confirmExtremeEnvironment(
    confirmExtremeUnlock(
      createExtremeHeightConfirmationState(),
      configurationFingerprint,
      "unlock",
      1,
    ),
    configurationFingerprint,
    "environment",
    2,
  );
  const experimental = preflightGenerationHeight({
    ...common,
    heightMode: "experimental_4064",
    confirmations,
    configurationFingerprint,
  });
  assert.equal(experimental.allowed, true);
  assert.equal(experimental.requiredHeight, 2032);
  assert.equal(experimental.confirmationHeight, 4064);
});

test("legacy profiles may attempt community extended heights after explicit acknowledgement", () => {
  const profile = syntheticProfile({
    id: "1.16.5-test",
    heightEra: "legacy_fixed",
    defaultDimension: { minY: 0, height: 256 },
    heightCapability: "default_only",
    maximumVerifiedHeight: 256,
  });
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "default",
    targetHeight: 256,
    profile,
  }).allowed, true);
  const extended = preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "extended_2032",
    targetHeight: 257,
    datapackAcknowledged: true,
    profile,
  });
  assert.equal(extended.allowed, true);
  assert.deepEqual(extended.warnings, ["HEIGHT_EXTENSION_UNTESTED_FOR_VERSION"]);
});

test("registered untested profiles use best-effort height compatibility", () => {
  const profile = syntheticProfile({
    id: "26.3-test",
    releaseStatus: "provisional",
    defaultDimension: null,
    heightEra: "unknown",
    heightCapability: "default_only",
    maximumVerifiedHeight: null,
    verification: null,
  });
  const defaultResult = preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "default",
    targetHeight: 320,
    profile,
  });
  assert.equal(defaultResult.allowed, true);
  assert.deepEqual(defaultResult.dimension, COMPATIBILITY_DEFAULT_DIMENSION);
  assert.deepEqual(defaultResult.warnings, [
    "JAVA_VERSION_BEST_EFFORT",
    "HEIGHT_DEFAULT_DIMENSION_FALLBACK",
  ]);

  const extendedResult = preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "extended_2032",
    targetHeight: 2032,
    datapackAcknowledged: true,
    profile,
    bounds: { min: [0, 0, 0], max: [0, 2031, 0], dimensions: [1, 2032, 1] },
    targetDimension: { minY: -1024, height: 2032 },
    placementBottomY: -1024,
  });
  assert.equal(extendedResult.allowed, true);
  assert.deepEqual(extendedResult.warnings, [
    "JAVA_VERSION_BEST_EFFORT",
    "HEIGHT_DEFAULT_DIMENSION_FALLBACK",
    "HEIGHT_EXTENSION_UNTESTED_FOR_VERSION",
  ]);

  const configurationFingerprint = "sha256:untested-extreme";
  const confirmations = confirmExtremeEnvironment(
    confirmExtremeUnlock(
      createExtremeHeightConfirmationState(),
      configurationFingerprint,
      "unlock",
      1,
    ),
    configurationFingerprint,
    "environment",
    2,
  );
  const extremeResult = preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "experimental_4064",
    targetHeight: 4064,
    datapackAcknowledged: true,
    profile,
    bounds: { min: [0, 0, 0], max: [0, 4063, 0], dimensions: [1, 4064, 1] },
    targetDimension: { minY: -2032, height: 4064 },
    placementBottomY: -2032,
    confirmations,
    configurationFingerprint,
    requireExtremeExportConfirmation: false,
  });
  assert.equal(extremeResult.allowed, true);
  assert.ok(extremeResult.warnings.includes("HEIGHT_EXTENSION_UNTESTED_FOR_VERSION"));
});

test("malformed modes and target heights remain hard failures", () => {
  const profile = syntheticProfile();
  assert.equal(preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "unsupported" as never,
    targetHeight: 320,
    profile,
  }).errorCode, "HEIGHT_MODE_INVALID");
  for (const targetHeight of [0, -1, 1.5, Number.NaN]) {
    assert.equal(preflightGenerationHeight({
      versionId: profile.id,
      heightMode: "default",
      targetHeight,
      profile,
    }).errorCode, "HEIGHT_TARGET_INVALID");
  }
});

test("4064 confirmations are sequential and bound to configuration and export fingerprints", () => {
  const input = extremeFingerprintInput();
  const configurationFingerprint = createExtremeHeightConfigurationFingerprint(input);
  const exportFingerprint = createExtremeExportFingerprint(input);
  const unlocked = confirmExtremeUnlock(
    createExtremeHeightConfirmationState(),
    configurationFingerprint,
    "unlock",
    1,
  );
  const environment = confirmExtremeEnvironment(
    unlocked,
    configurationFingerprint,
    "environment",
    2,
  );
  const confirmed = confirmExtremeExport(
    environment,
    configurationFingerprint,
    exportFingerprint,
    "导出 4064",
    4064,
    "export",
    3,
  );
  const profile = syntheticProfile();
  assert.equal(preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "experimental_4064",
    targetHeight: 4064,
    datapackAcknowledged: true,
    profile,
    bounds: input.bounds,
    placementBottomY: -2032,
    targetDimension: input.targetDimension,
    confirmations: confirmed,
    configurationFingerprint,
    exportFingerprint,
  }).allowed, true);
  assert.equal(preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "experimental_4064",
    targetHeight: 4064,
    datapackAcknowledged: true,
    profile,
    bounds: input.bounds,
    placementBottomY: -2032,
    targetDimension: input.targetDimension,
    confirmations: environment,
    configurationFingerprint,
    requireExtremeExportConfirmation: false,
  }).allowed, true);
  assert.equal(preflightProjectionHeight({
    versionId: profile.id,
    heightMode: "experimental_4064",
    targetHeight: 4064,
    datapackAcknowledged: true,
    profile,
    bounds: input.bounds,
    placementBottomY: -2032,
    targetDimension: input.targetDimension,
    confirmations: environment,
    configurationFingerprint,
  }).errorCode, "HEIGHT_EXTREME_CONFIRMATION_REQUIRED");
  assert.equal(clearExtremeExportConfirmation(confirmed).export, null);
  assert.deepEqual(
    invalidateExtremeConfirmations(confirmed, "changed"),
    createExtremeHeightConfirmationState(),
  );
});

test("placement checks use inclusive -2032..2031 bounds", () => {
  const profile = syntheticProfile();
  const input = extremeFingerprintInput();
  const configurationFingerprint = createExtremeHeightConfigurationFingerprint(input);
  const environment = confirmExtremeEnvironment(
    confirmExtremeUnlock(createExtremeHeightConfirmationState(), configurationFingerprint, "unlock", 1),
    configurationFingerprint,
    "environment",
    2,
  );
  const exportFingerprint = createExtremeExportFingerprint(input);
  const confirmed = confirmExtremeExport(
    environment,
    configurationFingerprint,
    exportFingerprint,
    "导出 4064",
    4064,
    "export",
    3,
  );
  const common = {
    versionId: profile.id,
    heightMode: "experimental_4064" as const,
    targetHeight: 4064,
    datapackAcknowledged: true,
    profile,
    bounds: input.bounds,
    targetDimension: { minY: -2032, height: 4064 },
    confirmations: confirmed,
    configurationFingerprint,
    exportFingerprint,
  };
  assert.equal(preflightProjectionHeight({ ...common, placementBottomY: -2032 }).allowed, true);
  assert.equal(
    preflightProjectionHeight({ ...common, placementBottomY: -2031 }).errorCode,
    "PLACEMENT_OUTSIDE_DIMENSION_RANGE",
  );
});

test("extended exports require an explicit third-party dimension declaration", () => {
  const profile = syntheticProfile({ maximumVerifiedHeight: EXTENDED_WORLD_HEIGHT });
  const common = {
    versionId: profile.id,
    heightMode: "extended_2032" as const,
    targetHeight: 2032,
    datapackAcknowledged: true,
    profile,
    bounds: {
      min: [0, 0, 0] as const,
      max: [0, 2031, 0] as const,
      dimensions: [1, 2032, 1] as const,
    },
    placementBottomY: -1024,
  };
  assert.equal(
    preflightProjectionHeight(common).errorCode,
    "TARGET_DIMENSION_DECLARATION_REQUIRED",
  );
  assert.equal(preflightProjectionHeight({
    ...common,
    targetDimension: { minY: -1024, height: 2032 },
  }).allowed, true);
  assert.equal(preflightProjectionHeight({
    ...common,
    targetDimension: { minY: -2032, height: 4065 },
  }).errorCode, "TARGET_DIMENSION_DECLARATION_REQUIRED");
});

test("projection preflight keeps geometry height separate from world confirmation height", () => {
  const profile = syntheticProfile();
  const configurationFingerprint = "sha256:short-extreme-world";
  const environment = confirmExtremeEnvironment(
    confirmExtremeUnlock(
      createExtremeHeightConfirmationState(),
      configurationFingerprint,
      "unlock",
      1,
    ),
    configurationFingerprint,
    "environment",
    2,
  );
  const input = {
    versionId: profile.id,
    heightMode: "experimental_4064" as const,
    targetHeight: 2032,
    targetDimension: { minY: -2032, height: 4064 },
    placementBottomY: -2032,
    datapackAcknowledged: true,
    profile,
    bounds: {
      min: [0, 0, 0] as const,
      max: [0, 2031, 0] as const,
      dimensions: [1, 2032, 1] as const,
    },
    confirmations: environment,
    configurationFingerprint,
  };

  const generationResult = preflightProjectionHeight({
    ...input,
    requireExtremeExportConfirmation: false,
  });
  assert.equal(generationResult.allowed, true);
  assert.equal(generationResult.requiredHeight, 2032);
  assert.equal(generationResult.confirmationHeight, 4064);
  assert.equal(generationResult.requiredMode, "experimental_4064");

  const exportResult = preflightProjectionHeight(input);
  assert.equal(exportResult.requiredHeight, 2032);
  assert.equal(exportResult.confirmationHeight, 4064);
  assert.equal(exportResult.errorCode, "HEIGHT_EXTREME_CONFIRMATION_REQUIRED");
});
