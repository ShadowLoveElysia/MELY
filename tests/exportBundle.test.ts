import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { gunzipSync, strFromU8, unzipSync } from "fflate";
import * as nbt from "prismarine-nbt";
import {
  createExportBundle,
  createExportBundleAsync,
  createExportBundleStream,
  estimateExportBundleResources,
} from "../src/core/exportBundle";
import { AppError } from "../src/core/appError";
import { createProjectionDocument } from "../src/core/projectionDocument";

test("export bundle contains explicitly enabled split formats and a behavior pack", () => {
  const document = createProjectionDocument([
    { position: [-4, 10, 20], paletteIndex: 0 },
    { position: [1, 10, 20], paletteIndex: 0 },
    { position: [70, 10, 20], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
  ]);
  const bundle = createExportBundle(document, {
    name: "MELY Bundle Test",
    includeSchematic: true,
    includeMcstructure: true,
    includeMcfunction: true,
    litematic: { timestamp: 1 },
    mcfunction: {
      namespace: "mely_bundle",
      headerUuid: "11111111-1111-4111-8111-111111111111",
      moduleUuid: "22222222-2222-4222-8222-222222222222",
    },
  });
  const files = unzipSync(bundle.bytes);
  const names = Object.keys(files).sort();

  assert.equal(bundle.summary.partCount, 2);
  assert.equal(bundle.summary.fileCount, names.length);
  assert.ok(names.includes("bundle.json"));
  assert.ok(names.includes("coordinates.json"));
  assert.ok(names.includes("coordinates.txt"));
  assert.ok(names.includes("README.txt"));
  assert.ok(names.includes("planning/materials.json"));
  assert.ok(names.includes("planning/chests.json"));
  assert.ok(names.includes("behavior_pack/manifest.json"));
  assert.ok(names.includes("litematica/mely_bundle_test.litematic"));
  assert.ok(names.some((name) => name.endsWith(".schem")));
  assert.ok(names.some((name) => name.endsWith(".mcstructure")));
  const litematicaNames = names.filter((name) => name.endsWith(".litematic"));
  assert.deepEqual(litematicaNames, [
    "litematica/mely_bundle_test.litematic",
    "parts/part_0000/mely_bundle_test_part_0000.litematic",
    "parts/part_0001/mely_bundle_test_part_0001.litematic",
  ]);

  const schematicName = names.find((name) => name.endsWith(".schem"));
  const structureName = names.find((name) => name.endsWith(".mcstructure"));
  assert.ok(schematicName);
  assert.ok(structureName);
  const schematic = nbt.parseUncompressed(
    Buffer.from(gunzipSync(files[schematicName])),
    "big",
  );
  const structure = nbt.parseUncompressed(Buffer.from(files[structureName]), "little");
  assert.equal(schematic.name, "Schematic");
  assert.equal((nbt.simplify(schematic) as any).Version, 3);
  assert.equal((nbt.simplify(structure) as any).format_version, 1);

  const manifest = JSON.parse(strFromU8(files["bundle.json"]));
  assert.equal(manifest.format, "MELYExportBundle");
  assert.deepEqual(manifest.projection.height, {
    mode: "default",
    targetHeight: 1,
    actualHeight: 1,
    recommendedBottomY: -64,
    highestOccupiedY: -64,
    targetDimensionMinY: -64,
    targetDimensionMaxY: 319,
    thirdPartyDatapackDisclaimer: "",
  });
  assert.deepEqual(manifest.anchor, [-4, 10, 20]);
  assert.equal(manifest.litematic.overall, "litematica/mely_bundle_test.litematic");
  assert.equal(manifest.parts.length, 2);
  assert.deepEqual(manifest.parts.map((part: any) => part.bounds.dimensions), [
    [32, 1, 1],
    [11, 1, 1],
  ]);
  assert.deepEqual(manifest.parts.map((part: any) => part.files.litematic), [
    "parts/part_0000/mely_bundle_test_part_0000.litematic",
    "parts/part_0001/mely_bundle_test_part_0001.litematic",
  ]);
  assert.deepEqual(manifest.parts.map((part: any) => part.relativeOffset), [
    [0, 0, 0],
    [74, 0, 0],
  ]);
  assert.deepEqual(manifest.parts.map((part: any) => part.buildOrder), [1, 2]);
  assert.ok(manifest.parts.every((part: any) => /^sha256:[0-9a-f]{64}$/.test(part.contentHash)));
  assert.equal(new Set(manifest.parts.map((part: any) => part.contentHash)).size, 2);
  assert.equal(manifest.behaviorPack.entryFunction, "mely_bundle/load");
  assert.deepEqual(
    JSON.parse(strFromU8(files["behavior_pack/manifest.json"])).header.min_engine_version,
    [1, 20, 10],
  );
  assert.match(strFromU8(files["coordinates.txt"]), /execute function mely_bundle\/load/i);
  const materialPlan = JSON.parse(strFromU8(files["planning/materials.json"]));
  const chestPlan = JSON.parse(strFromU8(files["planning/chests.json"]));
  assert.equal(materialPlan.format, "MELYMaterialPlan");
  assert.equal(materialPlan.totalBlocks, document.blockCount);
  assert.equal(chestPlan.format, "MELYChestPlan");
  assert.equal(manifest.guides.locale, "en-US");
  assert.equal(manifest.guides.materials, "planning/materials.json");

  for (const name of litematicaNames) {
    const parsed = nbt.parseUncompressed(Buffer.from(gunzipSync(files[name])), "big");
    const root = nbt.simplify(parsed) as any;
    assert.equal(root.Version, 6);
  }
  const overall = nbt.simplify(nbt.parseUncompressed(
    Buffer.from(gunzipSync(files["litematica/mely_bundle_test.litematic"])),
    "big",
  )) as any;
  assert.equal(overall.Metadata.RegionCount, 2);
  assert.deepEqual(
    manifest.parts.map((part: any) => part.blockCount),
    [2, 1],
  );
});

test("project bundle defaults to Litematica parts and building guides", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const bundle = createExportBundle(document, {
    name: "Default Project Bundle",
    litematic: { timestamp: 1 },
  });
  const files = unzipSync(bundle.bytes);
  const names = Object.keys(files).sort();
  const manifest = JSON.parse(strFromU8(files["bundle.json"]));

  assert.deepEqual(names.filter((name) => name.endsWith(".litematic")), [
    "litematica/default_project_bundle.litematic",
    "parts/part_0000/default_project_bundle_part_0000.litematic",
    "parts/part_0001/default_project_bundle_part_0001.litematic",
  ]);
  assert.equal(names.some((name) => name.endsWith(".schem")), false);
  assert.equal(names.some((name) => name.endsWith(".mcstructure")), false);
  assert.equal(names.some((name) => name.endsWith(".mcfunction")), false);
  assert.equal(names.some((name) => name.startsWith("behavior_pack/")), false);
  assert.equal(manifest.behaviorPack, undefined);
  assert.ok(names.includes("README.txt"));
  assert.ok(names.includes("coordinates.json"));
  assert.ok(names.includes("coordinates.txt"));
  assert.ok(names.includes("planning/materials.json"));
  assert.ok(names.includes("planning/chests.json"));
});

test("bundle player guides follow the selected locale while JSON schemas stay stable", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [32, 1, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);

  const chineseFiles = unzipSync(createExportBundle(document, {
    name: "本地化测试",
    guideLocale: "zh-CN",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    litematic: { timestamp: 1 },
  }).bytes);
  const japaneseFiles = unzipSync(createExportBundle(document, {
    name: "ローカライズテスト",
    guideLocale: "ja-JP",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    litematic: { timestamp: 1 },
  }).bytes);

  assert.match(strFromU8(chineseFiles["README.txt"]), /工程建造指南/);
  assert.match(strFromU8(chineseFiles["coordinates.txt"]), /拼接坐标/);
  assert.match(strFromU8(japaneseFiles["README.txt"]), /建築プロジェクトガイド/);
  assert.match(strFromU8(japaneseFiles["coordinates.txt"]), /組み立て座標/);
  const materialPlan = JSON.parse(strFromU8(chineseFiles["planning/materials.json"]));
  assert.deepEqual(Object.keys(materialPlan).slice(0, 4), [
    "generator",
    "format",
    "version",
    "totalBlocks",
  ]);
  const manifest = JSON.parse(strFromU8(japaneseFiles["bundle.json"]));
  assert.equal(manifest.guides.locale, "ja-JP");
});

test("Litematica remains the mandatory bundle format when optional formats are disabled", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const bundle = createExportBundle(document, {
    name: "Litematica Only",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    litematic: { timestamp: 1 },
  });
  const names = Object.keys(unzipSync(bundle.bytes)).sort();

  assert.equal(bundle.summary.partCount, 2);
  assert.deepEqual(names.filter((name) => name.endsWith(".litematic")), [
    "litematica/litematica_only.litematic",
    "parts/part_0000/litematica_only_part_0000.litematic",
    "parts/part_0001/litematica_only_part_0001.litematic",
  ]);
  assert.equal(names.some((name) => name.endsWith(".schem")), false);
  assert.equal(names.some((name) => name.endsWith(".mcstructure")), false);
  assert.equal(names.some((name) => name.endsWith(".mcfunction")), false);
});

test("async bundle streaming matches the archive contract without retaining source entries", async () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [31, 31, 31], paletteIndex: 0 },
    { position: [32, 32, 32], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:end_rod", properties: { facing: "up" } },
  ]);
  const progress: number[] = [];
  const fileEvents: Array<{
    file: string;
    status: string;
    completedFiles: number;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  }> = [];
  const chunks: Uint8Array[] = [];
  const streamed = await createExportBundleStream(document, (chunk) => {
    chunks.push(chunk.slice());
  }, {
    name: "Streamed Bundle",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    litematic: { timestamp: 1 },
    onProgress: (event) => {
      progress.push(event.progress);
      if (event.currentFile && event.currentFileStatus) {
        fileEvents.push({
          file: event.currentFile,
          status: event.currentFileStatus,
          completedFiles: event.completedFiles,
          startedAt: event.fileStartedAt,
          finishedAt: event.fileFinishedAt,
          durationMs: event.fileDurationMs,
        });
      }
    },
  });
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const names = Object.keys(unzipSync(bytes)).sort();

  assert.equal(streamed.summary.byteLength, bytes.byteLength);
  assert.equal(streamed.summary.fileCount, names.length);
  assert.equal(streamed.summary.partCount, 2);
  assert.deepEqual(names.filter((name) => name.endsWith(".litematic")), [
    "litematica/streamed_bundle.litematic",
    "parts/part_0000/streamed_bundle_part_0000.litematic",
    "parts/part_0001/streamed_bundle_part_0001.litematic",
  ]);
  assert.equal(progress.at(0), 0.01);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  assert.equal(fileEvents.filter((event) => event.status === "started").length, names.length);
  assert.equal(fileEvents.filter((event) => event.status === "completed").length, names.length);
  assert.deepEqual(
    fileEvents.filter((event) => event.status === "completed").map((event) => event.completedFiles),
    Array.from({ length: names.length }, (_, index) => index + 1),
  );
  assert.equal(fileEvents.some((event) => event.status === "failed"), false);
  assert.ok(fileEvents.every((event) => !Number.isNaN(Date.parse(event.startedAt ?? ""))));
  assert.ok(fileEvents.filter((event) => event.status === "completed").every((event) =>
    !Number.isNaN(Date.parse(event.finishedAt ?? ""))
    && Number.isInteger(event.durationMs)
    && (event.durationMs ?? -1) >= 0));
});

test("streaming bundle writes behavior-pack functions incrementally", async () => {
  const document = createProjectionDocument(
    Array.from({ length: 5 }, (_, index) => ({
      position: [index * 32, 0, 0] as [number, number, number],
      paletteIndex: 0,
    })),
    [{ blockId: "minecraft:white_concrete" }],
  );
  const chunks: Uint8Array[] = [];
  const streamed = await createExportBundleStream(document, (chunk) => {
    chunks.push(chunk.slice());
  }, {
    name: "Streamed Behavior Pack",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: true,
    litematic: { timestamp: 1 },
    mcfunction: {
      namespace: "mely_stream",
      maxCommandsPerFunction: 2,
      headerUuid: "33333333-3333-4333-8333-333333333333",
      moduleUuid: "44444444-4444-4444-8444-444444444444",
    },
  });
  const files = unzipSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const names = Object.keys(files).sort();

  assert.equal(streamed.manifest.behaviorPack?.entryFunction, "mely_stream/load");
  assert.ok(names.includes("behavior_pack/manifest.json"));
  assert.ok(names.includes("behavior_pack/functions/mely_stream/load.mcfunction"));
  assert.equal(
    names.filter((name) => name.includes("behavior_pack/functions/mely_stream/chunks/")).length,
    5,
  );
  assert.ok(names.some((name) => name.includes("behavior_pack/functions/mely_stream/dispatch/")));
  assert.match(
    strFromU8(files["behavior_pack/functions/mely_stream/load.mcfunction"]),
    /function mely_stream\/dispatch\/d1_/,
  );
  assert.deepEqual(
    JSON.parse(strFromU8(files["behavior_pack/manifest.json"])).header.min_engine_version,
    [1, 20, 10],
  );
});

test("32-cube bundle parts are disjoint and reconstruct every source block", async () => {
  const sourceBlocks = [
    [-33, -1, -1], [-32, 0, 0], [-1, 31, 31], [0, 32, 32],
    [31, 63, 63], [32, 64, 64], [63, 95, 95], [64, 96, 96],
  ] as const;
  const document = createProjectionDocument(sourceBlocks.map((position, index) => ({
    position: [...position],
    paletteIndex: index % 2,
  })), [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:black_concrete" },
  ]);
  const bundle = await createExportBundleAsync(document, {
    name: "Chunk Reconstruction",
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    partSize: [32, 32, 32],
    litematic: { timestamp: 1 },
  });
  const files = unzipSync(bundle.bytes);
  const manifest = JSON.parse(strFromU8(files["bundle.json"]));
  const reconstructed = new Map<string, string>();
  let blockTotal = 0;

  for (const part of manifest.parts) {
    assert.ok(part.bounds.dimensions.every((value: number) => value >= 1 && value <= 32));
    const root = nbt.simplify(nbt.parseUncompressed(
      Buffer.from(gunzipSync(files[part.files.litematic])),
      "big",
    )) as any;
    for (const region of Object.values(root.Regions) as any[]) {
      const size = [region.Size.x, region.Size.y, region.Size.z];
      const origin = [
        part.occupiedBounds.min[0] + region.Position.x,
        part.occupiedBounds.min[1] + region.Position.y,
        part.occupiedBounds.min[2] + region.Position.z,
      ];
      const palette = region.BlockStatePalette as Array<{ Name: string }>;
      const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
      const longs = region.BlockStates as [number, number][];
      for (let index = 0; index < size[0] * size[1] * size[2]; index += 1) {
        const bitOffset = index * bits;
        const longIndex = Math.floor(bitOffset / 64);
        const innerOffset = bitOffset & 63;
        const first = (BigInt(longs[longIndex][0] >>> 0) << 32n)
          | BigInt(longs[longIndex][1] >>> 0);
        const available = 64 - innerOffset;
        const mask = (1n << BigInt(bits)) - 1n;
        let paletteIndex = Number((first >> BigInt(innerOffset)) & mask);
        if (available < bits) {
          const second = (BigInt(longs[longIndex + 1][0] >>> 0) << 32n)
            | BigInt(longs[longIndex + 1][1] >>> 0);
          paletteIndex = Number(
            ((first >> BigInt(innerOffset)) | (second << BigInt(available))) & mask,
          );
        }
        if (paletteIndex === 0) continue;
        const x = index % size[0];
        const yz = Math.floor(index / size[0]);
        const z = yz % size[2];
        const y = Math.floor(yz / size[2]);
        const key = `${origin[0] + x},${origin[1] + y},${origin[2] + z}`;
        assert.equal(reconstructed.has(key), false, `overlap at ${key}`);
        reconstructed.set(key, palette[paletteIndex].Name);
        blockTotal += 1;
      }
    }
  }

  assert.equal(blockTotal, document.blockCount);
  assert.deepEqual([...reconstructed.keys()].sort(), sourceBlocks.map((position) => position.join(",")).sort());
});

test("bundle resource estimate charges only the streaming mcfunction working set", () => {
  const document = createProjectionDocument(
    Array.from({ length: 128 }, (_, index) => ({
      position: [index * 32, 0, 0] as [number, number, number],
      paletteIndex: 0,
    })),
    [{ blockId: "minecraft:white_concrete" }],
  );
  const withoutFunctions = estimateExportBundleResources(document, {
    includeMcfunction: false,
  });
  const withFunctions = estimateExportBundleResources(document, {
    includeMcfunction: true,
  });

  assert.ok(withFunctions.estimatedWorkingBytes > withoutFunctions.estimatedWorkingBytes);
  assert.ok(
    withFunctions.estimatedWorkingBytes - withoutFunctions.estimatedWorkingBytes < 128 * 1024,
  );
  assert.equal(withoutFunctions.mcfunctionWorkingBytes, 0);
  assert.equal(
    withFunctions.estimatedWorkingBytes - withoutFunctions.estimatedWorkingBytes,
    withFunctions.mcfunctionWorkingBytes,
  );
});

test("bundle resource estimate accounts for packed states and only the largest region staging", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [31, 31, 31], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const estimate = estimateExportBundleResources(document);

  assert.equal(estimate.partCount, 2);
  assert.equal(estimate.occupiedRegionVolume, 32 * 32 * 32 + 32 * 32);
  assert.equal(estimate.paletteSize, 2);
  assert.equal(estimate.bitsPerBlock, 2);
  assert.equal(estimate.packedBlockStateBytes, 8_448);
  assert.equal(estimate.largestRegionVolume, 32 * 32 * 32);
  assert.equal(estimate.largestRegionStagingBytes, 32 * 32 * 32 * 12);
  assert.equal(estimate.nbtGzipDuplicationBytes, estimate.packedBlockStateBytes * 4);
  assert.equal(estimate.documentWorkingBytes, document.blockCount * 56);
  assert.equal(estimate.partMetadataBytes, estimate.partCount * 12 * 1024);
  assert.equal(estimate.estimatedWorkingBytes, 101_123_496);
});

test("bundle resource estimate follows the palette bit-width boundary", () => {
  const blocks = [
    { position: [0, 0, 0] as [number, number, number], paletteIndex: 0 },
    { position: [31, 31, 31] as [number, number, number], paletteIndex: 0 },
  ];
  const fourStateDocument = createProjectionDocument(
    blocks,
    Array.from({ length: 3 }, (_, index) => ({ blockId: `minecraft:test_${index}` })),
  );
  const fiveStateDocument = createProjectionDocument(
    blocks,
    Array.from({ length: 4 }, (_, index) => ({ blockId: `minecraft:test_${index}` })),
  );
  const twoBit = estimateExportBundleResources(fourStateDocument);
  const threeBit = estimateExportBundleResources(fiveStateDocument);

  assert.equal(twoBit.paletteSize, 4);
  assert.equal(twoBit.bitsPerBlock, 2);
  assert.equal(twoBit.packedBlockStateBytes, 8_192);
  assert.equal(threeBit.paletteSize, 5);
  assert.equal(threeBit.bitsPerBlock, 3);
  assert.equal(threeBit.packedBlockStateBytes, 12_288);
  assert.equal(
    threeBit.estimatedWorkingBytes - twoBit.estimatedWorkingBytes,
    (threeBit.packedBlockStateBytes - twoBit.packedBlockStateBytes) * 5,
  );
});

test("bundle resource estimate permits the audited 2032 hologram footprint", () => {
  const normalViews: Array<[number, number, number]> = [[0, 63, 0]];
  for (let y = 0; normalViews.length < 4_205 && y < 64; y += 1) {
    for (let z = 0; normalViews.length < 4_205 && z < 41; z += 1) {
      for (let x = 0; normalViews.length < 4_205 && x < 50; x += 1) {
        if (x === 0 && y === 63 && z === 0) continue;
        normalViews.push([x, y, z]);
      }
    }
  }
  const views: Array<[number, number, number]> = [
    ...normalViews,
    ...Array.from({ length: 4 }, (_, z): [number, number, number] => [50, 0, z]),
    ...Array.from({ length: 25 }, (_, x): [number, number, number] => [x, 0, 41]),
  ];
  const blocks: Array<{ position: [number, number, number]; paletteIndex: number }> = [];
  for (let index = 0; index < views.length; index += 1) {
    const [x, y, z] = views[index];
    const localX = x === 50 ? 20 : 0;
    const localY = y === 63 ? 31 : 0;
    const localZ = z === 41 ? 10 : 0;
    blocks.push({
      position: [x * 32 + localX, y * 32 + localY, z * 32 + localZ],
      paletteIndex: index & 1,
    });
  }
  const remainingBlocks = 113_936 - blocks.length;
  for (let index = 0; index < remainingBlocks; index += 1) {
    const region = index % normalViews.length;
    const sequence = Math.floor(index / normalViews.length) + 1;
    const [viewX, viewY, viewZ] = normalViews[region];
    blocks.push({
      position: [
        viewX * 32 + sequence % 32,
        viewY * 32 + Math.floor(sequence / 32) % 32,
        viewZ * 32,
      ],
      paletteIndex: index & 1,
    });
  }
  const document = createProjectionDocument(blocks, [
    { blockId: "minecraft:end_rod", properties: { facing: "up" } },
    { blockId: "minecraft:white_stained_glass_pane" },
  ]);
  const estimate = estimateExportBundleResources(document);

  assert.equal(document.blockCount, 113_936);
  assert.equal(estimate.partCount, 4_234);
  assert.equal(estimate.occupiedRegionVolume, 138_157_056);
  assert.equal(estimate.bitsPerBlock, 2);
  assert.equal(estimate.packedBlockStateBytes, 34_539_264);
  assert.equal(estimate.largestRegionVolume, 32_768);
  assert.equal(estimate.estimatedWorkingBytes, 332_160_640);
  assert.equal(estimate.allowed, true);
  assert.equal(estimateExportBundleResources(document, {
    maxWorkingBytes: estimate.estimatedWorkingBytes - 1,
  }).allowed, false);
});

test("async bundle output and working-set budgets fail before unsafe retention", async () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const estimate = estimateExportBundleResources(document, {
    includeMcfunction: false,
  });
  assert.equal(estimate.partCount, 2);
  assert.equal(estimate.allowed, true);
  assert.equal(estimateExportBundleResources(document, {
    includeMcfunction: false,
    maxWorkingBytes: 1,
  }).allowed, false);
  await assert.rejects(createExportBundleAsync(document, {
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
    litematic: { timestamp: 1 },
    maxOutputBytes: 1,
  }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.export.bundleOutput");
    assert.equal(error.params?.limit, 0);
    return true;
  });
  await assert.rejects(createExportBundleStream(document, () => undefined, {
    maxWorkingBytes: 1,
  }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.export.bundleWorkingSet");
    assert.equal(error.params?.limit, 0);
    return true;
  });
});

test("streaming bundle honors cancellation before generating files", async () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(createExportBundleStream(document, () => undefined, {
    signal: controller.signal,
  }), /cancelled by test/);
});

test("streaming bundle identifies the file that failed", async () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const events: Array<{ file?: string; status?: string }> = [];

  await assert.rejects(createExportBundleStream(document, () => {
    throw new Error("simulated storage failure");
  }, {
    name: "Failure Test",
    litematic: { timestamp: 1 },
    onProgress: (event) => events.push({
      file: event.currentFile,
      status: event.currentFileStatus,
    }),
  }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.export.bundleFile");
    assert.equal(error.params?.file, "litematica/failure_test.litematic");
    return true;
  });

  assert.deepEqual(events.filter((event) => event.status), [
    { file: "litematica/failure_test.litematic", status: "started" },
    { file: "litematica/failure_test.litematic", status: "failed" },
  ]);
});

test("all bundle entry points allow registered untested Java versions with manifest warnings", async () => {
  const untested = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], { minecraftVersion: "1.20.2" });
  const syncBundle = createExportBundle(untested, { litematic: { timestamp: 1 } });
  assert.deepEqual(syncBundle.manifest.litematic, {
    overall: "litematica/mely_projection.litematic",
    targetMinecraftVersion: "1.20.2",
    serializerMinecraftVersion: "1.20.1",
    dataVersion: 3465,
    formatVersion: 6,
    subVersion: 1,
    compatibilityLevel: "best_effort",
    compatibilityWarningCode: "JAVA_VERSION_BEST_EFFORT",
  });
  const syncFiles = unzipSync(syncBundle.bytes);
  assert.match(strFromU8(syncFiles["README.txt"]), /JAVA_VERSION_BEST_EFFORT/);
  assert.match(strFromU8(syncFiles["README.txt"]), /Community validation is required/);

  const asyncBundle = await createExportBundleAsync(untested, { litematic: { timestamp: 1 } });
  assert.equal(asyncBundle.manifest.litematic.compatibilityLevel, "best_effort");
  const chunks: Uint8Array[] = [];
  const streamed = await createExportBundleStream(
    untested,
    (chunk) => chunks.push(chunk.slice()),
    { litematic: { timestamp: 1 } },
  );
  assert.equal(streamed.manifest.litematic.compatibilityWarningCode, "JAVA_VERSION_BEST_EFFORT");
  assert.ok(chunks.length > 0);
});

test("all bundle entry points still fail before output for unsafe Java documents", () => {

  const extendedWithoutDeclaration = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [0, 384, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], {
    metadata: {
      heightMode: "extended_2032",
      targetHeight: 385,
      datapackAcknowledged: true,
    },
  });
  assert.throws(
    () => createExportBundle(extendedWithoutDeclaration),
    /explicit target dimension range/,
  );

  const adjacent = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [0, 1, 0], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:end_rod" },
    { blockId: "minecraft:white_stained_glass_pane" },
  ]);
  assert.throws(() => createExportBundle(adjacent), /six-way isolation/);
});
