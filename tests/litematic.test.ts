import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import * as nbt from "prismarine-nbt";
import { createLitematic, packBlockStates, unpackBlockState } from "../src/core/litematic";
import type { HologramOptions, HologramResult } from "../src/types";
import type { SolidOptions, SolidVoxelResult } from "../src/types";

const options: HologramOptions = {
  targetHeight: 32,
  sampleSpacing: 2,
  material: "mixed",
  directionMode: "vertical",
  isolatePanes: true,
  preserveFace: true,
  glow: 70,
};

const unpackPrismarineLong = (value: [number, number]) =>
  (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0);

const unpackIndependent = (
  longs: [number, number][],
  index: number,
  bitsPerBlock: number,
) => {
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const bitOffset = index * bitsPerBlock;
  const longIndex = Math.floor(bitOffset / 64);
  const innerOffset = bitOffset & 63;
  const first = unpackPrismarineLong(longs[longIndex]);
  const available = 64 - innerOffset;

  if (available >= bitsPerBlock) {
    return Number((first >> BigInt(innerOffset)) & mask);
  }

  const second = unpackPrismarineLong(longs[longIndex + 1]);
  return Number(((first >> BigInt(innerOffset)) | (second << BigInt(available))) & mask);
};

test("continuous palette indices survive 64-bit boundaries", () => {
  for (const paletteSize of [2, 3, 4, 5, 7, 16, 17, 33]) {
    const indices = Uint32Array.from({ length: 257 }, (_, index) =>
      (index * 7 + Math.floor(index / 3)) % paletteSize,
    );
    const { packed, bitsPerBlock } = packBlockStates(indices, paletteSize);
    assert.equal(packed.length, Math.ceil((indices.length * bitsPerBlock) / 64));
    indices.forEach((expected, index) => {
      assert.equal(unpackBlockState(packed, index, bitsPerBlock), expected);
    });
  }
});

test("generated file is a valid Minecraft 1.20.1 Litematica v6 schematic", async () => {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    2, 0, 0,
    3, 0, 0,
    4, 0, 0,
    5, 0, 0,
    6, 0, 0,
  ]);
  const result: HologramResult = {
    positions,
    facings: new Uint8Array([2, 2, 2, 2, 2, 2, 2]),
    materials: new Uint8Array([0, 0, 0, 0, 0, 0, 1]),
    stats: {
      blockCount: 7,
      endRodCount: 6,
      paneCount: 1,
      removedConflicts: 0,
      dimensions: [7, 1, 1],
    },
    bounds: {
      min: [0, 0, 0],
      max: [6, 0, 0],
    },
  };

  const exported = createLitematic(result, options, {
    name: "MELY_Format_Test",
    timestamp: 1_786_000_000_000,
  });
  assert.deepEqual([...exported.bytes.slice(0, 2)], [0x1f, 0x8b]);

  const { parsed, type } = await nbt.parse(Buffer.from(exported.bytes), "big");
  assert.equal(type, "big");
  assert.equal(parsed.type, "compound");
  const root = nbt.simplify(parsed) as any;
  const region = root.Regions.Hologram;

  assert.equal(root.Version, 6);
  assert.equal(root.SubVersion, 1);
  assert.equal(root.MinecraftDataVersion, 3465);
  assert.deepEqual(root.Metadata.EnclosingSize, { x: 7, y: 1, z: 1 });
  assert.equal(root.Metadata.TotalBlocks, 7);
  assert.equal(root.Metadata.TotalVolume, 7);
  assert.equal(root.Metadata.RegionCount, 1);
  assert.deepEqual(region.Position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(region.Size, { x: 7, y: 1, z: 1 });

  const palette = region.BlockStatePalette as Array<{
    Name: string;
    Properties?: Record<string, string>;
  }>;
  assert.equal(palette[0].Name, "minecraft:air");
  const facings = new Set(
    palette
      .filter((state) => state.Name === "minecraft:end_rod")
      .map((state) => state.Properties?.facing),
  );
  assert.deepEqual(facings, new Set(["up"]));

  const pane = palette.find((state) => state.Name === "minecraft:white_stained_glass_pane");
  assert.deepEqual(pane?.Properties, {
    east: "false",
    north: "false",
    south: "false",
    waterlogged: "false",
    west: "false",
  });

  const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const blockStates = region.BlockStates as [number, number][];
  const decoded = Array.from({ length: 7 }, (_, index) =>
    unpackIndependent(blockStates, index, bitsPerBlock),
  );
  assert.equal(decoded.filter((index) => index !== 0).length, 7);
  assert.ok(decoded.every((index) => index >= 0 && index < palette.length));

  const rawRegion = (parsed as any).value.Regions.value.Hologram.value;
  for (const key of ["Entities", "TileEntities", "PendingBlockTicks", "PendingFluidTicks"]) {
    assert.equal(rawRegion[key].type, "list");
    assert.equal(rawRegion[key].value.value.length, 0);
  }
});

test("white panes remain independent even when an older option disables isolation", async () => {
  const result: HologramResult = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0]),
    facings: Uint8Array.from([2, 2]),
    materials: Uint8Array.from([1, 1]),
    stats: {
      blockCount: 2,
      endRodCount: 0,
      paneCount: 2,
      removedConflicts: 0,
      dimensions: [2, 1, 1],
    },
    bounds: { min: [0, 0, 0], max: [1, 0, 0] },
  };
  const exported = createLitematic(result, { ...options, isolatePanes: false }, { timestamp: 1 });
  const { parsed } = await nbt.parse(Buffer.from(exported.bytes), "big");
  const root = nbt.simplify(parsed) as any;
  const pane = root.Regions.Hologram.BlockStatePalette.find(
    (state: any) => state.Name === "minecraft:white_stained_glass_pane",
  );
  assert.deepEqual(pane.Properties, {
    east: "false",
    north: "false",
    south: "false",
    waterlogged: "false",
    west: "false",
  });
});

test("solid projection writes its Minecraft block palette and indices", async () => {
  const result: SolidVoxelResult = {
    kind: "solid",
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    blockIndices: Uint16Array.from([0, 1, 0]),
    palette: [
      { blockId: "minecraft:white_terracotta", color: [209, 178, 161] },
      { blockId: "minecraft:black_concrete", color: [8, 10, 15] },
    ],
    stats: {
      blockCount: 3,
      surfaceBlockCount: 3,
      filledBlockCount: 0,
      skinBlockCount: 2,
      alphaRejected: 0,
      triangleBoxTests: 10,
      paletteSize: 2,
      dimensions: [2, 2, 1],
    },
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
  const solidOptions: SolidOptions = {
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
    skinMaterialIndices: [0],
    excludeGravity: true,
    excludeRare: true,
  };
  const exported = createLitematic(result, solidOptions, { name: "MELY_Solid_Test", timestamp: 1 });
  const { parsed } = await nbt.parse(Buffer.from(exported.bytes), "big");
  const root = nbt.simplify(parsed) as any;
  const region = root.Regions.Hologram;
  assert.equal(root.MinecraftDataVersion, 3465);
  assert.equal(root.Metadata.TotalBlocks, 3);
  assert.deepEqual(
    region.BlockStatePalette.map((state: any) => state.Name),
    ["minecraft:air", "minecraft:white_terracotta", "minecraft:black_concrete"],
  );
  const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(region.BlockStatePalette.length)));
  const decoded = Array.from({ length: 4 }, (_, index) =>
    unpackIndependent(region.BlockStates, index, bitsPerBlock),
  );
  assert.deepEqual(decoded, [1, 2, 1, 0]);
});

test("sparse tall projections export as bounded multi-region Litematica data", async () => {
  const result: SolidVoxelResult = {
    kind: "solid",
    positions: Float32Array.from([
      0, 0, 0,
      31, 31, 31,
      0, 2_031, 0,
    ]),
    blockIndices: Uint16Array.from([0, 0, 0]),
    palette: [{ blockId: "minecraft:white_concrete", color: [207, 213, 214] }],
    stats: {
      blockCount: 3,
      surfaceBlockCount: 3,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 3,
      paletteSize: 1,
      dimensions: [32, 2_032, 32],
    },
    bounds: { min: [0, 0, 0], max: [31, 2_031, 31] },
  };
  const exported = createLitematic(result, {
    targetHeight: 2_032,
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
  }, { timestamp: 1, regionMaxSize: 32 });
  const { parsed } = await nbt.parse(Buffer.from(exported.bytes), "big");
  const root = nbt.simplify(parsed) as any;
  assert.equal(root.Metadata.RegionCount, 2);
  assert.equal(root.Metadata.TotalBlocks, 3);
  assert.equal(root.Metadata.TotalVolume, 32 ** 3 + 32 * 16 * 32);
  assert.deepEqual(root.Metadata.EnclosingSize, { x: 32, y: 2_032, z: 32 });
  assert.equal(exported.summary.regionCount, 2);
  assert.ok(exported.summary.volume < 32 * 2_032 * 32);
  assert.deepEqual(Object.values(root.Regions).map((region: any) => region.Size), [
    { x: 32, y: 32, z: 32 },
    { x: 32, y: 16, z: 32 },
  ]);
  assert.deepEqual(Object.values(root.Regions).map((region: any) => region.Position), [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 2_016, z: 0 },
  ]);
});
