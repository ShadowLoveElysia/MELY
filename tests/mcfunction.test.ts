import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  createMcfunctionBehaviorPack,
  createMcfunctionBehaviorPackZip,
  createMcfunctionBehaviorPackZipStream,
  iterateMcfunctionBehaviorPackFiles,
  iterateMcfunctionBehaviorPackFilesAsync,
  streamMcfunctionBehaviorPack,
  type McfunctionExportMetadata,
  type McfunctionFile,
} from "../src/core/mcfunction";
import { AppError } from "../src/core/appError";
import {
  createProjectionDocument,
  deriveBedrockProjectionDocument,
} from "../src/core/projectionDocument";
import type { ProjectionBlockState } from "../src/types";

const createBedrockDocument = (
  blocks: Parameters<typeof createProjectionDocument>[0],
  palette: Parameters<typeof createProjectionDocument>[1],
) => createProjectionDocument(blocks, palette, { edition: "bedrock" });

const fixedOptions = {
  namespace: "mely_test",
  headerUuid: "12345678-1234-4234-8234-123456789abc",
  moduleUuid: "abcdefab-cdef-4abc-8def-abcdefabcdef",
} as const;

test("mcfunction pack merges continuous lines and preserves isolated blocks", () => {
  const document = createBedrockDocument([
    { position: [100, 5, -20], paletteIndex: 0 },
    { position: [101, 5, -20], paletteIndex: 0 },
    { position: [102, 5, -20], paletteIndex: 0 },
    { position: [110, 5, -20], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:end_rod", properties: { facing: "up" } },
  ]);
  const exported = createMcfunctionBehaviorPack(document, fixedOptions);
  const commands = exported.files
    .filter((file) => file.path.includes("/chunks/"))
    .flatMap((file) => file.content.trim().split("\n"));

  assert.equal(exported.entryFunction, "mely_test/load");
  assert.ok(commands.some((line) => line === "fill ~ ~ ~ ~2 ~ ~ minecraft:white_concrete replace"));
  assert.ok(commands.some((line) =>
    line === "setblock ~10 ~ ~ minecraft:end_rod [\"facing_direction\"=1] replace"));
  assert.equal(exported.summary.fillCount, 1);
  assert.equal(exported.summary.setblockCount, 1);
  assert.equal(exported.summary.commandCount, 2);
  assert.equal(exported.manifest.format_version, 2);
  assert.equal(exported.manifest.modules[0].type, "data");
  assert.deepEqual(exported.manifest.header.min_engine_version, [1, 20, 10]);
});

test("mcfunction rejects forged bounds before command generation", () => {
  const document = createBedrockDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [10, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  document.bounds = { min: [0, 0, 0], max: [0, 0, 0], dimensions: [1, 1, 1] };
  assert.throws(() => createMcfunctionBehaviorPack(document, fixedOptions), /declared bounds/);
});

test("mcfunction ignores untested Java target and extreme-height metadata", () => {
  const javaDocument = createProjectionDocument([
    { position: [0, -2_032, 0], paletteIndex: 0 },
    { position: [0, 2_031, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], {
    edition: "java",
    minecraftVersion: "26.3",
    metadata: {
      releaseStatus: "provisional",
      heightMode: "experimental_4064",
      targetHeight: 4_064,
      heightDisclaimer: "Not yet tested",
    },
  });
  const exported = createMcfunctionBehaviorPack(
    deriveBedrockProjectionDocument(javaDocument),
    fixedOptions,
  );

  assert.equal(exported.summary.blockCount, 2);
  assert.equal(exported.summary.commandCount, 2);
  assert.deepEqual(exported.manifest.header.min_engine_version, [1, 20, 10]);
});

test("streamed mcfunction ZIP is a complete Bedrock 1.20.10 behavior pack", async () => {
  const document = createBedrockDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const options = { ...fixedOptions, maxCommandsPerFunction: 2 };
  const chunks: Uint8Array[] = [];
  const streamed = await createMcfunctionBehaviorPackZipStream(document, (chunk) => {
    chunks.push(chunk.slice());
  }, options);
  const streamedBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const compatible = await createMcfunctionBehaviorPackZip(document, options);
  const files = unzipSync(streamedBytes);
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));

  assert.equal(streamed.archive.bytesWritten, streamedBytes.byteLength);
  assert.equal(streamed.archive.fileCount, Object.keys(files).length);
  assert.deepEqual(manifest.header.min_engine_version, [1, 20, 10]);
  assert.equal(manifest.header.uuid, fixedOptions.headerUuid);
  assert.equal(manifest.modules[0].uuid, fixedOptions.moduleUuid);
  assert.ok(files["functions/mely_test/load.mcfunction"]);
  assert.deepEqual(Object.keys(unzipSync(compatible.bytes)).sort(), Object.keys(files).sort());
});

test("streamed mcfunction ZIP rejects output beyond the caller budget", async () => {
  const document = createBedrockDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const chunks: Uint8Array[] = [];

  await assert.rejects(
    createMcfunctionBehaviorPackZipStream(document, (chunk) => {
      chunks.push(chunk.slice());
    }, {
      ...fixedOptions,
      maxOutputBytes: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "error.export.bundleOutput");
      assert.equal(error.params?.limit, 0);
      return true;
    },
  );
  assert.equal(chunks.length, 0);
});

test("streamed mcfunction ZIP awaits an asynchronous sink without reordering chunks", async () => {
  const document = createBedrockDocument(
    Array.from({ length: 12 }, (_, index) => ({
      position: [index * 32, index % 3, 0] as [number, number, number],
      paletteIndex: 0,
    })),
    [{ blockId: "minecraft:white_concrete" }],
  );
  const chunks: Uint8Array[] = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const streamed = await createMcfunctionBehaviorPackZipStream(document, async (chunk) => {
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 1));
    chunks.push(chunk.slice());
    activeWrites -= 1;
  }, {
    ...fixedOptions,
    maxCommandsPerFunction: 2,
  });
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const files = unzipSync(bytes);

  assert.equal(maximumActiveWrites, 1);
  assert.equal(streamed.archive.bytesWritten, bytes.byteLength);
  assert.equal(streamed.archive.fileCount, Object.keys(files).length);
  assert.ok(files["functions/mely_test/load.mcfunction"]);
});

test("mcfunction files obey configurable command and line limits", () => {
  const document = createBedrockDocument(
    Array.from({ length: 7 }, (_, index) => ({
      position: [index * 2, 0, index % 2],
      paletteIndex: 0,
    })),
    [{ blockId: "minecraft:black_concrete" }],
  );
  const exported = createMcfunctionBehaviorPack(document, {
    ...fixedOptions,
    maxCommandsPerFunction: 2,
    maxLineLength: 100,
  });
  const encoder = new TextEncoder();
  assert.ok(exported.files.length > 2);
  for (const file of exported.files) {
    const lines = file.content.trim().split("\n").filter(Boolean);
    assert.ok(lines.length <= 2, file.path);
    assert.ok(lines.every((line) => encoder.encode(line).length <= 100), file.path);
  }
  assert.ok(exported.files.some((file) => file.functionId === exported.entryFunction));

  assert.throws(() => createMcfunctionBehaviorPack(document, {
    ...fixedOptions,
    maxLineLength: 10,
  }), /line length/i);
});

test("mcfunction commands share Bedrock family and attachment mappings", () => {
  const palette: ProjectionBlockState[] = [
    { blockId: "minecraft:white_stained_glass_pane", properties: { north: "true" } },
    { blockId: "minecraft:pink_terracotta" },
    { blockId: "minecraft:smooth_quartz" },
    { blockId: "minecraft:vine", properties: { east: "true", north: "true", up: "true" } },
    { blockId: "minecraft:glow_lichen", properties: { down: "true", west: "true" } },
  ];
  const document = createBedrockDocument(
    palette.map((_, index) => ({ position: [index * 2, 0, 0], paletteIndex: index })),
    palette,
  );
  const exported = createMcfunctionBehaviorPack(document, fixedOptions);
  const commands = exported.files
    .filter((file) => file.path.includes("/chunks/"))
    .flatMap((file) => file.content.trim().split("\n"));

  assert.ok(commands.some((line) => line.includes(
    "minecraft:stained_glass_pane [\"color\"=\"white\"] replace",
  )));
  assert.ok(commands.some((line) => line.includes(
    "minecraft:stained_hardened_clay [\"color\"=\"pink\"] replace",
  )));
  assert.ok(commands.some((line) => line.includes(
    "minecraft:quartz_block [\"chisel_type\"=\"smooth\",\"pillar_axis\"=\"y\"] replace",
  )));
  assert.ok(commands.some((line) => line.includes(
    "minecraft:vine [\"vine_direction_bits\"=12] replace",
  )));
  assert.ok(commands.some((line) => line.includes(
    "minecraft:glow_lichen [\"multi_face_direction_bits\"=17] replace",
  )));
  assert.ok(commands.every((line) => !line.includes("waterlogged") && !line.includes("north\"=")));
});

const collectGenerator = <TReturn>(
  iterator: Generator<McfunctionFile, TReturn, void>,
) => {
  const files: McfunctionFile[] = [];
  while (true) {
    const next = iterator.next();
    if (next.done === true) return { files, metadata: next.value };
    files.push(next.value);
  }
};

const collectAsyncGenerator = async (
  iterator: AsyncGenerator<McfunctionFile, McfunctionExportMetadata, void>,
) => {
  const files: McfunctionFile[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done === true) return { files, metadata: next.value };
    files.push(next.value);
  }
};

test("streaming callback matches the synchronous compatibility export", async () => {
  const document = createBedrockDocument([
    { position: [-33, 0, 0], paletteIndex: 0 },
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [1, 0, 0], paletteIndex: 0 },
    { position: [64, 4, 3], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:end_rod", properties: { facing: "up" } },
  ]);
  const compatible = createMcfunctionBehaviorPack(document, fixedOptions);
  const streamedFiles: McfunctionFile[] = [];
  let activeHandlers = 0;
  let maxActiveHandlers = 0;
  const metadata = await streamMcfunctionBehaviorPack(
    document,
    fixedOptions,
    async (file) => {
      activeHandlers += 1;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      await Promise.resolve();
      streamedFiles.push(file);
      activeHandlers -= 1;
    },
  );

  assert.deepEqual(metadata.manifest, compatible.manifest);
  assert.equal(metadata.entryFunction, compatible.entryFunction);
  assert.deepEqual(metadata.summary, compatible.summary);
  assert.deepEqual(
    [...streamedFiles].sort((left, right) => left.path.localeCompare(right.path)),
    compatible.files,
  );
  assert.equal(streamedFiles.at(-1)?.functionId, metadata.entryFunction);
  assert.equal(maxActiveHandlers, 1);
});

test("async generator emits deterministic chunk and dispatcher order", async () => {
  const document = createBedrockDocument(
    Array.from({ length: 5 }, (_, index) => ({
      position: [index * 32, 0, 0] as [number, number, number],
      paletteIndex: 0,
    })),
    [{ blockId: "minecraft:black_concrete" }],
  );
  document.chunks.reverse();
  const options = { ...fixedOptions, maxCommandsPerFunction: 2 };
  const first = await collectAsyncGenerator(iterateMcfunctionBehaviorPackFilesAsync(document, options));
  const second = collectGenerator(iterateMcfunctionBehaviorPackFiles(document, options));
  const functionIds = first.files.map((file) => file.functionId);

  assert.deepEqual(first, second);
  assert.deepEqual(functionIds.slice(0, 5), [
    "mely_test/chunks/c_p0_p0_p0_0000",
    "mely_test/chunks/c_p1_p0_p0_0000",
    "mely_test/chunks/c_p2_p0_p0_0000",
    "mely_test/chunks/c_p3_p0_p0_0000",
    "mely_test/chunks/c_p4_p0_p0_0000",
  ]);
  assert.deepEqual(functionIds.slice(5), [
    "mely_test/dispatch/d0_0000",
    "mely_test/dispatch/d0_0001",
    "mely_test/dispatch/d0_0002",
    "mely_test/dispatch/d1_0000",
    "mely_test/dispatch/d1_0001",
    "mely_test/load",
  ]);
  assert.equal(first.metadata.summary.functionCount, 11);
  assert.equal(first.metadata.summary.commandCount, 5);
  assert.ok(first.files.every((file) => file.commandCount <= 2));
});

test("streaming export validates chunk buffers before delivering files", async () => {
  const document = createBedrockDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  document.chunks[0].paletteIndices = new Uint16Array(0);
  let delivered = 0;

  await assert.rejects(
    streamMcfunctionBehaviorPack(document, fixedOptions, () => {
      delivered += 1;
    }),
    /inconsistent buffers/i,
  );
  assert.equal(delivered, 0);
});

test("iterator expands later chunks only after earlier leaf files are consumed", () => {
  const document = createBedrockDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const iterator = iterateMcfunctionBehaviorPackFiles(document, fixedOptions);
  const first = iterator.next();
  assert.equal(first.done, false);
  assert.equal(
    (first.value as McfunctionFile).functionId,
    "mely_test/chunks/c_p0_p0_p0_0000",
  );

  document.chunks[1].paletteIndices[0] = 99;
  assert.throws(() => iterator.next(), /unknown projection palette index/i);
});
