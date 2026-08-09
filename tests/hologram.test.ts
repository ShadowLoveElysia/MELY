import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMeshHologram } from "../src/core/hologram";
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

const options: HologramOptions = {
  targetHeight: 32,
  sampleSpacing: 2,
  material: "mixed",
  directionMode: "vertical",
  isolatePanes: true,
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
