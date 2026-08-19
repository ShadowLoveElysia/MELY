import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECTION_CHUNK_SIZE,
  countProjectionMaterials,
  assertProjectionDocumentIntegrity,
  createProjectionDocument,
  createProjectionDocumentFromHologram,
  createProjectionDocumentFromSolid,
  deriveBedrockProjectionDocument,
  assertProjectionDocumentHologramIsolation,
  iterateProjectionBlocks,
  iterateProjectionSlice,
  iterateProjectionViewBlocks,
  projectionDocumentTransferables,
  splitProjectionViews,
} from "../src/core/projectionDocument";
import { JAVA_VERSION_PROFILES } from "../src/core/minecraftVersions";
import type {
  HologramResult,
  ProjectionBlock,
  ProjectionDocument,
  SolidVoxelResult,
} from "../src/types";

const blockKey = (block: ProjectionBlock) =>
  `${block.position.join(",")}:${block.paletteIndex}`;

const sortedBlockKeys = (document: ProjectionDocument) =>
  [...iterateProjectionBlocks(document)].map(blockKey).sort();

test("solid and hologram results convert without losing positions or block states", () => {
  const solid: SolidVoxelResult = {
    kind: "solid",
    positions: Float32Array.from([32, 0, -1, -1, 31, 32, 0, 0, 0]),
    blockIndices: Uint16Array.from([1, 0, 1]),
    palette: [
      { blockId: "minecraft:white_terracotta", color: [209, 178, 161] },
      { blockId: "minecraft:black_concrete", color: [8, 10, 15] },
    ],
    stats: {
      blockCount: 3,
      surfaceBlockCount: 3,
      filledBlockCount: 0,
      skinBlockCount: 1,
      alphaRejected: 0,
      triangleBoxTests: 3,
      paletteSize: 2,
      dimensions: [34, 32, 34],
    },
    bounds: { min: [-1, 0, -1], max: [32, 31, 32] },
  };
  const solidDocument = createProjectionDocumentFromSolid(solid);
  assert.deepEqual(sortedBlockKeys(solidDocument), [
    "-1,31,32:0",
    "0,0,0:1",
    "32,0,-1:1",
  ]);
  assert.deepEqual(solidDocument.palette, [
    { blockId: "minecraft:white_terracotta", color: [209, 178, 161] },
    { blockId: "minecraft:black_concrete", color: [8, 10, 15] },
  ]);

  const hologram: HologramResult = {
    kind: "hologram",
    positions: Float32Array.from([0, 0, 0, 31, 32, -1]),
    facings: Uint8Array.from([2, 2]),
    materials: Uint8Array.from([0, 1]),
    stats: {
      blockCount: 2,
      endRodCount: 1,
      paneCount: 1,
      removedConflicts: 0,
      dimensions: [32, 33, 2],
    },
    bounds: { min: [0, 0, -1], max: [31, 32, 0] },
  };
  const hologramDocument = createProjectionDocumentFromHologram(hologram);
  const hologramStates = [...iterateProjectionBlocks(hologramDocument)].map((block) =>
    hologramDocument.palette[block.paletteIndex]);
  assert.deepEqual(hologramStates, [
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
    {
      blockId: "minecraft:white_stained_glass_pane",
      properties: {
        east: "false",
        north: "false",
        south: "false",
        waterlogged: "false",
        west: "false",
      },
      emissive: false,
    },
  ]);

  const transferred = structuredClone(solidDocument, {
    transfer: projectionDocumentTransferables(solidDocument),
  });
  assert.deepEqual(sortedBlockKeys(transferred), [
    "-1,31,32:0",
    "0,0,0:1",
    "32,0,-1:1",
  ]);
});

test("chunked solid results become projection chunks without flattening or copying", () => {
  const positions = new Uint16Array([0, 31 + 32 * (4 + 32 * 5)]);
  const blockIndices = new Uint16Array([1, 0]);
  const solid: SolidVoxelResult = {
    kind: "solid",
    storage: "chunked",
    positions: new Float32Array(0),
    blockIndices: new Uint16Array(0),
    chunks: [{ chunk: [-1, 2, 3], positions, blockIndices }],
    palette: [
      { blockId: "minecraft:white_concrete", color: [207, 213, 214] },
      { blockId: "minecraft:black_concrete", color: [8, 10, 15] },
    ],
    stats: {
      blockCount: 2,
      surfaceBlockCount: 2,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 2,
      paletteSize: 2,
      dimensions: [32, 6, 5],
    },
    bounds: { min: [-32, 64, 96], max: [-1, 69, 100] },
  };

  const document = createProjectionDocumentFromSolid(solid);

  assert.equal(document.chunks[0].positions, positions);
  assert.equal(document.chunks[0].paletteIndices, blockIndices);
  assert.deepEqual([...iterateProjectionBlocks(document)].map(blockKey), [
    "-32,64,96:1",
    "-1,69,100:0",
  ]);
  assert.deepEqual(document.bounds, {
    min: [-32, 64, 96],
    max: [-1, 69, 100],
    dimensions: [32, 6, 5],
  });
  assert.doesNotThrow(() => assertProjectionDocumentIntegrity(document));
});

test("chunked document integrity rejects structural corruption without resource limits", () => {
  const createChunked = (positions: number[]) => createProjectionDocumentFromSolid({
    kind: "solid",
    storage: "chunked",
    positions: new Float32Array(0),
    blockIndices: new Uint16Array(0),
    chunks: [{
      chunk: [0, 0, 0],
      positions: new Uint16Array(positions),
      blockIndices: new Uint16Array(positions.length),
    }],
    palette: [{ blockId: "minecraft:stone", color: [125, 125, 125] }],
    stats: {
      blockCount: positions.length,
      surfaceBlockCount: positions.length,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: positions.length,
      paletteSize: 1,
      dimensions: [1, 1, positions.length],
    },
    bounds: { min: [0, 0, 0], max: [0, 0, positions.length - 1] },
  });

  assert.throws(() => createChunked([1, 1]), /strictly increasing|unique/i);
  assert.throws(() => createChunked([2, 1]), /strictly increasing/i);

  const duplicatedChunk = createChunked([1]);
  duplicatedChunk.chunks.push({
    chunk: [0, 0, 0],
    positions: new Uint16Array([2]),
    paletteIndices: new Uint16Array([0]),
  });
  duplicatedChunk.blockCount += 1;
  assert.throws(() => assertProjectionDocumentIntegrity(duplicatedChunk), /duplicate chunk/i);
});

test("hologram document conversion and final assertion reject mixed six-way neighbours", () => {
  const adjacent: HologramResult = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0]),
    facings: Uint8Array.from([2, 2]),
    materials: Uint8Array.from([0, 1]),
    stats: {
      blockCount: 2,
      endRodCount: 1,
      paneCount: 1,
      removedConflicts: 0,
      dimensions: [2, 1, 1],
    },
    bounds: { min: [0, 0, 0], max: [1, 0, 0] },
  };
  assert.throws(
    () => createProjectionDocumentFromHologram(adjacent),
    /six-way isolation/,
  );

  const injected = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [0, 1, 0], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:end_rod" },
    { blockId: "minecraft:white_stained_glass_pane" },
  ], { metadata: { source: "hologram" } });
  assert.throws(() => assertProjectionDocumentHologramIsolation(injected), /six-way isolation/);
});

test("Bedrock derivation preserves projection data and removes Java-only height metadata", () => {
  const javaDocument = createProjectionDocument([
    { position: [-33, -64, 5], paletteIndex: 0 },
    { position: [32, 319, -6], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete", color: [207, 213, 214] },
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
  ], {
    edition: "java",
    minecraftVersion: "1.20.1",
    metadata: {
      name: "Shared projection",
      generator: "MELY",
      generationMode: "solid",
      targetHeight: 384,
      heightMode: "extended_2032",
      datapackAcknowledged: true,
      placementBottomY: -2032,
      targetDimensionMinY: -2032,
      targetDimensionMaxY: 2031,
      heightDisclaimer: "Java-only third-party data pack warning",
      javaVersionId: "1.20.1",
      releaseStatus: "unavailable",
      profileFingerprint: "java-profile",
      configurationFingerprint: "height-configuration",
      exportFingerprint: "height-export",
      confirmations: "Java-only confirmations",
    },
  });

  const bedrockDocument = deriveBedrockProjectionDocument(javaDocument);

  assert.equal(bedrockDocument.edition, "bedrock");
  assert.equal(bedrockDocument.minecraftVersion, "1.20.10");
  assert.deepEqual(sortedBlockKeys(bedrockDocument), sortedBlockKeys(javaDocument));
  assert.deepEqual(bedrockDocument.palette, javaDocument.palette);
  assert.deepEqual(bedrockDocument.chunks, javaDocument.chunks);
  assert.deepEqual(bedrockDocument.bounds, javaDocument.bounds);
  assert.equal(bedrockDocument.blockCount, javaDocument.blockCount);
  assert.deepEqual(bedrockDocument.metadata, {
    name: "Shared projection",
    generator: "MELY",
    generationMode: "solid",
  });
  assert.equal(javaDocument.metadata?.heightMode, "extended_2032");
});

test("every registered Java target derives the same independent Bedrock document", () => {
  for (const profile of JAVA_VERSION_PROFILES) {
    for (const height of [2_032, 4_064]) {
      const source = createProjectionDocument([
        { position: [0, 0, 0], paletteIndex: 0 },
        { position: [0, height - 1, 0], paletteIndex: 0 },
      ], [{ blockId: "minecraft:white_concrete" }], {
        edition: "java",
        minecraftVersion: profile.id,
        metadata: {
          name: "Community projection",
          javaVersionId: profile.id,
          releaseStatus: profile.releaseStatus,
          targetHeight: height,
          heightMode: height === 4_064 ? "experimental_4064" : "extended_2032",
          heightDisclaimer: "Java-only warning",
        },
      });
      const derived = deriveBedrockProjectionDocument(source);

      assert.equal(derived.edition, "bedrock", profile.id);
      assert.equal(derived.minecraftVersion, "1.20.10", profile.id);
      assert.deepEqual(derived.bounds?.dimensions, [1, height, 1], profile.id);
      assert.deepEqual(derived.metadata, { name: "Community projection" }, profile.id);
    }
  }
});

test("sparse giant coordinates create only occupied chunks", () => {
  const document = createProjectionDocument([
    { position: [-1_000_000_000, 4, 1_000_000_000], paletteIndex: 0 },
    { position: [1_000_000_000, 5, -1_000_000_000], paletteIndex: 0 },
  ], [{ blockId: "minecraft:stone" }], { edition: "bedrock" });

  assert.equal(document.chunks.length, 2);
  assert.equal(document.blockCount, 2);
  assert.deepEqual(document.bounds, {
    min: [-1_000_000_000, 4, -1_000_000_000],
    max: [1_000_000_000, 5, 1_000_000_000],
    dimensions: [2_000_000_001, 2, 2_000_000_001],
  });
  assert.equal(document.edition, "bedrock");
  assert.equal(document.minecraftVersion, "1.20.10");
});

test("32-block chunk boundaries round-trip negative and positive coordinates", () => {
  const coordinates = [-33, -32, -1, 0, 31, 32, 63, 64];
  const blocks = coordinates.map((x): ProjectionBlock => ({
    position: [x, x + 100, x === 0 ? 0 : -x],
    paletteIndex: 0,
  }));
  const document = createProjectionDocument(blocks, [{ blockId: "minecraft:stone" }]);

  assert.equal(PROJECTION_CHUNK_SIZE, 32);
  assert.deepEqual(
    [...iterateProjectionBlocks(document)].map((block) => block.position).sort((a, b) => a[0] - b[0]),
    blocks.map((block) => block.position),
  );
  assert.ok(document.chunks.every((chunk) =>
    chunk.positions.every((position) => position >= 0 && position < 32 ** 3)));
});

test("axis slices and material counts operate on sparse chunks", () => {
  const document = createProjectionDocument([
    { position: [0, 7, 0], paletteIndex: 0 },
    { position: [32, 7, 2], paletteIndex: 1 },
    { position: [-40, 7, 4], paletteIndex: 1 },
    { position: [0, 8, 0], paletteIndex: 2 },
  ], [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:black_concrete" },
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
  ]);

  assert.deepEqual(
    [...iterateProjectionSlice(document, "y", 7)].map((block) => block.position).sort((a, b) => a[0] - b[0]),
    [[-40, 7, 4], [0, 7, 0], [32, 7, 2]],
  );
  assert.deepEqual(
    countProjectionMaterials(document).map(({ paletteIndex, count }) => [paletteIndex, count]),
    [[0, 1], [1, 2], [2, 1]],
  );
});

test("view splitting emits only occupied bounded views", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [31, 31, 31], paletteIndex: 0 },
    { position: [32, 0, 0], paletteIndex: 0 },
    { position: [10_000, 100, 10_000], paletteIndex: 0 },
  ], [{ blockId: "minecraft:stone" }]);
  const views = splitProjectionViews(document, [32, 64, 32]);

  assert.equal(views.length, 3);
  assert.deepEqual(views.map((view) => view.blockCount), [2, 1, 1]);
  assert.ok(views.every((view) => view.bounds.dimensions.every((size, axis) =>
    size <= [32, 64, 32][axis])));
  assert.deepEqual(
    views.flatMap((view) => [...iterateProjectionViewBlocks(document, view)].map(blockKey)).sort(),
    sortedBlockKeys(document),
  );
});

test("bounded iteration skips unrelated projection chunks before decoding entries", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [31, 31, 31], paletteIndex: 0 },
    { position: [320_000, 320_000, 320_000], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const remote = document.chunks.find((chunk) => chunk.chunk[0] > 1);
  assert.ok(remote);
  remote.paletteIndices = new Uint16Array(0);

  const blocks = [...iterateProjectionViewBlocks(document, {
    index: [0, 0, 0],
    bounds: {
      min: [0, 0, 0],
      max: [31, 31, 31],
      dimensions: [32, 32, 32],
    },
    occupiedBounds: {
      min: [0, 0, 0],
      max: [31, 31, 31],
      dimensions: [32, 32, 32],
    },
    blockCount: 2,
  })];
  assert.deepEqual(blocks.map((block) => block.position), [
    [0, 0, 0],
    [31, 31, 31],
  ]);
});
