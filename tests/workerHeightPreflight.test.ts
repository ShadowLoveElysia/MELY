import assert from "node:assert/strict";
import test from "node:test";
import type { HologramResult, WorkerCommand } from "../src/types";
import {
  assertWorkerGenerationHeight,
  assertWorkerResultHeight,
} from "../src/core/workerHeightPreflight";
import {
  confirmExtremeEnvironment,
  confirmExtremeUnlock,
  createExtremeHeightConfirmationState,
} from "../src/core/heightSafety";

type HologramWorkerCommand = Extract<WorkerCommand, { type: "GENERATE_HOLOGRAM" }>;

const command = (): HologramWorkerCommand => ({
  type: "GENERATE_HOLOGRAM",
  jobId: "height",
  versionId: "1.20.1",
  heightMode: "default",
  targetDimension: { minY: -64, height: 384 },
  placementBottomY: -64,
  options: {
    targetHeight: 320,
    sampleSpacing: 2,
    material: "mixed",
    directionMode: "vertical",
    preserveFace: true,
    glow: 72,
  },
  generationSeed: { contentHash: "fixture", minecraftVersion: "1.20.1" },
  source: { kind: "demo" },
});

const result = (height: number): Pick<HologramResult, "bounds"> => ({
  bounds: { min: [0, 0, 0], max: [0, height - 1, 0] },
});

test("Worker checks both requested and actual result height", () => {
  const safe = command();
  assert.doesNotThrow(() => assertWorkerGenerationHeight(safe));
  assert.doesNotThrow(() => assertWorkerResultHeight(safe, result(384)));
  assert.throws(
    () => assertWorkerResultHeight(safe, result(385)),
    /HEIGHT_DATAPACK_ACK_REQUIRED/,
  );
});

test("Worker permits registered untested versions and extended 2032 attempts", () => {
  const untested = command();
  untested.versionId = "26.3";
  untested.generationSeed = { contentHash: "fixture", minecraftVersion: "26.3" };
  assert.doesNotThrow(() => assertWorkerGenerationHeight(untested));
  assert.doesNotThrow(() => assertWorkerResultHeight(untested, result(320)));

  untested.heightMode = "extended_2032";
  untested.options.targetHeight = 2032;
  untested.datapackAcknowledged = true;
  untested.targetDimension = { minY: -1024, height: 2032 };
  untested.placementBottomY = -1024;
  assert.doesNotThrow(() => assertWorkerGenerationHeight(untested));
  assert.doesNotThrow(() => assertWorkerResultHeight(untested, result(2032)));
});

test("Worker permits 4064 only after the configuration-bound environment confirmation", () => {
  const extreme = command();
  const configurationFingerprint = "sha256:extreme-fixture";
  extreme.heightMode = "experimental_4064";
  extreme.options.targetHeight = 4064;
  extreme.datapackAcknowledged = true;
  extreme.targetDimension = { minY: -2032, height: 4064 };
  extreme.placementBottomY = -2032;
  extreme.configurationFingerprint = configurationFingerprint;
  assert.throws(
    () => assertWorkerGenerationHeight(extreme),
    /HEIGHT_EXTREME_CONFIRMATION_REQUIRED/,
  );
  extreme.confirmations = confirmExtremeEnvironment(
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
  assert.doesNotThrow(() => assertWorkerGenerationHeight(extreme));
  assert.doesNotThrow(() => assertWorkerResultHeight(extreme, result(4064)));
});

test("Worker rejects an invalid placement even when generation height is safe", () => {
  const misplaced = command();
  misplaced.placementBottomY = -63;
  assert.doesNotThrow(() => assertWorkerGenerationHeight(misplaced));
  assert.throws(
    () => assertWorkerResultHeight(misplaced, result(384)),
    /PLACEMENT_OUTSIDE_DIMENSION_RANGE/,
  );
});
