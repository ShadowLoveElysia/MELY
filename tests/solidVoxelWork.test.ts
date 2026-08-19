import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateNormalizedSolidVoxelWork,
  estimateSolidVoxelizationWork,
  triangleVoxelBounds,
  visitTriangleVoxelCandidates,
  type SolidVoxelPoint,
} from "../src/core/solidVoxelWork";
import { triangleIntersectsBox } from "../src/core/solidVoxelizer";
import type { MmdMeshSnapshot } from "../src/types";

const pointKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

const exhaustiveHits = (
  a: SolidVoxelPoint,
  b: SolidVoxelPoint,
  c: SolidVoxelPoint,
  halfSize: number,
) => {
  const bounds = triangleVoxelBounds(a, b, c, halfSize);
  const hits = new Set<string>();
  for (let y = bounds.minimum[1]; y <= bounds.maximum[1]; y += 1) {
    for (let z = bounds.minimum[2]; z <= bounds.maximum[2]; z += 1) {
      for (let x = bounds.minimum[0]; x <= bounds.maximum[0]; x += 1) {
        if (triangleIntersectsBox([...a], [...b], [...c], [x, y, z], halfSize)) {
          hits.add(pointKey(x, y, z));
        }
      }
    }
  }
  return hits;
};

const scannedHits = (
  a: SolidVoxelPoint,
  b: SolidVoxelPoint,
  c: SolidVoxelPoint,
  halfSize: number,
) => {
  const candidates = new Set<string>();
  const scan = visitTriangleVoxelCandidates(a, b, c, halfSize, (x, y, z) => {
    candidates.add(pointKey(x, y, z));
  });
  return { candidates, scan };
};

test("dominant-axis scan is a conservative superset of the 3D triangle-box SAT", () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    return ((state ^ state >>> 14) >>> 0) / 4_294_967_296;
  };

  for (let fixture = 0; fixture < 2_500; fixture += 1) {
    const triangle: [SolidVoxelPoint, SolidVoxelPoint, SolidVoxelPoint] = [0, 1, 2].map(
      () => [random() * 8 - 4, random() * 8 - 4, random() * 8 - 4] as const,
    ) as [SolidVoxelPoint, SolidVoxelPoint, SolidVoxelPoint];
    const halfSize = 0.5 + random() * 0.35;
    const expected = exhaustiveHits(...triangle, halfSize);
    const { candidates, scan } = scannedHits(...triangle, halfSize);

    for (const key of expected) {
      assert.equal(candidates.has(key), true, `fixture ${fixture} omitted ${key}`);
    }
    assert.equal(scan.candidateCount, candidates.size);
    assert.equal(scan.completed, true);
  }
});

test("longest-edge fallback preserves collinear, near-degenerate, and point SAT hits", () => {
  const fixtures: [SolidVoxelPoint, SolidVoxelPoint, SolidVoxelPoint][] = [
    [[-12, -2, 1], [15, 5, 8], [2, 1.6296296296, 4.6296296296]],
    [[-6, 0, -2], [8, 0.00000001, 5], [1, 0.000000011, 1.500000001]],
    [[1.25, -2.5, 3.75], [1.25, -2.5, 3.75], [1.25, -2.5, 3.75]],
  ];

  for (const [fixture, triangle] of fixtures.entries()) {
    const expected = exhaustiveHits(...triangle, 0.58);
    const { candidates, scan } = scannedHits(...triangle, 0.58);
    for (const key of expected) {
      assert.equal(candidates.has(key), true, `degenerate fixture ${fixture} omitted ${key}`);
    }
    assert.equal(scan.candidateCount, candidates.size);
  }
});

test("work estimate is O(triangle count), conservative, and retains legacy diagnostics", () => {
  const positions = Float32Array.from([
    -4, 0, -3,
    5, 1, 2,
    0, 8, 4,
    2, 3, -2,
  ]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const estimate = estimateNormalizedSolidVoxelWork(positions, indices, 0.58);

  for (let index = 0; index < indices.length / 3; index += 1) {
    const offset = index * 3;
    const points = [indices[offset], indices[offset + 1], indices[offset + 2]].map(vertex => [
      positions[vertex * 3],
      positions[vertex * 3 + 1],
      positions[vertex * 3 + 2],
    ] as SolidVoxelPoint);
    const exact = visitTriangleVoxelCandidates(points[0], points[1], points[2], 0.58);
    assert.ok(estimate.triangleCandidateUpperBounds[index] >= exact.candidateCount);
  }
  assert.equal(estimate.triangleCandidateUpperBounds.length, 2);
  assert.ok(estimate.totalCandidateUpperBound >= estimate.maxTriangleCandidateUpperBound);
  assert.ok(estimate.legacyAabbCandidateTests >= estimate.maxLegacyAabbCandidateTests);
  assert.equal(estimate.saturated, false);
});

test("scan controls can cancel inside a large projected triangle without inflating candidate count", () => {
  let visits = 0;
  const workSignals: number[] = [];
  const result = visitTriangleVoxelCandidates(
    [-100, 0, -100],
    [100, 0, -100],
    [0, 0, 100],
    0.58,
    () => { visits += 1; },
    {
      interval: 32,
      onWork: (work) => {
        workSignals.push(work);
        return work < 160;
      },
    },
  );

  assert.equal(result.completed, false);
  assert.equal(result.candidateCount, visits);
  assert.ok(result.workUnits >= 160);
  assert.ok(workSignals.length >= 5);
});

test("snapshot estimate measures deformed positions and target-height normalization", () => {
  const snapshot: MmdMeshSnapshot = {
    positions: Float32Array.from([0, 0, 0, 2, 0, 0, 0, 4, 1]),
    indices: Uint32Array.from([0, 1, 2]),
    triangleMaterials: Uint16Array.from([0]),
  };
  const small = estimateSolidVoxelizationWork(snapshot, 320, 0.08);
  const extreme = estimateSolidVoxelizationWork(snapshot, 4_064, 0.08);

  assert.equal(small.triangleCandidateUpperBounds.length, 1);
  assert.ok(extreme.totalCandidateUpperBound > small.totalCandidateUpperBound);
  assert.ok(extreme.legacyAabbCandidateTests > small.legacyAabbCandidateTests);
});

test("malformed indices and non-finite positions fail closed", () => {
  assert.throws(
    () => estimateNormalizedSolidVoxelWork(
      Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
      Uint32Array.from([0, 1, 3]),
      0.5,
    ),
    /out of bounds/,
  );
  assert.throws(
    () => visitTriangleVoxelCandidates([0, 0, 0], [1, Number.NaN, 0], [0, 1, 0], 0.5),
    /non-finite vertex/,
  );
});
