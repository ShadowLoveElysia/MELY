import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  MAX_HOLOGRAM_CANDIDATES,
  MAX_PROJECTION_BLOCKS,
  estimateSparseHologramInterior,
  estimateMmdRuntimeMemory,
  estimateVoxelizationResources,
  formatBinaryBytes,
} from "../src/core/resourceBudget";

test("a typical 320-block shell remains below the five-GiB budget", () => {
  const estimate = estimateVoxelizationResources({
    targetHeight: 320,
    width: 219,
    depth: 101,
    triangleCount: 43_660,
    textureBytes: 80 * 1024 ** 2,
    fillMode: "shell",
    estimatedBlocks: 141_452,
  });
  assert.equal(DEFAULT_MEMORY_BUDGET_BYTES, 5 * 1024 ** 3);
  assert.equal(estimate.allowed, true);
  assert.ok(estimate.estimatedBytes < DEFAULT_MEMORY_BUDGET_BYTES);
});

test("the five-GiB memory boundary is inclusive", () => {
  const fixedOverhead = 128 * 1024 ** 2;
  const textureBytesAtLimit = (DEFAULT_MEMORY_BUDGET_BYTES - fixedOverhead) / 2;
  const input = {
    targetHeight: 1,
    width: 1,
    depth: 1,
    triangleCount: 0,
    fillMode: "shell" as const,
    estimatedBlocks: 0,
  };

  const atLimit = estimateVoxelizationResources({
    ...input,
    textureBytes: textureBytesAtLimit,
  });
  const aboveLimit = estimateVoxelizationResources({
    ...input,
    textureBytes: textureBytesAtLimit + 1,
  });

  assert.equal(atLimit.estimatedBytes, DEFAULT_MEMORY_BUDGET_BYTES);
  assert.equal(atLimit.allowed, true);
  assert.equal(atLimit.requiresConfirmation, false);
  assert.equal(atLimit.reason, "ok");
  assert.equal(aboveLimit.estimatedBytes, DEFAULT_MEMORY_BUDGET_BYTES + 2);
  assert.equal(aboveLimit.allowed, true);
  assert.equal(aboveLimit.requiresConfirmation, true);
  assert.deepEqual(aboveLimit.risks, ["memory"]);
  assert.equal(aboveLimit.reason, "memory");
});

test("a 2032-block filled projection requires confirmation while a sparse shell can proceed", () => {
  const filled = estimateVoxelizationResources({
    targetHeight: 2_032,
    width: 1_390,
    depth: 640,
    triangleCount: 43_660,
    textureBytes: 80 * 1024 ** 2,
    fillMode: "filled",
  });
  const shell = estimateVoxelizationResources({
    targetHeight: 2_032,
    width: 1_390,
    depth: 640,
    triangleCount: 43_660,
    textureBytes: 80 * 1024 ** 2,
    fillMode: "shell",
    estimatedBlocks: 5_700_000,
  });
  assert.equal(filled.allowed, true);
  assert.equal(filled.reason, "volume");
  assert.equal(filled.requiresConfirmation, true);
  assert.ok(filled.risks.includes("volume"));
  assert.equal(shell.allowed, true);
  assert.equal(shell.requiresConfirmation, false);
});

test("resource estimates format binary memory units", () => {
  assert.equal(formatBinaryBytes(2 * 1024 ** 3), "2.0 GiB");
  assert.equal(formatBinaryBytes(DEFAULT_MEMORY_BUDGET_BYTES), "5.0 GiB");
  assert.equal(formatBinaryBytes(512 * 1024 ** 2), "512 MiB");
});

test("hologram candidate and final block budgets are enforced independently", () => {
  const blockLimited = estimateVoxelizationResources({
    targetHeight: 100,
    width: 100,
    depth: 100,
    triangleCount: 1,
    textureBytes: 0,
    fillMode: "shell",
    estimatedBlocks: MAX_PROJECTION_BLOCKS + 1,
    candidateCount: MAX_PROJECTION_BLOCKS + 1,
    interiorDensity: 0,
  });
  assert.equal(blockLimited.allowed, true);
  assert.equal(blockLimited.reason, "blocks");
  assert.equal(blockLimited.requiresConfirmation, true);
  assert.ok(blockLimited.risks.includes("blocks"));

  const candidateLimited = estimateVoxelizationResources({
    targetHeight: 10,
    width: 10,
    depth: 10,
    triangleCount: 1,
    textureBytes: 0,
    fillMode: "shell",
    estimatedBlocks: 1_000,
    candidateCount: MAX_HOLOGRAM_CANDIDATES + 1,
    interiorDensity: 0,
  });
  assert.equal(candidateLimited.allowed, true);
  assert.equal(candidateLimited.reason, "candidates");
  assert.equal(candidateLimited.requiresConfirmation, true);
  assert.ok(candidateLimited.risks.includes("candidates"));
});

test("interior estimates retain counts above advisory thresholds", () => {
  const interior = estimateSparseHologramInterior(2_032, 2_032, 2_032, 100);
  const contourBlocks = MAX_PROJECTION_BLOCKS - interior.selectedCount + 1;
  const estimate = estimateVoxelizationResources({
    targetHeight: 2_032,
    width: 2_032,
    depth: 2_032,
    triangleCount: 12,
    textureBytes: 0,
    fillMode: "shell",
    estimatedBlocks: contourBlocks,
    interiorDensity: 100,
  });

  assert.ok(interior.stride > 1);
  assert.ok(interior.candidateCount > 0);
  assert.equal(estimate.allowed, true);
  assert.equal(estimate.estimatedBlocks, contourBlocks + interior.selectedCount);
  assert.equal(estimate.estimatedBlocks, MAX_PROJECTION_BLOCKS + 1);
  assert.equal(estimate.requiresConfirmation, true);
  assert.ok(estimate.risks.includes("blocks"));
  assert.equal(
    estimate.risks.includes("candidates"),
    estimate.estimatedCandidates > MAX_HOLOGRAM_CANDIDATES,
  );
});

test("sparse morph splitting avoids the dense all-vertex morph allocation", () => {
  const estimate = estimateMmdRuntimeMemory({
    vertexCount: 180_000,
    indexCount: 720_000,
    morphCount: 180,
    splitVertexCount: 48_000,
    splitMorphCount: 24,
    textureBytes: 96 * 1024 ** 2,
  });
  assert.ok(estimate.denseMorphBytes > 360 * 1024 ** 2);
  assert.ok(estimate.splitMorphBytes < estimate.denseMorphBytes / 20);
  assert.ok(estimate.savedBytes > 300 * 1024 ** 2);
  assert.ok(estimate.estimatedBytes < DEFAULT_MEMORY_BUDGET_BYTES);
});
