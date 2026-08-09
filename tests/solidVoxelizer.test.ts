import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSolidVoxels, triangleIntersectsBox } from "../src/core/solidVoxelizer";
import type { MmdMeshSnapshot, SolidOptions } from "../src/types";

const options: SolidOptions = {
  targetHeight: 16,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell",
  palettePreset: "clean",
  faceDetail: "balanced",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: [],
  excludeGravity: true,
  excludeRare: true,
};

const cubeIndices = Uint32Array.from([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  3, 7, 6, 3, 6, 2,
  0, 4, 7, 0, 7, 3,
  1, 2, 6, 1, 6, 5,
]);

const cubeSnapshot = (): MmdMeshSnapshot => ({
  positions: Float32Array.from([
    -1, 0, -1, 1, 0, -1, 1, 2, -1, -1, 2, -1,
    -1, 0, 1, 1, 0, 1, 1, 2, 1, -1, 2, 1,
  ]),
  indices: cubeIndices.slice(),
  triangleMaterials: new Uint16Array(cubeIndices.length / 3),
  materials: [{
    name: "skin",
    englishName: "skin",
    baseColor: [0.88, 0.62, 0.52, 1],
    textureFactor: [1, 1, 1, 1],
    textureIndex: -1,
    textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    wrapS: 1001,
    wrapT: 1001,
    flipY: false,
    ambient: [0, 0, 0],
    emissive: false,
  }],
});

const faceSnapshot = (includeFaceFrame = true): MmdMeshSnapshot => ({
  positions: Float32Array.from([
    -4, 0, 0, 4, 0, 0, 4, 6, 0, -4, 6, 0,
    -2.5, 3, 0.2, -1.5, 3, 0.2, -1.5, 4, 0.2, -2.5, 4, 0.2,
    1.5, 3, 0.2, 2.5, 3, 0.2, 2.5, 4, 0.2, 1.5, 4, 0.2,
  ]),
  indices: Uint32Array.from([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    8, 9, 10, 8, 10, 11,
  ]),
  triangleMaterials: Uint16Array.from([0, 0, 1, 1, 2, 2]),
  faceFrame: includeFaceFrame
    ? {
        origin: [0, 3.5, 0.2],
        right: [1, 0, 0],
        up: [0, 1, 0],
        forward: [0, 0, 1],
        eyeDistance: 4,
        confidence: 1,
      }
    : undefined,
  materials: [
    {
      name: "脸",
      englishName: "face skin",
      baseColor: [0.88, 0.68, 0.62, 1],
      textureFactor: [1, 1, 1, 1],
      textureIndex: -1,
      textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      wrapS: 1001,
      wrapT: 1001,
      flipY: false,
      ambient: [0, 0, 0],
      emissive: false,
    },
    {
      name: "左眼睛",
      englishName: "left eye",
      baseColor: [0.12, 0.25, 0.92, 1],
      textureFactor: [1, 1, 1, 1],
      textureIndex: -1,
      textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      wrapS: 1001,
      wrapT: 1001,
      flipY: false,
      ambient: [0, 0, 0],
      emissive: false,
    },
    {
      name: "右眼睛",
      englishName: "right eye",
      baseColor: [0.9, 0.12, 0.1, 1],
      textureFactor: [1, 1, 1, 1],
      textureIndex: -1,
      textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      wrapS: 1001,
      wrapT: 1001,
      flipY: false,
      ambient: [0, 0, 0],
      emissive: false,
    },
  ],
});

const flatMaterial = (
  name: string,
  englishName: string,
  color: [number, number, number, number],
) => ({
  name,
  englishName,
  baseColor: color,
  textureFactor: [1, 1, 1, 1] as [number, number, number, number],
  textureIndex: -1,
  textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
  wrapS: 1001,
  wrapT: 1001,
  flipY: false,
  ambient: [0, 0, 0] as [number, number, number],
  emissive: false,
});

const projectedFaceSnapshot = (): MmdMeshSnapshot => {
  const positions: number[] = [];
  const indices: number[] = [];
  const triangleMaterials: number[] = [];
  const addQuad = (
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    z: number,
    materialIndex: number,
  ) => {
    const start = positions.length / 3;
    positions.push(
      minX, minY, z,
      maxX, minY, z,
      maxX, maxY, z,
      minX, maxY, z,
    );
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    triangleMaterials.push(materialIndex, materialIndex);
  };

  addQuad(-5, 0, 5, 8, 0, 0);
  addQuad(-5, 0, 5, 8, -2, 0);
  addQuad(-3, 4, -1, 6, -1, 1);
  addQuad(1, 4, 3, 6, -1, 2);
  addQuad(-3, 4, -1, 6, 1, 3);

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleMaterials: Uint16Array.from(triangleMaterials),
    faceFrame: {
      origin: [0, 5, -1],
      right: [1, 0, 0],
      up: [0, 1, 0],
      forward: [0, 0, 1],
      eyeDistance: 4,
      confidence: 1,
    },
    materials: [
      flatMaterial("脸", "face skin", [0.88, 0.68, 0.62, 1]),
      flatMaterial("左眼睛", "left eye", [0.12, 0.25, 0.92, 1]),
      flatMaterial("右眼睛", "right eye", [0.9, 0.12, 0.1, 1]),
      flatMaterial("头发", "hair", [0.15, 0.72, 0.22, 1]),
    ],
  };
};

const positionKeys = (result: ReturnType<typeof generateSolidVoxels>) =>
  Array.from({ length: result.stats.blockCount }, (_, index) =>
    `${result.positions[index * 3]},${result.positions[index * 3 + 1]},${result.positions[index * 3 + 2]}`,
  ).sort();

const blockEntries = (result: ReturnType<typeof generateSolidVoxels>) =>
  Array.from({ length: result.stats.blockCount }, (_, index) => ({
    x: result.positions[index * 3],
    y: result.positions[index * 3 + 1],
    z: result.positions[index * 3 + 2],
    blockId: result.palette[result.blockIndices[index]].blockId,
  }));

test("triangle-box SAT retains a zero-thickness surface crossing a voxel", () => {
  assert.equal(
    triangleIntersectsBox([-2, 0, -2], [2, 0, -2], [0, 0, 2], [0, 0, 0], 0.5),
    true,
  );
  assert.equal(
    triangleIntersectsBox([-2, 2, -2], [2, 2, -2], [0, 2, 2], [0, 0, 0], 0.5),
    false,
  );
});

test("solid voxelizer creates a unique shell and optionally fills enclosed volume", () => {
  const shell = generateSolidVoxels(cubeSnapshot(), options);
  const filled = generateSolidVoxels(cubeSnapshot(), { ...options, fillMode: "filled" });
  const keys = Array.from({ length: shell.stats.blockCount }, (_, index) =>
    `${shell.positions[index * 3]},${shell.positions[index * 3 + 1]},${shell.positions[index * 3 + 2]}`,
  );
  assert.equal(new Set(keys).size, shell.stats.blockCount);
  assert.ok(shell.stats.surfaceBlockCount > 500);
  assert.equal(shell.stats.filledBlockCount, 0);
  assert.ok(filled.stats.blockCount > shell.stats.blockCount);
  assert.ok(filled.stats.filledBlockCount > 0);
  assert.equal(shell.stats.dimensions[1], options.targetHeight);
});

test("alpha threshold discards transparent material triangles", () => {
  const snapshot: MmdMeshSnapshot = {
    positions: Float32Array.from([
      -2, 0, 0, -0.25, 0, 0, -1, 2, 0,
      0.25, 0, 0, 2, 0, 0, 1, 2, 0,
    ]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    triangleMaterials: Uint16Array.from([0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1]),
    materials: [
      {
        name: "opaque",
        englishName: "opaque",
        baseColor: [1, 1, 1, 1],
        textureFactor: [1, 1, 1, 1],
        textureIndex: 0,
        textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        wrapS: 1001,
        wrapT: 1001,
        flipY: false,
        ambient: [0, 0, 0],
        emissive: false,
      },
      {
        name: "transparent",
        englishName: "transparent",
        baseColor: [1, 1, 1, 1],
        textureFactor: [1, 1, 1, 1],
        textureIndex: 1,
        textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        wrapS: 1001,
        wrapT: 1001,
        flipY: false,
        ambient: [0, 0, 0],
        emissive: false,
      },
    ],
    textures: [
      { width: 1, height: 1, pixels: Uint8ClampedArray.from([220, 70, 70, 255]) },
      { width: 1, height: 1, pixels: Uint8ClampedArray.from([70, 70, 220, 0]) },
    ],
  };
  const filtered = generateSolidVoxels(snapshot, options);
  const unfiltered = generateSolidVoxels(snapshot, { ...options, alphaThreshold: 0 });
  assert.ok(filtered.stats.alphaRejected > 0);
  assert.ok(filtered.stats.blockCount < unfiltered.stats.blockCount);
  assert.ok(Math.max(...Array.from(filtered.positions).filter((_, index) => index % 3 === 0)) < 0);
});

test("UV texture sampling produces distinct Minecraft colors", () => {
  const snapshot: MmdMeshSnapshot = {
    positions: Float32Array.from([
      -2, 0, 0, -0.2, 0, 0, -1, 2, 0,
      0.2, 0, 0, 2, 0, 0, 1, 2, 0,
    ]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    triangleMaterials: Uint16Array.from([0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1]),
    materials: [
      {
        name: "red",
        englishName: "red",
        baseColor: [1, 1, 1, 1],
        textureFactor: [1, 1, 1, 1],
        textureIndex: 0,
        textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        wrapS: 1001,
        wrapT: 1001,
        flipY: false,
        ambient: [0, 0, 0],
        emissive: false,
      },
      {
        name: "blue",
        englishName: "blue",
        baseColor: [1, 1, 1, 1],
        textureFactor: [1, 1, 1, 1],
        textureIndex: 1,
        textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        wrapS: 1001,
        wrapT: 1001,
        flipY: false,
        ambient: [0, 0, 0],
        emissive: false,
      },
    ],
    textures: [
      { width: 1, height: 1, pixels: Uint8ClampedArray.from([230, 40, 35, 255]) },
      { width: 1, height: 1, pixels: Uint8ClampedArray.from([35, 65, 225, 255]) },
    ],
  };
  const result = generateSolidVoxels(snapshot, { ...options, skinProtection: false });
  const ids = new Set(result.palette.map((entry) => entry.blockId));
  assert.ok(ids.has("minecraft:red_concrete") || ids.has("minecraft:red_wool"));
  assert.ok(ids.has("minecraft:blue_concrete") || ids.has("minecraft:blue_wool") || ids.has("minecraft:lapis_block"));
  assert.ok(result.palette.length >= 2);
});

test("skin protection restricts matching to clean skin-safe blocks", () => {
  const result = generateSolidVoxels(cubeSnapshot(), {
    ...options,
    skinMaterialIndices: [0],
  });
  const disallowed = new Set(["minecraft:granite", "minecraft:sand", "minecraft:gravel"]);
  assert.equal(result.stats.skinBlockCount, result.stats.blockCount);
  assert.ok(result.palette.every((entry) => !disallowed.has(entry.blockId)));
  assert.ok(result.palette.some((entry) => [
    "minecraft:white_concrete",
    "minecraft:pink_concrete",
    "minecraft:white_terracotta",
    "minecraft:pink_terracotta",
    "minecraft:terracotta",
    "minecraft:smooth_quartz",
    "minecraft:quartz_block",
    "minecraft:calcite",
    "minecraft:smooth_sandstone",
  ].includes(entry.blockId)));
});

test("facial detail preserves eye colors and only recolors existing surface voxels", () => {
  const shared = {
    ...options,
    targetHeight: 7,
    thicknessCompensation: 0,
    skinMaterialIndices: [0, 1, 2],
  };
  const off = generateSolidVoxels(faceSnapshot(), { ...shared, faceDetail: "off" });
  const fallback = generateSolidVoxels(faceSnapshot(false), { ...shared, faceDetail: "balanced" });
  const balanced = generateSolidVoxels(faceSnapshot(), { ...shared, faceDetail: "balanced" });
  const strong = generateSolidVoxels(faceSnapshot(), { ...shared, faceDetail: "strong" });

  assert.deepEqual(positionKeys(balanced), positionKeys(off));
  assert.deepEqual(positionKeys(strong), positionKeys(off));
  assert.equal(balanced.stats.blockCount, off.stats.blockCount);
  assert.equal(strong.stats.blockCount, off.stats.blockCount);

  const isEyeBlock = (blockId: string) => [
    "minecraft:blue_concrete",
    "minecraft:red_concrete",
    "minecraft:orange_concrete",
  ].includes(blockId);
  const eyeCount = (result: ReturnType<typeof generateSolidVoxels>) =>
    blockEntries(result).filter((entry) => isEyeBlock(entry.blockId)).length;
  assert.equal(eyeCount(off), 0);
  assert.ok(eyeCount(fallback) > 0);
  assert.ok(eyeCount(balanced) > eyeCount(fallback));
  assert.ok(eyeCount(strong) >= eyeCount(balanced));

  for (const entry of blockEntries(strong)) {
    if (entry.blockId === "minecraft:blue_concrete") assert.ok(entry.x < 0);
    if (entry.blockId === "minecraft:red_concrete") assert.ok(entry.x > 0);
  }
});

test("facial detail projects recessed features onto the front skin layer without coloring hair", () => {
  const shared = {
    ...options,
    targetHeight: 9,
    thicknessCompensation: 0,
    skinMaterialIndices: [0],
  };
  const off = generateSolidVoxels(projectedFaceSnapshot(), { ...shared, faceDetail: "off" });
  const balanced = generateSolidVoxels(projectedFaceSnapshot(), { ...shared, faceDetail: "balanced" });
  const strong = generateSolidVoxels(projectedFaceSnapshot(), { ...shared, faceDetail: "strong" });
  const isEyeBlock = (blockId: string) => [
    "minecraft:blue_concrete",
    "minecraft:red_concrete",
  ].includes(blockId);
  const entriesAtDepth = (result: ReturnType<typeof generateSolidVoxels>, z: number) =>
    blockEntries(result).filter((entry) => entry.z === z);
  const visibleEyes = (result: ReturnType<typeof generateSolidVoxels>) =>
    entriesAtDepth(result, 0).filter((entry) => isEyeBlock(entry.blockId));

  assert.deepEqual(positionKeys(balanced), positionKeys(off));
  assert.deepEqual(positionKeys(strong), positionKeys(off));
  assert.equal(visibleEyes(off).length, 0);
  assert.ok(visibleEyes(balanced).length > 0);
  assert.ok(visibleEyes(strong).length >= visibleEyes(balanced).length);
  assert.deepEqual(entriesAtDepth(balanced, -2), entriesAtDepth(off, -2));
  assert.deepEqual(entriesAtDepth(strong, -2), entriesAtDepth(off, -2));

  for (const entry of visibleEyes(strong)) {
    if (entry.blockId === "minecraft:blue_concrete") assert.ok(entry.x < 0);
    if (["minecraft:red_concrete", "minecraft:orange_concrete"].includes(entry.blockId)) {
      assert.ok(entry.x > 0);
    }
  }
  assert.deepEqual(entriesAtDepth(balanced, 2), entriesAtDepth(off, 2));
  assert.deepEqual(entriesAtDepth(strong, 2), entriesAtDepth(off, 2));
});

test("solid results retain the normalized face frame used for facial enhancement", () => {
  const result = generateSolidVoxels(faceSnapshot(), {
    ...options,
    targetHeight: 24,
  });

  assert.ok(result.faceFrame);
  assert.ok(Math.abs(result.faceFrame.eyeDistance - (4 * 23 / 6)) < 1e-6);
  assert.deepEqual(result.faceFrame.forward, [0, 0, 1]);
});

test("material themes constrain the output palette without changing voxel coordinates", () => {
  const original = generateSolidVoxels(cubeSnapshot(), options);
  const marble = generateSolidVoxels(cubeSnapshot(), {
    ...options,
    materialTheme: "greekMarble",
  });
  assert.deepEqual(positionKeys(marble), positionKeys(original));
  const allowed = new Set([
    "minecraft:smooth_quartz",
    "minecraft:quartz_block",
    "minecraft:calcite",
    "minecraft:polished_diorite",
    "minecraft:smooth_sandstone",
  ]);
  assert.ok(marble.palette.every((entry) => allowed.has(entry.blockId)));
});

test("emissive materials map to light blocks and can be disabled", () => {
  const snapshot = cubeSnapshot();
  snapshot.materials![0].emissive = true;
  snapshot.materials![0].ambient = [0.8, 0.8, 0.8];
  const glowing = generateSolidVoxels(snapshot, options);
  const disabled = generateSolidVoxels(snapshot, { ...options, emissiveMapping: false });
  const lightBlocks = new Set([
    "minecraft:end_rod",
    "minecraft:glowstone",
    "minecraft:sea_lantern",
    "minecraft:ochre_froglight",
    "minecraft:verdant_froglight",
    "minecraft:pearlescent_froglight",
  ]);
  assert.ok(glowing.palette.every((entry) => lightBlocks.has(entry.blockId)));
  assert.ok(disabled.palette.every((entry) => !lightBlocks.has(entry.blockId)));
  assert.deepEqual(positionKeys(glowing), positionKeys(disabled));
});

test("dithering changes only block selection and preserves protected skin matching", () => {
  const snapshot = cubeSnapshot();
  snapshot.materials![0].baseColor = [0.84, 0.55, 0.7, 1];
  const flat = generateSolidVoxels(snapshot, {
    ...options,
    skinProtection: false,
    dithering: 0,
  });
  const dithered = generateSolidVoxels(snapshot, {
    ...options,
    skinProtection: false,
    dithering: 100,
  });
  const protectedSkin = generateSolidVoxels(snapshot, {
    ...options,
    skinMaterialIndices: [0],
    dithering: 100,
  });
  assert.deepEqual(positionKeys(dithered), positionKeys(flat));
  assert.equal(dithered.stats.blockCount, flat.stats.blockCount);
  assert.ok(dithered.palette.length >= flat.palette.length);
  assert.equal(protectedSkin.stats.skinBlockCount, protectedSkin.stats.blockCount);
});

test("filled projections reject oversized volumes before triangle traversal", () => {
  const snapshot: MmdMeshSnapshot = {
    positions: Float32Array.from([0, 0, 0, 100, 0, 0, 0, 1, 100]),
    indices: Uint32Array.from([0, 1, 2]),
    triangleMaterials: Uint16Array.of(0),
  };
  let progressCalls = 0;
  assert.throws(() => generateSolidVoxels(snapshot, {
    ...options,
    targetHeight: 1_000,
    fillMode: "filled",
  }, () => {
    progressCalls += 1;
  }), /error\.solid\.volumeTooLarge/);
  assert.equal(progressCalls, 0);
});

test("ancient ruins decoration returns internally consistent solid buffers", () => {
  const result = generateSolidVoxels(cubeSnapshot(), {
    ...options,
    materialTheme: "ancientRuins",
    ruinDecoration: 100,
  });
  assert.equal(result.positions.length, result.stats.blockCount * 3);
  assert.equal(result.blockIndices.length, result.stats.blockCount);
  assert.equal(result.palette.length, result.stats.paletteSize);
  assert.ok([...result.blockIndices].every((index) => index < result.palette.length));
  assert.ok(result.palette.some((entry) => [
    "minecraft:mossy_stone_bricks",
    "minecraft:moss_block",
    "minecraft:vine",
    "minecraft:glow_lichen",
  ].includes(entry.blockId)));
  assert.deepEqual(result.stats.dimensions, [
    result.bounds.max[0] - result.bounds.min[0] + 1,
    result.bounds.max[1] - result.bounds.min[1] + 1,
    result.bounds.max[2] - result.bounds.min[2] + 1,
  ]);
});
