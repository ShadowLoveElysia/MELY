import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ClampToEdgeWrapping,
  MirroredRepeatWrapping,
  RepeatWrapping,
} from "three";
import {
  generateSolidVoxels,
  triangleIntersectsBox,
} from "../src/core/solidVoxelizer";
import {
  visitTriangleVoxelCandidates,
  type SolidVoxelPoint,
} from "../src/core/solidVoxelWork";
import type {
  MeshMaterialSnapshot,
  MmdMeshSnapshot,
  SolidOptions,
  SolidVoxelResult,
} from "../src/types";

const shellOptions: SolidOptions = {
  targetHeight: 16,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell",
  palettePreset: "clean",
  faceDetail: "off",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: false,
  skinMaterialIndices: [],
  excludeGravity: true,
  excludeRare: true,
};

const material = (
  name: string,
  baseColor: [number, number, number, number],
  overrides: Partial<MeshMaterialSnapshot> = {},
): MeshMaterialSnapshot => ({
  name,
  englishName: name,
  baseColor,
  textureFactor: [1, 1, 1, 1],
  textureIndex: -1,
  textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  flipY: false,
  ambient: [0, 0, 0],
  emissive: false,
  ...overrides,
});

interface CanonicalVoxel {
  x: number;
  y: number;
  z: number;
  blockId: string;
}

const compareVoxels = (left: CanonicalVoxel, right: CanonicalVoxel) =>
  left.y - right.y
  || left.z - right.z
  || left.x - right.x
  || (left.blockId < right.blockId ? -1 : left.blockId > right.blockId ? 1 : 0);

/** 将 flat 和 chunked 结果归一到同一语义表示，供跨后端比较。 */
const canonicalVoxels = (result: SolidVoxelResult) => {
  const voxels: CanonicalVoxel[] = [];
  if (result.storage === "chunked") {
    for (const chunk of result.chunks ?? []) {
      for (let index = 0; index < chunk.positions.length; index += 1) {
        const local = chunk.positions[index];
        voxels.push({
          x: chunk.chunk[0] * 32 + (local & 31),
          y: chunk.chunk[1] * 32 + ((local >> 10) & 31),
          z: chunk.chunk[2] * 32 + ((local >> 5) & 31),
          blockId: result.palette[chunk.blockIndices[index]].blockId,
        });
      }
    }
  } else {
    for (let index = 0; index < result.blockIndices.length; index += 1) {
      voxels.push({
        x: result.positions[index * 3],
        y: result.positions[index * 3 + 1],
        z: result.positions[index * 3 + 2],
        blockId: result.palette[result.blockIndices[index]].blockId,
      });
    }
  }
  return voxels.sort(compareVoxels);
};

/**
 * 内容摘要只包含投影语义；线程数、后端、执行偏好、进度、计时和存储布局不得进入合同。
 */
const semanticContract = (result: SolidVoxelResult) => {
  const voxels = canonicalVoxels(result);
  return {
    palette: [...new Set(voxels.map(voxel => voxel.blockId))].sort(),
    bounds: result.bounds,
    blockCount: result.stats.blockCount,
    surfaceBlockCount: result.stats.surfaceBlockCount,
    filledBlockCount: result.stats.filledBlockCount,
    skinBlockCount: result.stats.skinBlockCount,
    dimensions: result.stats.dimensions,
    voxels,
  };
};

const storageContract = (result: SolidVoxelResult) => ({
  storage: result.storage ?? "flat",
  palette: result.palette,
  bounds: result.bounds,
  stats: result.stats,
  faceFrame: result.faceFrame ?? null,
  positions: [...result.positions],
  blockIndices: [...result.blockIndices],
  chunks: (result.chunks ?? []).map(chunk => ({
    chunk: chunk.chunk,
    positions: [...chunk.positions],
    blockIndices: [...chunk.blockIndices],
  })),
});

const sha256 = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

const crossChunkSnapshot = (): MmdMeshSnapshot => ({
  positions: Float32Array.from([
    -1, 0, -1,
    1, 0, -1,
    1, 2, -1,
    -1, 2, -1,
    -1, 0, 1,
    1, 0, 1,
    1, 2, 1,
    -1, 2, 1,
  ]),
  indices: Uint32Array.from([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3,
    1, 2, 6, 1, 6, 5,
  ]),
  triangleMaterials: Uint16Array.from([
    0, 0,
    1, 1,
    2, 2,
    3, 3,
    4, 4,
    5, 5,
  ]),
  materials: [
    material("red", [1, 0, 0, 1]),
    material("green", [0, 1, 0, 1]),
    material("blue", [0, 0, 1, 1]),
    material("yellow", [1, 1, 0, 1]),
    material("magenta", [1, 0, 1, 1]),
    material("cyan", [0, 1, 1, 1]),
  ],
});

const collisionSnapshot = (
  secondMaterial: MeshMaterialSnapshot,
  secondDepth = 0,
): MmdMeshSnapshot => ({
  positions: Float32Array.from([
    -1, 0, 0.2,
    1, 0, 0.2,
    0, 2, 0.2,
    -1, 0, secondDepth,
    1, 0, secondDepth,
    0, 2, secondDepth,
    0, 0, -1,
    0, 0, 1,
  ]),
  indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
  triangleMaterials: Uint16Array.from([0, 1]),
  materials: [
    material("first red", [142 / 255, 32 / 255, 32 / 255, 1]),
    secondMaterial,
  ],
});

test("chunked solid golden is stable across consecutive runs and storage modes", () => {
  const generationOptions = {
    ...shellOptions,
    targetHeight: 66,
  };
  const first = generateSolidVoxels(
    crossChunkSnapshot(),
    generationOptions,
    undefined,
    { flatVoxelLimit: 0 },
  );
  const firstStorageDigest = sha256(storageContract(first));
  const firstSemanticDigest = sha256(semanticContract(first));

  assert.equal(first.storage, "chunked");
  assert.deepEqual(first.bounds, { min: [-33, 0, -33], max: [33, 65, 33] });
  assert.deepEqual(first.stats, {
    blockCount: 42_258,
    surfaceBlockCount: 42_258,
    filledBlockCount: 0,
    skinBlockCount: 0,
    alphaRejected: 0,
    triangleBoxTests: 45_808,
    paletteSize: 6,
    dimensions: [67, 66, 67],
  });
  assert.deepEqual(first.palette.map(entry => entry.blockId), [
    "minecraft:orange_concrete",
    "minecraft:blue_wool",
    "minecraft:magenta_wool",
    "minecraft:prismarine_bricks",
    "minecraft:lime_wool",
    "minecraft:yellow_wool",
  ]);
  assert.equal(
    firstStorageDigest,
    "e465f26d041179c31909f282aaae7e3b5733756125212af96ec7d7d37608ca03",
  );
  assert.equal(
    firstSemanticDigest,
    "701c54c4565df1ec91763fa126aaae74a1e6ef590b6ef357a3f0d639ea00ec70",
  );

  for (let run = 0; run < 2; run += 1) {
    const repeated = generateSolidVoxels(
      crossChunkSnapshot(),
      generationOptions,
      undefined,
      { flatVoxelLimit: 0 },
    );
    assert.equal(sha256(storageContract(repeated)), firstStorageDigest);
  }

  const flat = generateSolidVoxels(crossChunkSnapshot(), generationOptions);
  assert.equal(flat.storage, "flat");
  assert.equal(sha256(semanticContract(flat)), firstSemanticDigest);

  const voxels = canonicalVoxels(first);
  const xCoordinates = new Set(voxels.map(voxel => voxel.x));
  for (const boundary of [-32, -1, 0, 31, 32]) {
    assert.equal(xCoordinates.has(boundary), true, `missing X=${boundary}`);
  }
  const chunkX = new Set(first.chunks!.map(chunk => chunk.chunk[0]));
  assert.deepEqual([...chunkX].sort((a, b) => a - b), [-2, -1, 0, 1]);
});

test("voxel collision winner follows feature, distance, then original triangle order", () => {
  const blue = material("second blue", [44 / 255, 46 / 255, 143 / 255, 1]);
  const exactTie = collisionSnapshot(blue, 0.2);
  const distanceWinner = collisionSnapshot(blue, 0.05);
  const featureWinner = collisionSnapshot(material(
    "左眼睛",
    [44 / 255, 46 / 255, 143 / 255, 1],
    { englishName: "left eye" },
  ), 0.2);
  const generationOptions = {
    ...shellOptions,
    targetHeight: 5,
    thicknessCompensation: 0,
  };
  const ids = (snapshot: MmdMeshSnapshot, options = generationOptions) => [
    ...new Set(canonicalVoxels(generateSolidVoxels(snapshot, options)).map(voxel => voxel.blockId)),
  ];

  assert.deepEqual(ids(exactTie), ["minecraft:red_concrete"]);
  assert.deepEqual(ids(distanceWinner), ["minecraft:blue_concrete"]);
  assert.deepEqual(ids(featureWinner, { ...generationOptions, faceDetail: "balanced" }), [
    "minecraft:blue_concrete",
  ]);
});

test("triangle-box contact is inclusive for face, edge, and corner grazing", () => {
  const touching: [SolidVoxelPoint, SolidVoxelPoint, SolidVoxelPoint][] = [
    [[0.5, -1, -1], [0.5, 1, -1], [0.5, 0, 1]],
    [[0.5, 0.5, -1], [0.5, 0.5, 1], [0.5, 0.5, 0]],
    [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]],
  ];
  const separated: [SolidVoxelPoint, SolidVoxelPoint, SolidVoxelPoint][] = touching.map(
    triangle => triangle.map(point => [point[0] + 1e-7, point[1], point[2]] as const) as [
      SolidVoxelPoint,
      SolidVoxelPoint,
      SolidVoxelPoint,
    ],
  );

  for (const triangle of touching) {
    assert.equal(triangleIntersectsBox(
      [...triangle[0]],
      [...triangle[1]],
      [...triangle[2]],
      [0, 0, 0],
      0.5,
    ), true);
  }
  for (const triangle of separated) {
    assert.equal(triangleIntersectsBox(
      [...triangle[0]],
      [...triangle[1]],
      [...triangle[2]],
      [0, 0, 0],
      0.5,
    ), false);
  }
});

test("degenerate scan order has a stable golden for collinear, near-degenerate, and point input", () => {
  const fixtures: [SolidVoxelPoint, SolidVoxelPoint, SolidVoxelPoint][] = [
    [[-12, -2, 1], [15, 5, 8], [2, 1.6296296296, 4.6296296296]],
    [[-6, 0, -2], [8, 0.00000001, 5], [1, 0.000000011, 1.500000001]],
    [[1.25, -2.5, 3.75], [1.25, -2.5, 3.75], [1.25, -2.5, 3.75]],
  ];
  const scanFixture = (triangle: typeof fixtures[number]) => {
    const candidates: string[] = [];
    const result = visitTriangleVoxelCandidates(...triangle, 0.58, (x, y, z) => {
      candidates.push(`${x},${y},${z}`);
    });
    return { result, candidates };
  };
  const first = fixtures.map(scanFixture);

  assert.equal(sha256(first), "9108d35c18bbdf87f74160911af7b9953c24c73885b197f0b4e9416b87ace7c0");
  for (let run = 0; run < 3; run += 1) {
    assert.deepEqual(fixtures.map(scanFixture), first);
  }
  assert.ok(first.every(scan => scan.result.completed));
  assert.ok(first.every(scan => scan.result.candidateCount === scan.candidates.length));
});

test("texture alpha equal to the threshold survives while the next byte below is rejected", () => {
  const snapshot: MmdMeshSnapshot = {
    positions: Float32Array.from([
      -3, 0, 0, -1, 0, 0, -2, 2, 0,
      1, 0, 0, 3, 0, 0, 2, 2, 0,
    ]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    triangleMaterials: Uint16Array.from([0, 1]),
    uvs: Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    materials: [
      material("accepted", [1, 1, 1, 1], { textureIndex: 0, hasTexture: true }),
      material("rejected", [1, 1, 1, 1], { textureIndex: 1, hasTexture: true }),
    ],
    textures: [
      { width: 1, height: 1, pixels: Uint8ClampedArray.from([255, 0, 0, 128]) },
      { width: 1, height: 1, pixels: Uint8ClampedArray.from([0, 0, 255, 127]) },
    ],
  };
  const result = generateSolidVoxels(snapshot, {
    ...shellOptions,
    targetHeight: 9,
    alphaThreshold: 128 / 255,
    thicknessCompensation: 0,
  });
  const voxels = canonicalVoxels(result);

  assert.ok(voxels.length > 0);
  assert.ok(voxels.every(voxel => voxel.x < 0));
  assert.deepEqual(result.palette.map(entry => entry.blockId), ["minecraft:orange_concrete"]);
  assert.ok(result.stats.alphaRejected > 0);
  assert.equal(
    sha256(semanticContract(result)),
    "6bf9d7496ecbc6f74cd21030b143f19e147749b9d5685294608a18bc9fce9a15",
  );
});

test("repeat, mirrored-repeat, and clamp texture wrapping retain distinct golden samples", () => {
  const snapshot: MmdMeshSnapshot = {
    positions: Float32Array.from([
      -5, 0, 0, -3, 0, 0, -4, 2, 0,
      -1, 0, 0, 1, 0, 0, 0, 2, 0,
      3, 0, 0, 5, 0, 0, 4, 2, 0,
    ]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    triangleMaterials: Uint16Array.from([0, 1, 2]),
    uvs: Float32Array.from([
      -0.25, 0, -0.25, 0, -0.25, 0,
      -0.25, 0, -0.25, 0, -0.25, 0,
      -0.25, 0, -0.25, 0, -0.25, 0,
    ]),
    materials: [
      material("repeat", [1, 1, 1, 1], {
        textureIndex: 0,
        hasTexture: true,
        wrapS: RepeatWrapping,
      }),
      material("mirror", [1, 1, 1, 1], {
        textureIndex: 0,
        hasTexture: true,
        wrapS: MirroredRepeatWrapping,
      }),
      material("clamp", [1, 1, 1, 1], {
        textureIndex: 0,
        hasTexture: true,
        wrapS: ClampToEdgeWrapping,
      }),
    ],
    textures: [{
      width: 5,
      height: 1,
      pixels: Uint8ClampedArray.from([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
      ]),
    }],
  };
  const result = generateSolidVoxels(snapshot, {
    ...shellOptions,
    targetHeight: 9,
    thicknessCompensation: 0,
  });
  const voxels = canonicalVoxels(result);
  const idsAt = (predicate: (x: number) => boolean) => [...new Set(
    voxels.filter(voxel => predicate(voxel.x)).map(voxel => voxel.blockId),
  )];

  assert.deepEqual(idsAt(x => x < -8), ["minecraft:blue_wool"]);
  assert.deepEqual(idsAt(x => x >= -8 && x <= 8), ["minecraft:lime_wool"]);
  assert.deepEqual(idsAt(x => x > 8), ["minecraft:orange_concrete"]);
  assert.equal(
    sha256(semanticContract(result)),
    "80192a4dfd47cba57b780b4e10f88aa46400762fccc5415a2f81b989f66a527d",
  );
});
