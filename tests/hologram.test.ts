import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateHologram,
  generateMeshHologram,
  MAX_HOLOGRAM_BLOCKS,
  MAX_HOLOGRAM_CANDIDATES,
} from "../src/core/hologram";
import { assertSixWayIsolated } from "../src/core/hologramIsolation";
import type { HologramMeshSnapshot, HologramOptions } from "../src/types";

const cubeIndices = Uint32Array.from([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  3, 7, 6, 3, 6, 2,
  0, 4, 7, 0, 7, 3,
  1, 2, 6, 1, 6, 5,
]);

const createCube = (scale = 1, offset: [number, number, number] = [0, 0, 0]): HologramMeshSnapshot => {
  const base = [
    [-1, 0, -1], [1, 0, -1], [1, 2, -1], [-1, 2, -1],
    [-1, 0, 1], [1, 0, 1], [1, 2, 1], [-1, 2, 1],
  ];
  const positions = Float32Array.from(base.flatMap(([x, y, z]) => [
    x * scale + offset[0],
    y * scale + offset[1],
    z * scale + offset[2],
  ]));
  return {
    positions,
    indices: cubeIndices.slice(),
    triangleMaterials: new Uint16Array(cubeIndices.length / 3),
  };
};

const createSubdividedCube = (segments: number): HologramMeshSnapshot => {
  const positions: number[] = [];
  const indices: number[] = [];
  const appendFace = (
    origin: [number, number, number],
    axisU: [number, number, number],
    axisV: [number, number, number],
    reverse: boolean,
  ) => {
    const offset = positions.length / 3;
    for (let v = 0; v <= segments; v += 1) {
      for (let u = 0; u <= segments; u += 1) {
        positions.push(
          origin[0] + axisU[0] * u / segments + axisV[0] * v / segments,
          origin[1] + axisU[1] * u / segments + axisV[1] * v / segments,
          origin[2] + axisU[2] * u / segments + axisV[2] * v / segments,
        );
      }
    }
    for (let v = 0; v < segments; v += 1) {
      for (let u = 0; u < segments; u += 1) {
        const a = offset + v * (segments + 1) + u;
        const b = a + 1;
        const d = a + segments + 1;
        const c = d + 1;
        indices.push(...(reverse ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
      }
    }
  };

  appendFace([-1, 0, -1], [2, 0, 0], [0, 2, 0], true);
  appendFace([-1, 0, 1], [0, 2, 0], [2, 0, 0], true);
  appendFace([-1, 0, -1], [0, 0, 2], [2, 0, 0], true);
  appendFace([-1, 2, -1], [2, 0, 0], [0, 0, 2], true);
  appendFace([-1, 0, -1], [0, 2, 0], [0, 0, 2], true);
  appendFace([1, 0, -1], [0, 0, 2], [0, 2, 0], true);

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleMaterials: new Uint16Array(indices.length / 3),
  };
};

const createTriangleSoupCube = (flipTriangle = false): HologramMeshSnapshot => {
  const source = createCube();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let triangle = 0; triangle < source.indices.length / 3; triangle += 1) {
    const vertices = [0, 1, 2].map((corner) => source.indices[triangle * 3 + corner]);
    if (flipTriangle && triangle === 0) vertices.reverse();
    for (const vertex of vertices) {
      positions.push(
        source.positions[vertex * 3],
        source.positions[vertex * 3 + 1],
        source.positions[vertex * 3 + 2],
      );
      indices.push(indices.length);
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleMaterials: new Uint16Array(indices.length / 3),
  };
};

const createIntersectingClosedShells = (): HologramMeshSnapshot => {
  const left = createCube(1, [-0.6, 0, 0]);
  const right = createCube(1, [0.6, 0, 0]);
  const vertexOffset = left.positions.length / 3;
  return {
    positions: Float32Array.from([...left.positions, ...right.positions]),
    indices: Uint32Array.from([
      ...left.indices,
      ...Array.from(right.indices, (index) => index + vertexOffset),
    ]),
    triangleMaterials: new Uint16Array(
      (left.indices.length + right.indices.length) / 3,
    ),
  };
};

const options: HologramOptions = {
  targetHeight: 32,
  sampleSpacing: 2,
  material: "mixed",
  directionMode: "vertical",
  preserveFace: true,
  glow: 70,
};

const positionKeys = (positions: Float32Array) => {
  const keys: string[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    keys.push(`${positions[index]},${positions[index + 1]},${positions[index + 2]}`);
  }
  return keys;
};

const positionsFromResult = (positions: Float32Array) => {
  const result: Array<[number, number, number]> = [];
  for (let index = 0; index < positions.length; index += 3) {
    result.push([positions[index], positions[index + 1], positions[index + 2]]);
  }
  return result;
};

const createOpenPlane = (): HologramMeshSnapshot => ({
  positions: Float32Array.from([
    -1, 0, -1,
    1, 0, -1,
    1, 2, 1,
    -1, 2, 1,
  ]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
  triangleMaterials: new Uint16Array(2),
});

const createFaceAndHairSnapshot = (): HologramMeshSnapshot => {
  const quads = [
    [-2, 0, 0, 2, 8, 0],
    [-0.7, 5, 0.2, 0.7, 5.8, 0.2],
    [-1.5, 9, 0.1, 1.5, 10, 0.1],
  ] as const;
  const positions: number[] = [];
  const indices: number[] = [];
  quads.forEach(([minX, minY, z, maxX, maxY], quadIndex) => {
    const offset = positions.length / 3;
    positions.push(
      minX, minY, z,
      maxX, minY, z,
      maxX, maxY, z,
      minX, maxY, z,
    );
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  });
  const material = (name: string, englishName: string) => ({
    name,
    englishName,
    baseColor: [1, 1, 1, 1] as [number, number, number, number],
    textureFactor: [1, 1, 1, 1] as [number, number, number, number],
    textureIndex: -1,
    textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
    wrapS: 1001,
    wrapT: 1001,
    flipY: false,
    ambient: [0, 0, 0] as [number, number, number],
    emissive: false,
  });
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleMaterials: Uint16Array.from([0, 0, 1, 1, 2, 2]),
    faceFrame: {
      origin: [0, 5.4, 0.2],
      right: [1, 0, 0],
      up: [0, 1, 0],
      forward: [0, 0, 1],
      eyeDistance: 1.4,
      confidence: 1,
    },
    materials: [
      material("body", "body"),
      material("左眼睛", "left eye"),
      material("头发", "hair"),
    ],
  };
};

const keysInYRange = (positions: Float32Array, minimum: number, maximum: number) => {
  const keys: string[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    const y = positions[index + 1];
    if (y >= minimum && y <= maximum) {
      keys.push(`${positions[index]},${y},${positions[index + 2]}`);
    }
  }
  return keys.sort();
};

test("mesh hologram normalizes, samples and deduplicates feature geometry", () => {
  const result = generateMeshHologram(createCube(), options);
  const keys = positionKeys(result.positions);

  assert.ok(result.stats.blockCount > 100);
  assert.ok(result.stats.blockCount < 5000);
  assert.equal(result.stats.blockCount, keys.length);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(result.stats.blockCount, result.stats.endRodCount + result.stats.paneCount);
  assert.equal(result.bounds.min[1], 0);
  assert.equal(result.bounds.max[1], options.targetHeight - 1);
  assert.equal(result.stats.dimensions[1], options.targetHeight);
  assert.ok(result.facings.every((facing) => facing === 2));
});

test("target-space output is invariant to source translation and uniform scale", () => {
  const baseline = generateMeshHologram(createCube(), options);
  const transformed = generateMeshHologram(createCube(7.5, [23, -18, 91]), options);

  assert.deepEqual(positionKeys(transformed.positions), positionKeys(baseline.positions));
  assert.deepEqual([...transformed.facings], [...baseline.facings]);
  assert.deepEqual([...transformed.materials], [...baseline.materials]);
});

test("larger sample spacing produces a lighter hologram", () => {
  const detailed = generateMeshHologram(createCube(), { ...options, sampleSpacing: 1 });
  const sparse = generateMeshHologram(createCube(), { ...options, sampleSpacing: 5 });

  assert.ok(detailed.stats.blockCount > sparse.stats.blockCount);
  assert.ok(sparse.stats.blockCount > 0);
});

test("face preservation follows the face frame and does not densify high hair", () => {
  const snapshot = createFaceAndHairSnapshot();
  const withoutFace = generateMeshHologram(snapshot, {
    ...options,
    targetHeight: 101,
    sampleSpacing: 4,
    material: "end_rod",
    preserveFace: false,
  });
  const withFace = generateMeshHologram(snapshot, {
    ...options,
    targetHeight: 101,
    sampleSpacing: 4,
    material: "end_rod",
    preserveFace: true,
  });

  assert.ok(
    keysInYRange(withFace.positions, 48, 62).length
      > keysInYRange(withoutFace.positions, 48, 62).length,
  );
  assert.deepEqual(
    keysInYRange(withFace.positions, 88, 100),
    keysInYRange(withoutFace.positions, 88, 100),
  );
});

test("mesh holograms retain their normalized face frame for projection camera focus", () => {
  const result = generateMeshHologram(createFaceAndHairSnapshot(), {
    ...options,
    targetHeight: 48,
  });

  assert.ok(result.faceFrame);
  assert.ok(result.faceFrame.eyeDistance > 0);
  assert.equal(result.faceFrame.confidence, 1);
});

test("2032-block holograms remain sparse and vertically bounded", () => {
  const result = generateMeshHologram(createCube(), {
    ...options,
    targetHeight: 2_032,
    sampleSpacing: 3,
    material: "mixed",
  });

  assert.equal(result.bounds.min[1], 0);
  assert.equal(result.bounds.max[1], 2_031);
  assert.equal(result.stats.dimensions[1], 2_032);
  assert.ok(result.stats.blockCount > 0);
  assert.ok(result.stats.blockCount < 320_000);
  assert.ok(result.positions.byteLength < 4 * 1024 * 1024);
  assert.ok(result.facings.every((facing) => facing === 2));
});

test("2032-block interior sampling stays sparse and below the final block budget", () => {
  const result = generateMeshHologram(createCube(), {
    ...options,
    targetHeight: 2_032,
    sampleSpacing: 3,
    material: "mixed",
    interiorDensity: 100,
  });

  assert.equal(result.stats.interiorMode, "closed-volume");
  assert.ok(result.stats.interiorSamplingStride > 1);
  assert.ok(result.stats.interiorCandidateCount > 0);
  assert.ok(result.stats.blockCount <= 320_000);
  assertSixWayIsolated(positionsFromResult(result.positions));
});

test("high-triangle closed meshes use bounded deterministic scanline sampling", () => {
  const mesh = createSubdividedCube(24);
  const startedAt = performance.now();
  const first = generateMeshHologram(mesh, {
    ...options,
    targetHeight: 384,
    sampleSpacing: 5,
    interiorDensity: 100,
    contentHash: "subdivided-cube-fixture",
  });
  const elapsed = performance.now() - startedAt;
  const second = generateMeshHologram(mesh, {
    ...options,
    targetHeight: 384,
    sampleSpacing: 5,
    interiorDensity: 100,
    contentHash: "subdivided-cube-fixture",
  });

  assert.equal(mesh.indices.length / 3, 6_912);
  assert.equal(first.stats.interiorMode, "closed-volume");
  assert.ok(first.stats.interiorCandidateCount > 0);
  assert.ok(elapsed < 5_000, `topology and scanline sampling took ${elapsed.toFixed(1)} ms`);
  assert.deepEqual([...second.positions], [...first.positions]);
  assertSixWayIsolated(positionsFromResult(first.positions));
});

test("interior density defaults to zero and keeps legacy outline output", () => {
  const implicit = generateMeshHologram(createCube(), options);
  const explicit = generateMeshHologram(createCube(), { ...options, interiorDensity: 0 });

  assert.deepEqual(positionKeys(implicit.positions), positionKeys(explicit.positions));
  assert.equal(implicit.stats.interiorDensity, 0);
  assert.equal(implicit.stats.interiorMode, "disabled");
  assert.equal(implicit.stats.interiorBlockCount, 0);
});

test("closed meshes select deterministic monotonic interior candidates", () => {
  const densities = [0, 1, 25, 50, 75, 100];
  const results = densities.map((interiorDensity) => generateMeshHologram(createCube(), {
    ...options,
    targetHeight: 24,
    sampleSpacing: 4,
    material: "mixed",
    interiorDensity,
    contentHash: "closed-cube-fixture",
    minecraftVersion: "1.20.1",
  }));

  for (let index = 1; index < results.length; index += 1) {
    assert.equal(results[index].stats.interiorMode, "closed-volume");
    assert.ok(
      results[index].stats.interiorSelectedCount >= results[index - 1].stats.interiorSelectedCount,
    );
    assert.equal(
      results[index].stats.interiorCandidateCount,
      results[1].stats.interiorCandidateCount,
    );
    const previous = new Set(positionKeys(results[index - 1].positions));
    const current = new Set(positionKeys(results[index].positions));
    for (const position of previous) {
      assert.ok(current.has(position), `density ${densities[index]} removed ${position}`);
    }
  }
  assert.ok(results.at(-1)!.stats.interiorCandidateCount > 0);
  assert.ok(
    results.at(-1)!.stats.interiorSelectedCount
      <= results.at(-1)!.stats.interiorCandidateCount,
  );

  const repeated = generateMeshHologram(createCube(), {
    ...options,
    targetHeight: 24,
    sampleSpacing: 4,
    interiorDensity: 50,
    contentHash: "closed-cube-fixture",
    minecraftVersion: "1.20.1",
  });
  assert.deepEqual([...repeated.positions], [...results[3].positions]);
  assert.deepEqual([...repeated.materials], [...results[3].materials]);
});

test("triangle-soup winding is checked by geometric edge direction", () => {
  const closed = generateMeshHologram(createTriangleSoupCube(), {
    ...options,
    interiorDensity: 100,
  });
  const flipped = generateMeshHologram(createTriangleSoupCube(true), {
    ...options,
    interiorDensity: 100,
  });

  assert.equal(closed.stats.interiorMode, "closed-volume");
  assert.equal(flipped.stats.interiorMode, "shell-fallback");
  assert.ok(flipped.stats.interiorWarnings.some((warning) => (
    warning.endsWith(".inconsistent-winding")
  )));
});

test("intersecting closed shells conservatively fall back without flagging adjacent cube faces", () => {
  const valid = generateMeshHologram(createCube(), {
    ...options,
    interiorDensity: 100,
  });
  const intersecting = generateMeshHologram(createIntersectingClosedShells(), {
    ...options,
    interiorDensity: 100,
  });

  assert.equal(valid.stats.interiorMode, "closed-volume");
  assert.equal(intersecting.stats.interiorMode, "shell-fallback");
  assert.ok(intersecting.stats.interiorWarnings.some((warning) => (
    warning.endsWith(".self-intersecting")
  )));
});

test("open meshes fall back to a shell and expose a warning", () => {
  const result = generateMeshHologram(createOpenPlane(), {
    ...options,
    targetHeight: 24,
    interiorDensity: 100,
  });

  assert.equal(result.stats.interiorMode, "shell-fallback");
  assert.ok(result.stats.interiorCandidateCount > 0);
  assert.ok(result.stats.interiorWarnings.some((warning) => warning.endsWith(".open")));
});

test("all generated hologram materials obey the X/Y/Z six-way invariant", () => {
  for (const material of ["end_rod", "white_pane", "mixed"] as const) {
    const result = generateMeshHologram(createCube(), {
      ...options,
      material,
      interiorDensity: 100,
    });
    assert.doesNotThrow(() => assertSixWayIsolated(positionsFromResult(result.positions)));
  }

  assert.throws(
    () => assertSixWayIsolated([[0, 0, 0], [0, 1, 0]]),
    /six-way isolation/,
  );
});

test("demo generation reports unavailable interior sampling without a mesh", () => {
  const result = generateHologram({ ...options, interiorDensity: 50 });
  assert.equal(result.stats.interiorMode, "unavailable");
  assert.deepEqual(result.stats.interiorWarnings, ["hologram.interior.unavailable.noMesh"]);
});

test("confirmed oversized holograms exceed legacy candidate and final block thresholds", { timeout: 30_000 }, () => {
  const oversizedOptions = { ...options, targetHeight: 300_000, sampleSpacing: 1 };
  const result = generateHologram(oversizedOptions);

  assert.ok(result.stats.blockCount > MAX_HOLOGRAM_CANDIDATES);
  assert.ok(result.stats.blockCount > MAX_HOLOGRAM_BLOCKS);
  assertSixWayIsolated(positionsFromResult(result.positions));
});
