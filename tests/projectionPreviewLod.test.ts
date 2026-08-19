import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProjectionPreviewSamplePlan,
  createSolidPreviewSource,
  MAX_PROJECTION_PREVIEW_INSTANCES,
} from "../src/components/projectionPreviewLod";

const sampledIndices = (plan: ReturnType<typeof createProjectionPreviewSamplePlan>) => (
  Array.from({ length: plan.samplePointCount }, (_, index) => plan.sourceIndexAt(index))
);

test("small projections retain every preview point", () => {
  const plan = createProjectionPreviewSamplePlan(7);

  assert.equal(plan.lod, false);
  assert.equal(plan.samplePointCount, 7);
  assert.equal(plan.estimatedInstanceCount, 7);
  assert.deepEqual(sampledIndices(plan), [0, 1, 2, 3, 4, 5, 6]);
});

test("solid preview source reads flat results without copying positions", () => {
  const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
  const result = {
    kind: "solid" as const,
    positions,
    blockIndices: new Uint16Array([2, 3]),
    palette: [],
    stats: {
      blockCount: 2,
      surfaceBlockCount: 2,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 0,
      paletteSize: 0,
      dimensions: [4, 4, 4] as [number, number, number],
    },
    bounds: { min: [1, 2, 3] as [number, number, number], max: [4, 5, 6] as [number, number, number] },
  };
  const source = createSolidPreviewSource(result);
  const target = { x: 0, y: 0, z: 0, paletteIndex: 0 };

  assert.equal(source.pointCount, 2);
  assert.deepEqual(source.pointAt(1, target), { x: 4, y: 5, z: 6, paletteIndex: 3 });
  positions[3] = 9;
  assert.equal(source.pointAt(1, target).x, 9);
});

test("solid preview source decodes globally indexed chunk storage without flattening", () => {
  const source = createSolidPreviewSource({
    kind: "solid",
    storage: "chunked",
    positions: new Float32Array(0),
    blockIndices: new Uint16Array(0),
    chunks: [
      {
        chunk: [-1, 2, 3],
        positions: new Uint16Array([0, 31 + 32 * (4 + 32 * 5)]),
        blockIndices: new Uint16Array([7, 8]),
      },
      {
        chunk: [1, -1, 0],
        positions: new Uint16Array([2 + 32 * (6 + 32 * 9)]),
        blockIndices: new Uint16Array([4]),
      },
    ],
    palette: [],
    stats: {
      blockCount: 3,
      surfaceBlockCount: 3,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 0,
      paletteSize: 0,
      dimensions: [96, 96, 96],
    },
    bounds: { min: [-32, -23, 96], max: [34, 69, 100] },
  });
  const target = { x: 0, y: 0, z: 0, paletteIndex: 0 };

  assert.equal(source.pointCount, 3);
  assert.deepEqual(source.pointAt(0, target), { x: -32, y: 64, z: 96, paletteIndex: 7 });
  assert.deepEqual(source.pointAt(1, target), { x: -1, y: 69, z: 100, paletteIndex: 8 });
  assert.deepEqual(source.pointAt(2, target), { x: 34, y: -23, z: 6, paletteIndex: 4 });
  assert.throws(() => source.pointAt(3, target), RangeError);
});

test("solid chunk lookup safely skips empty chunks", () => {
  const source = createSolidPreviewSource({
    kind: "solid",
    storage: "chunked",
    positions: new Float32Array(0),
    blockIndices: new Uint16Array(0),
    chunks: [
      { chunk: [0, 0, 0], positions: new Uint16Array(0), blockIndices: new Uint16Array(0) },
      { chunk: [1, 0, 0], positions: new Uint16Array([0]), blockIndices: new Uint16Array([5]) },
      { chunk: [2, 0, 0], positions: new Uint16Array(0), blockIndices: new Uint16Array(0) },
    ],
    palette: [],
    stats: {
      blockCount: 1,
      surfaceBlockCount: 1,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 0,
      paletteSize: 0,
      dimensions: [1, 1, 1],
    },
    bounds: { min: [32, 0, 0], max: [32, 0, 0] },
  });

  assert.deepEqual(
    source.pointAt(0, { x: 0, y: 0, z: 0, paletteIndex: 0 }),
    { x: 32, y: 0, z: 0, paletteIndex: 5 },
  );
});

test("large projection sampling is deterministic, bounded, and spans the full result", () => {
  const sourcePointCount = 10_000_003;
  const first = createProjectionPreviewSamplePlan(sourcePointCount);
  const second = createProjectionPreviewSamplePlan(sourcePointCount);
  const firstIndices = sampledIndices(first);
  const secondIndices = sampledIndices(second);

  assert.equal(first.lod, true);
  assert.equal(first.samplePointCount, MAX_PROJECTION_PREVIEW_INSTANCES);
  assert.equal(first.estimatedInstanceCount, MAX_PROJECTION_PREVIEW_INSTANCES);
  assert.equal(firstIndices[0], 0);
  assert.equal(firstIndices.at(-1), sourcePointCount - 1);
  assert.deepEqual(firstIndices, secondIndices);
  for (let index = 1; index < firstIndices.length; index += 1) {
    assert.ok(firstIndices[index] > firstIndices[index - 1]);
  }
});

test("hologram preview reserves the worst-case body and cap instance cost", () => {
  const plan = createProjectionPreviewSamplePlan(1_000_000, 2);

  assert.equal(plan.samplePointCount, MAX_PROJECTION_PREVIEW_INSTANCES / 2);
  assert.equal(plan.estimatedInstanceCount, MAX_PROJECTION_PREVIEW_INSTANCES);
  assert.equal(plan.lod, true);
});

test("sampling remains monotonic at the largest safe source count", () => {
  const plan = createProjectionPreviewSamplePlan(Number.MAX_SAFE_INTEGER);
  let previous = -1;

  for (let index = 0; index < plan.samplePointCount; index += 1) {
    const current = plan.sourceIndexAt(index);
    assert.ok(Number.isSafeInteger(current));
    assert.ok(current > previous);
    previous = current;
  }
  assert.equal(previous, Number.MAX_SAFE_INTEGER - 1);
});

test("invalid or insufficient preview budgets fail safe without selecting points", () => {
  const invalid = createProjectionPreviewSamplePlan(Number.POSITIVE_INFINITY);
  const insufficient = createProjectionPreviewSamplePlan(20, 2, 1);

  assert.equal(invalid.samplePointCount, 0);
  assert.equal(insufficient.samplePointCount, 0);
  assert.equal(insufficient.lod, true);
  assert.throws(() => insufficient.sourceIndexAt(0), RangeError);
});
