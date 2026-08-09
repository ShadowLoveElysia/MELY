import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLayerGuideProgress,
  createLayerGuideSlice,
  deserializeLayerGuideProgress,
  getAdjacentLayerCoordinate,
  getLayerGuideNavigation,
  isLayerCompleted,
  listOccupiedLayerCoordinates,
  serializeLayerGuideProgress,
  setLayerCompleted,
  summarizeLayerGuideProgress,
  type LayerGuideInput,
  type LayerGuideIndexedSource,
} from "../src/core/layerGuide";

const palette = [
  { blockId: "minecraft:white_concrete" },
  { blockId: "minecraft:black_concrete" },
  { blockId: "minecraft:end_rod" },
] as const;

const source = (blocks: readonly [number, number, number, number][]): LayerGuideInput<typeof palette[number]> => ({
  positions: blocks.flatMap(([x, y, z]) => [x, y, z]),
  paletteIndices: blocks.map(([, , , paletteIndex]) => paletteIndex),
  palette,
});

test("Y slices expose sparse 2D bounds, stable row ordering, and legend counts", () => {
  const first = createLayerGuideSlice(source([
    [0, 7, 2, 1],
    [-2, 7, 3, 0],
    [5, 8, 9, 2],
    [4, 7, -1, 1],
    [2, 7, 3, 1],
  ]), "y", 7);
  const reordered = createLayerGuideSlice(source([
    [2, 7, 3, 1],
    [4, 7, -1, 1],
    [-2, 7, 3, 0],
    [0, 7, 2, 1],
    [5, 8, 9, 2],
  ]), "y", 7);

  assert.equal(first.uAxis, "x");
  assert.equal(first.vAxis, "z");
  assert.deepEqual(first.bounds, { min: [-2, -1], max: [4, 3], dimensions: [7, 5] });
  assert.deepEqual(
    first.pixels.map(({ u, v, paletteIndex }) => [u, v, paletteIndex]),
    reordered.pixels.map(({ u, v, paletteIndex }) => [u, v, paletteIndex]),
  );
  assert.deepEqual(first.pixels.map(({ u, v }) => [u, v]), [
    [4, -1],
    [0, 2],
    [-2, 3],
    [2, 3],
  ]);
  assert.deepEqual(first.legend.map(({ paletteIndex, count }) => [paletteIndex, count]), [
    [0, 1],
    [1, 3],
  ]);
});

test("X and Z slices declare their plane axes and return null bounds when empty", () => {
  const input = source([
    [4, -2, 9, 0],
    [4, 3, -5, 1],
    [-1, 3, 9, 2],
  ]);
  const xSlice = createLayerGuideSlice(input, "x", 4);
  const zSlice = createLayerGuideSlice(input, "z", 9);
  const empty = createLayerGuideSlice(input, "z", 100);

  assert.deepEqual([xSlice.uAxis, xSlice.vAxis], ["z", "y"]);
  assert.deepEqual(xSlice.pixels.map(({ u, v }) => [u, v]), [[9, -2], [-5, 3]]);
  assert.deepEqual([zSlice.uAxis, zSlice.vAxis], ["x", "y"]);
  assert.deepEqual(zSlice.pixels.map(({ u, v }) => [u, v]), [[4, -2], [-1, 3]]);
  assert.equal(empty.bounds, null);
  assert.equal(empty.blockCount, 0);
  assert.deepEqual(empty.legend, []);
});

test("giant sparse coordinates never require an intermediate 2D matrix", () => {
  const input = source([
    [-1_000_000_000, -5, 1_000_000_000, 0],
    [1_000_000_000, -5, -1_000_000_000, 1],
  ]);
  const slice = createLayerGuideSlice(input, "y", -5);

  assert.equal(slice.pixels.length, 2);
  assert.deepEqual(slice.bounds, {
    min: [-1_000_000_000, -1_000_000_000],
    max: [1_000_000_000, 1_000_000_000],
    dimensions: [2_000_000_001, 2_000_000_001],
  });
  assert.deepEqual(listOccupiedLayerCoordinates(input, "x"), [-1_000_000_000, 1_000_000_000]);
});

test("adjacent navigation jumps between occupied layers across gaps", () => {
  const layers = [100, -10, 2, 2];
  assert.deepEqual(getLayerGuideNavigation(layers, 2), {
    coordinate: 2,
    occupiedIndex: 1,
    totalLayers: 3,
    first: -10,
    previous: -10,
    next: 100,
    last: 100,
  });
  assert.deepEqual(getLayerGuideNavigation(layers, 0), {
    coordinate: 0,
    occupiedIndex: -1,
    totalLayers: 3,
    first: -10,
    previous: -10,
    next: 2,
    last: 100,
  });
  assert.equal(getAdjacentLayerCoordinate(layers, -10, "previous"), null);
  assert.equal(getAdjacentLayerCoordinate(layers, 100, "next"), null);
});

test("completed layer progress is canonical, immutable, and round-trips through JSON", () => {
  const initial = createLayerGuideProgress("y", [100, -10, 2, 2]);
  assert.deepEqual(initial.completedCoordinates, [-10, 2, 100]);

  const unchecked = setLayerCompleted(initial, 2, false);
  const checked = setLayerCompleted(unchecked, 50, true);
  assert.deepEqual(initial.completedCoordinates, [-10, 2, 100]);
  assert.deepEqual(checked.completedCoordinates, [-10, 50, 100]);
  assert.equal(isLayerCompleted(checked, 50), true);
  assert.equal(isLayerCompleted(checked, 2), false);

  const restored = deserializeLayerGuideProgress(serializeLayerGuideProgress(checked));
  assert.deepEqual(restored, checked);
  assert.deepEqual(summarizeLayerGuideProgress(restored, [-10, 2, 50, 100, 500]), {
    completedLayers: 3,
    remainingLayers: 2,
    totalLayers: 5,
    ratio: 0.6,
  });
});

test("invalid buffers, palette references, and persisted progress are rejected", () => {
  assert.throws(() => createLayerGuideSlice({
    positions: [0, 1],
    paletteIndices: [],
    palette,
  }, "y", 0), /inconsistent lengths/);
  assert.throws(() => createLayerGuideSlice(source([[0, 0, 0, 4]]), "y", 0), /palette index/);
  assert.throws(
    () => deserializeLayerGuideProgress('{"format":"MELYLayerGuideProgress","version":2}'),
    /format or version/,
  );
  assert.throws(
    () => deserializeLayerGuideProgress('{"format":"MELYLayerGuideProgress","version":1,"axis":"y","completedCoordinates":[1.5]}'),
    /safe integer/,
  );
  assert.throws(
    () => deserializeLayerGuideProgress('{"format":"MELYLayerGuideProgress","version":1,"axis":"y","completedCoordinates":["2"]}'),
    /contain numbers/,
  );
});

test("indexed sources are reused without full-source scans for each slice", () => {
  const blocks = [
    { position: [0, 4, 0] as [number, number, number], paletteIndex: 0, sourceIndex: 0 },
    { position: [2, 4, 5] as [number, number, number], paletteIndex: 1, sourceIndex: 1 },
    { position: [9, 400, 8] as [number, number, number], paletteIndex: 2, sourceIndex: 2 },
  ];
  let occupiedCalls = 0;
  let visited = 0;
  const indexed: LayerGuideIndexedSource<typeof palette[number]> = {
    kind: "indexed",
    palette,
    occupiedCoordinates: () => {
      occupiedCalls += 1;
      return Int32Array.of(4, 400);
    },
    visitLayer: (_axis, coordinate, visitor) => {
      for (const block of blocks) {
        if (block.position[1] !== coordinate) continue;
        visited += 1;
        visitor(block);
      }
    },
  };

  assert.deepEqual([...listOccupiedLayerCoordinates(indexed, "y")], [4, 400]);
  assert.deepEqual(createLayerGuideSlice(indexed, "y", 4).pixels.map(({ position }) => position), [
    [0, 4, 0],
    [2, 4, 5],
  ]);
  assert.equal(createLayerGuideSlice(indexed, "y", 123).blockCount, 0);
  assert.equal(occupiedCalls, 1);
  assert.equal(visited, 2);
});
