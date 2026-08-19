import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import * as nbt from "prismarine-nbt";
import { encode, Int, type TagObject } from "nbt-ts";
import { gzip, ungzip } from "pako";
import {
  createLitematic,
  createLitematicFromDocument,
  packBlockStates,
  streamLitematicFromDocument,
  unpackBlockState,
} from "../src/core/litematic";
import {
  createProjectionDocument,
  iterateProjectionViewBlocks,
  splitProjectionViews,
} from "../src/core/projectionDocument";
import type { HologramOptions, HologramResult } from "../src/types";
import type { SolidOptions, SolidVoxelResult } from "../src/types";

const options: HologramOptions = {
  targetHeight: 32,
  sampleSpacing: 2,
  material: "mixed",
  directionMode: "vertical",
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

const legacyLitematicBytes = (
  document: ReturnType<typeof createProjectionDocument>,
  name: string,
  author: string,
  timestamp: number,
) => {
  const palette = [
    { Name: "minecraft:air" },
    ...document.palette.map((state) => ({
      Name: state.blockId,
      ...(state.properties ? { Properties: { ...state.properties } } : {}),
    })),
  ];
  const views = splitProjectionViews(document, 32);
  const regions: Record<string, TagObject> = {};
  let totalVolume = 0;
  for (const view of views) {
    const [sizeX, sizeY, sizeZ] = view.bounds.dimensions;
    const volume = sizeX * sizeY * sizeZ;
    const indices = new Uint32Array(volume);
    for (const block of iterateProjectionViewBlocks(document, view)) {
      const x = block.position[0] - view.bounds.min[0];
      const y = block.position[1] - view.bounds.min[1];
      const z = block.position[2] - view.bounds.min[2];
      indices[(y * sizeZ + z) * sizeX + x] = block.paletteIndex + 1;
    }
    totalVolume += volume;
    const region = views.length === 1
      ? "Hologram"
      : `R_${view.index[1]}_${view.index[2]}_${view.index[0]}`;
    regions[region] = {
      Position: {
        x: new Int(view.bounds.min[0] - document.bounds!.min[0]),
        y: new Int(view.bounds.min[1] - document.bounds!.min[1]),
        z: new Int(view.bounds.min[2] - document.bounds!.min[2]),
      },
      Size: {
        x: new Int(sizeX),
        y: new Int(sizeY),
        z: new Int(sizeZ),
      },
      BlockStatePalette: palette,
      BlockStates: packBlockStates(indices, palette.length).packed,
      Entities: [],
      TileEntities: [],
      PendingBlockTicks: [],
      PendingFluidTicks: [],
    };
  }
  const [sizeX, sizeY, sizeZ] = document.bounds!.dimensions;
  return gzip(encode("", {
    Version: new Int(6),
    SubVersion: new Int(1),
    MinecraftDataVersion: new Int(3465),
    Metadata: {
      EnclosingSize: { x: new Int(sizeX), y: new Int(sizeY), z: new Int(sizeZ) },
      Author: author,
      Description: "MELY | Minecraft 1.20.1",
      Name: name,
      Software: "MELY_1.0.0",
      TargetMinecraftVersion: "1.20.1",
      SerializerMinecraftVersion: "1.20.1",
      CompatibilityLevel: "exact",
      CompatibilityWarning: "",
      RegionCount: new Int(views.length),
      TimeCreated: BigInt(timestamp),
      TimeModified: BigInt(timestamp),
      TotalBlocks: new Int(document.blockCount),
      TotalVolume: new Int(totalVolume),
      PreviewImageData: new Int32Array(0),
    },
    Regions: regions,
  }), { level: 9 });
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
    2, 0, 0,
    4, 0, 0,
    6, 0, 0,
    8, 0, 0,
    10, 0, 0,
    12, 0, 0,
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
      dimensions: [13, 1, 1],
    },
    bounds: {
      min: [0, 0, 0],
      max: [12, 0, 0],
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
  assert.deepEqual(root.Metadata.EnclosingSize, { x: 13, y: 1, z: 1 });
  assert.equal(root.Metadata.TotalBlocks, 7);
  assert.equal(root.Metadata.TotalVolume, 13);
  assert.equal(root.Metadata.RegionCount, 1);
  assert.deepEqual(region.Position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(region.Size, { x: 13, y: 1, z: 1 });

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
  const decoded = Array.from({ length: 13 }, (_, index) =>
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

test("streaming Litematic output matches the synchronous compatibility API", async () => {
  const document = createProjectionDocument([
    { position: [-33, -2, 0], paletteIndex: 0 },
    { position: [-1, -1, 31], paletteIndex: 1 },
    { position: [0, 0, 32], paletteIndex: 0 },
    { position: [35, 33, 65], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete", properties: { axis: "x" } },
    { blockId: "minecraft:black_concrete" },
  ]);
  const exportOptions = {
    name: "流式 NBT 测试",
    author: "MELY 测试",
    timestamp: 1_786_000_000_000,
    regionMaxSize: 32,
  } as const;
  const synchronous = createLitematicFromDocument(document, exportOptions);
  const legacyBytes = legacyLitematicBytes(
    document,
    exportOptions.name,
    exportOptions.author,
    exportOptions.timestamp,
  );
  assert.deepEqual(ungzip(synchronous.bytes), ungzip(legacyBytes));
  assert.deepEqual(synchronous.bytes, legacyBytes);
  const chunks: Uint8Array[] = [];
  const summary = await streamLitematicFromDocument(document, async (chunk) => {
    await Promise.resolve();
    chunks.push(chunk);
  }, exportOptions);
  const streamed = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  assert.deepEqual(streamed, Buffer.from(synchronous.bytes));
  assert.deepEqual(summary, synchronous.summary);
  assert.ok(chunks.length >= 1);

  const { parsed } = await nbt.parse(streamed, "big");
  const root = nbt.simplify(parsed) as any;
  assert.equal(root.Metadata.TotalBlocks, 4);
  assert.equal(root.Metadata.RegionCount, 4);
  assert.deepEqual(root.Metadata.EnclosingSize, { x: 69, y: 36, z: 66 });
});

test("many sparse regions stream without retaining a Regions tag object", async () => {
  const regionCount = 1_024;
  const document = createProjectionDocument(
    Array.from({ length: regionCount }, (_, index) => ({
      position: [index * 32, index % 7, index % 11] as [number, number, number],
      paletteIndex: 0,
    })),
    [{ blockId: "minecraft:white_concrete" }],
  );
  const chunks: Uint8Array[] = [];
  const summary = await streamLitematicFromDocument(document, (chunk) => {
    chunks.push(chunk);
  }, { timestamp: 1, regionMaxSize: 32 });

  assert.equal(summary.regionCount, regionCount);
  assert.equal(summary.blockCount, regionCount);
  assert.ok(chunks.length >= 1);
  assert.equal(
    summary.byteLength,
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  const { parsed } = await nbt.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), "big");
  const root = nbt.simplify(parsed) as any;
  assert.equal(Object.keys(root.Regions).length, regionCount);
  assert.equal(root.Metadata.TotalBlocks, regionCount);
});

test("streaming sink is awaited serially and receives multiple owned gzip chunks", async () => {
  const blockCount = 700_000;
  const document = createProjectionDocument(
    Array.from({ length: blockCount }, (_, index) => ({
      position: [index % 2_000, Math.floor(index / 2_000), 0] as [number, number, number],
      paletteIndex: (
        Math.imul(index ^ (index >>> 16), 0x45d9f3b)
        ^ Math.imul(index ^ (index >>> 13), 0x119de1f3)
      ) >>> 28,
    })),
    [
      { blockId: "minecraft:white_concrete" },
      { blockId: "minecraft:black_concrete" },
      { blockId: "minecraft:red_concrete" },
      { blockId: "minecraft:blue_concrete" },
      { blockId: "minecraft:green_concrete" },
      { blockId: "minecraft:yellow_concrete" },
      { blockId: "minecraft:orange_concrete" },
      { blockId: "minecraft:purple_concrete" },
      { blockId: "minecraft:cyan_concrete" },
      { blockId: "minecraft:lime_concrete" },
      { blockId: "minecraft:pink_concrete" },
      { blockId: "minecraft:brown_concrete" },
      { blockId: "minecraft:gray_concrete" },
      { blockId: "minecraft:light_gray_concrete" },
      { blockId: "minecraft:light_blue_concrete" },
      { blockId: "minecraft:magenta_concrete" },
    ],
  );
  const chunks: Uint8Array[] = [];
  let activeSinks = 0;
  let maximumActiveSinks = 0;
  const summary = await streamLitematicFromDocument(document, async (chunk) => {
    activeSinks += 1;
    maximumActiveSinks = Math.max(maximumActiveSinks, activeSinks);
    await new Promise<void>((resolve) => setImmediate(resolve));
    chunks.push(chunk);
    activeSinks -= 1;
  }, { timestamp: 1, regionMaxSize: [2_048, 384, 1] });

  assert.equal(maximumActiveSinks, 1);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.byteLength <= 16 * 1024));
  assert.equal(summary.byteLength, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const { parsed } = await nbt.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), "big");
  assert.equal((nbt.simplify(parsed) as any).Metadata.TotalBlocks, blockCount);
});

test("Litematic NBT rejects values that would silently wrap signed fields", async () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);

  assert.throws(
    () => createLitematicFromDocument(document, { timestamp: Number.NaN }),
    /timestamp must be a safe integer/,
  );
  assert.throws(
    () => createLitematicFromDocument(document, { timestamp: 1.5 }),
    /timestamp must be a safe integer/,
  );
  assert.throws(
    () => createLitematicFromDocument(document, { author: "界".repeat(22_000), timestamp: 1 }),
    /UTF-8 string limit/,
  );
  await assert.rejects(
    () => streamLitematicFromDocument(document, () => undefined, {
      timestamp: 1,
      signal: AbortSignal.abort(new DOMException("cancelled", "AbortError")),
    }),
    /cancelled/,
  );
});

test("coordinate isolation cannot be bypassed by direct serialization", () => {
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
  assert.throws(
    () => createLitematic(result, options, { timestamp: 1 }),
    /six-way isolation/,
  );
});

test("registered untested versions use an explicit Litematica compatibility serializer", async () => {
  const untested = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], { minecraftVersion: "1.20.2" });
  const exported = createLitematicFromDocument(untested, { timestamp: 1 });
  const { parsed } = await nbt.parse(Buffer.from(exported.bytes), "big");
  const root = nbt.simplify(parsed) as any;

  assert.equal(root.Version, 6);
  assert.equal(root.SubVersion, 1);
  assert.equal(root.MinecraftDataVersion, 3465);
  assert.equal(root.Metadata.TargetMinecraftVersion, "1.20.2");
  assert.equal(root.Metadata.SerializerMinecraftVersion, "1.20.1");
  assert.equal(root.Metadata.CompatibilityLevel, "best_effort");
  assert.equal(root.Metadata.CompatibilityWarning, "JAVA_VERSION_BEST_EFFORT");
  assert.match(root.Metadata.Description, /Target Minecraft 1\.20\.2 is untested/);
  assert.equal(exported.summary.minecraftVersion, "1.20.2");
  assert.equal(exported.summary.serializerMinecraftVersion, "1.20.1");
  assert.equal(exported.summary.dataVersion, 3465);
  assert.equal(exported.summary.formatVersion, 6);
  assert.equal(exported.summary.subVersion, 1);
  assert.equal(exported.summary.compatibilityLevel, "best_effort");
  assert.equal(exported.summary.compatibilityWarningCode, "JAVA_VERSION_BEST_EFFORT");
});

test("direct Litematica serialization still rejects injected adjacency", () => {

  const adjacent = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [1, 0, 0], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:end_rod" },
    { blockId: "minecraft:white_stained_glass_pane" },
  ], { metadata: { source: "hologram" } });
  assert.throws(
    () => createLitematicFromDocument(adjacent),
    /six-way isolation/,
  );
});

test("solid Litematica may use adjacent light blocks without inheriting hologram isolation", () => {
  const solid = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [1, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:end_rod" }], {
    metadata: { source: "solid", generationMode: "solid" },
  });

  assert.doesNotThrow(() => createLitematicFromDocument(solid, { timestamp: 1 }));
});

test("direct Litematica serialization rejects block ids absent from the compatibility registry", () => {
  const unknownBlock = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:future_custom_block" }]);

  assert.throws(
    () => createLitematicFromDocument(unknownBlock),
    /JAVA_BLOCK_UNSUPPORTED.*future_custom_block/,
  );
});

test("direct Litematica serialization rejects unknown version ids and damaged documents", () => {
  const unknownVersion = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], { minecraftVersion: "future-unknown" });
  assert.throws(
    () => createLitematicFromDocument(unknownVersion),
    /JAVA_VERSION_PROFILE_UNKNOWN/,
  );

  const source = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const damaged = {
    ...source,
    blockCount: 2,
  };
  assert.throws(
    () => createLitematicFromDocument(damaged),
    /blockCount.*does not match actual/,
  );
});

test("Litematica palette writes the Profile registry's canonical Java block id", async () => {
  const aliasDocument = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "white_concrete" }]);

  const exported = createLitematicFromDocument(aliasDocument, { timestamp: 1 });
  const { parsed } = await nbt.parse(Buffer.from(exported.bytes), "big");
  const root = nbt.simplify(parsed) as any;
  assert.deepEqual(root.Regions.Hologram.BlockStatePalette, [
    { Name: "minecraft:air" },
    { Name: "minecraft:white_concrete" },
  ]);
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

test("sparse tall projections require an explicit dimension and then allow generation", async () => {
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
  const generationOptions: SolidOptions = {
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
  };
  assert.throws(
    () => createLitematic(result, generationOptions, { timestamp: 1, regionMaxSize: 32 }),
    /explicit target dimension range/,
  );
  const exported = createLitematic(result, generationOptions, {
    timestamp: 1,
    regionMaxSize: 32,
    safety: {
      heightMode: "extended_2032",
      targetHeight: 2_032,
      datapackAcknowledged: true,
      placementBottomY: -1_016,
      targetDimension: { minY: -1_016, height: 2_032 },
    },
  });
  const { parsed } = await nbt.parse(Buffer.from(exported.bytes), "big");
  const root = nbt.simplify(parsed) as any;
  assert.equal(root.Metadata.RegionCount, 2);
  assert.equal(root.Metadata.TotalBlocks, 3);
  assert.deepEqual(root.Metadata.EnclosingSize, { x: 32, y: 2_032, z: 32 });
  assert.equal(exported.summary.regionCount, 2);
  assert.equal(exported.summary.dataVersion, 3465);
});
