import assert from "node:assert/strict";
import test from "node:test";
import { createLayerGuideSlice } from "../src/core/layerGuide";
import { createProjectionDocument } from "../src/core/projectionDocument";
import {
  createProjectionFingerprint,
  createProjectionLayerInput,
  createProjectionMaterialPlan,
  getProjectionLayerIndexStats,
  layerProgressStorageKey,
  loadLayerProgress,
} from "../src/components/survivalToolsModel";

const projection = () => createProjectionDocument([
  { position: [-2, 4, 7], paletteIndex: 0 },
  { position: [3, 4, -1], paletteIndex: 1 },
  { position: [3, 9, -1], paletteIndex: 0 },
], [
  { blockId: "minecraft:white_concrete", color: [207, 213, 214] },
  { blockId: "minecraft:end_rod", emissive: true },
]);

test("survival tools derive material and sparse layer data from one projection document", () => {
  const document = projection();
  const plan = createProjectionMaterialPlan(document);
  const input = createProjectionLayerInput(document);
  const layer = createLayerGuideSlice(input, "y", 4);

  assert.equal(plan.totalBlocks, 3);
  assert.deepEqual(plan.requirements.map(({ blockId, count }) => [blockId, count]), [
    ["minecraft:white_concrete", 2],
    ["minecraft:end_rod", 1],
  ]);
  assert.deepEqual(layer.pixels.map(({ position }) => position), [
    [3, 4, -1],
    [-2, 4, 7],
  ]);
});

test("projection fingerprints are stable across chunk order and isolate changed block data", () => {
  const first = projection();
  const reordered = { ...first, chunks: [...first.chunks].reverse() };
  const changed = createProjectionDocument([
    { position: [-2, 4, 7], paletteIndex: 0 },
    { position: [4, 4, -1], paletteIndex: 1 },
    { position: [3, 9, -1], paletteIndex: 0 },
  ], first.palette);

  assert.equal(createProjectionFingerprint(first), createProjectionFingerprint(reordered));
  assert.notEqual(createProjectionFingerprint(first), createProjectionFingerprint(changed));
});

test("layer progress storage keys include projection identity and invalid saved data falls back", () => {
  const fingerprint = createProjectionFingerprint(projection());
  const storage = {
    getItem: (key: string) => key.endsWith(":y")
      ? '{"format":"MELYLayerGuideProgress","version":1,"axis":"y","completedCoordinates":[4]}'
      : "invalid",
  };

  assert.match(layerProgressStorageKey(fingerprint, "y"), new RegExp(`${fingerprint}:y$`));
  assert.deepEqual(loadLayerProgress(storage, fingerprint, "y").completedCoordinates, [4]);
  assert.deepEqual(loadLayerProgress(storage, fingerprint, "x").completedCoordinates, []);
});

test("projection layer indexes are lazy, reused, and scan only the requested layer", () => {
  const blocks = Array.from({ length: 2_048 }, (_, index) => ({
    position: [index % 64, Math.floor(index / 64), index % 7] as [number, number, number],
    paletteIndex: index % 2,
  }));
  const document = createProjectionDocument(blocks, projection().palette);
  const source = createProjectionLayerInput(document);

  const initial = getProjectionLayerIndexStats(source);
  assert.deepEqual(initial.indexedAxes, []);
  assert.equal(initial.estimatedIndexBytes, 0);

  const occupied = source.occupiedCoordinates("y");
  const afterBuild = getProjectionLayerIndexStats(source);
  assert.equal(occupied.length, 32);
  assert.deepEqual(afterBuild.indexedAxes, ["y"]);
  assert.equal(afterBuild.indexBuilds, 1);
  assert.equal(afterBuild.indexedBlockVisits, document.blockCount * 2);
  assert.ok(afterBuild.estimatedIndexBytes < document.blockCount * 8);

  const firstSlice = createLayerGuideSlice(source, "y", 0);
  const secondSlice = createLayerGuideSlice(source, "y", 31);
  const emptySlice = createLayerGuideSlice(source, "y", 200);
  const afterSlices = getProjectionLayerIndexStats(source);
  assert.equal(firstSlice.blockCount, 64);
  assert.equal(secondSlice.blockCount, 64);
  assert.equal(emptySlice.blockCount, 0);
  assert.equal(afterSlices.indexBuilds, 1);
  assert.equal(afterSlices.sliceCalls, 3);
  assert.equal(afterSlices.sliceBlockVisits, 128);
});

test("projection layer sources preserve negative chunk coordinates and stable source indexes", () => {
  const document = createProjectionDocument([
    { position: [-33, -1, 64], paletteIndex: 1 },
    { position: [-1, -1, -33], paletteIndex: 0 },
    { position: [32, 8, -1], paletteIndex: 1 },
  ], projection().palette);
  const source = createProjectionLayerInput(document);
  const slice = createLayerGuideSlice(source, "y", -1);

  assert.deepEqual(slice.pixels.map(({ position }) => position), [
    [-1, -1, -33],
    [-33, -1, 64],
  ]);
  assert.equal(new Set(slice.pixels.map(({ sourceIndex }) => sourceIndex)).size, 2);
  assert.deepEqual([...source.occupiedCoordinates("x")], [-33, -1, 32]);
});
