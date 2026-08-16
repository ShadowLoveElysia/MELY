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

test("a typical 320-block shell remains below the two-GiB budget", () => {
  const estimate = estimateVoxelizationResources({
    targetHeight: 320,
    width: 219,
    depth: 101,
    triangleCount: 43_660,
    textureBytes: 80 * 1024 ** 2,
    fillMode: "shell",
    estimatedBlocks: 141_452,
  });
  assert.equal(DEFAULT_MEMORY_BUDGET_BYTES, 2 * 1024 ** 3);
  assert.equal(estimate.allowed, true);
  assert.ok(estimate.estimatedBytes < DEFAULT_MEMORY_BUDGET_BYTES);
});

test("a 2032-block filled projection is rejected while a sparse shell can proceed", () => {
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
  assert.equal(filled.allowed, false);
  assert.equal(filled.reason, "volume");
  assert.equal(shell.allowed, true);
});

test("resource estimates format binary memory units", () => {
  assert.equal(formatBinaryBytes(2 * 1024 ** 3), "2.0 GiB");
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
  assert.equal(blockLimited.allowed, false);
  assert.equal(blockLimited.reason, "blocks");

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
  assert.equal(candidateLimited.allowed, false);
  assert.equal(candidateLimited.reason, "candidates");
});

test("interior estimates use the same sparse stride as hologram generation", () => {
  const interior = estimateSparseHologramInterior(2_032, 2_032, 2_032, 100);
  const estimate = estimateVoxelizationResources({
    targetHeight: 2_032,
    width: 2_032,
    depth: 2_032,
    triangleCount: 12,
    textureBytes: 0,
    fillMode: "shell",
    estimatedBlocks: 20_000,
    interiorDensity: 100,
  });

  assert.ok(interior.stride > 1);
  assert.ok(interior.candidateCount <= MAX_HOLOGRAM_CANDIDATES);
  assert.equal(estimate.allowed, true);
  assert.ok(estimate.estimatedBlocks <= MAX_PROJECTION_BLOCKS);
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
