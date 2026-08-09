import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTargetHeight,
  createHeightSafetyState,
  DEFAULT_TARGET_HEIGHT,
  evaluateProjectionHeightRisk,
  estimateScaledBlockCount,
  EXTENDED_WORLD_HEIGHT,
  lockExtendedHeight,
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
