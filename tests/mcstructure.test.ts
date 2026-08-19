import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import * as nbt from "prismarine-nbt";
import {
  createProjectionDocument,
  deriveBedrockProjectionDocument,
} from "../src/core/projectionDocument";
import {
  BEDROCK_BLOCK_VERSION,
  createMcstructure,
  resolveBedrockBlockState,
} from "../src/core/mcstructure";

test("Bedrock mcstructure is little-endian NBT with two block index layers", () => {
  const document = createProjectionDocument([
    { position: [-1, 5, 8], paletteIndex: 0 },
    { position: [1, 5, 8], paletteIndex: 1 },
    { position: [-1, 6, 9], paletteIndex: 0 },
  ], [
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
    {
      blockId: "minecraft:white_stained_glass_pane",
      properties: { north: "false", east: "false", waterlogged: "false" },
    },
  ], { edition: "bedrock" });
  assert.equal(document.minecraftVersion, "1.20.10");
  const exported = createMcstructure(document);

  const parsed = nbt.parseUncompressed(Buffer.from(exported.bytes), "little");
  const root = nbt.simplify(parsed) as any;
  assert.equal(root.format_version, 1);
  assert.deepEqual(root.size, [3, 2, 2]);
  assert.deepEqual(root.structure_world_origin, [-1, 5, 8]);
  assert.equal(root.structure.block_indices.length, 2);
  assert.deepEqual(root.structure.block_indices[0], [0, -1, -1, 0, -1, -1, -1, -1, 1, -1, -1, -1]);
  assert.deepEqual(root.structure.block_indices[1], new Array(12).fill(-1));
  assert.deepEqual(root.structure.entities, []);

  const palette = root.structure.palette.default.block_palette;
  assert.deepEqual(palette.map((entry: any) => entry.name), [
    "minecraft:end_rod",
    "minecraft:stained_glass_pane",
  ]);
  assert.deepEqual(palette[0].states, { facing_direction: 1 });
  assert.deepEqual(palette[1].states, { color: "white" });
  assert.ok(palette.every((entry: any) => entry.version === BEDROCK_BLOCK_VERSION));
  assert.deepEqual(root.structure.palette.default.block_position_data, {});
});

test("Bedrock mcstructure rejects forged bounds before dense serialization", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [10, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], { edition: "bedrock" });
  document.bounds = { min: [0, 0, 0], max: [0, 0, 0], dimensions: [1, 1, 1] };
  assert.throws(() => createMcstructure(document), /declared bounds/);
});

test("Bedrock mcstructure ignores untested Java target and extreme-height metadata", () => {
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
  const exported = createMcstructure(deriveBedrockProjectionDocument(javaDocument));

  assert.deepEqual(exported.summary.dimensions, [1, 4_064, 1]);
  assert.equal(exported.summary.blockCount, 2);
});

test("Bedrock maxVolume is a confirmation threshold, not a serializer gate", () => {
  const document = deriveBedrockProjectionDocument(createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [10, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]));

  const exported = createMcstructure(document, { maxVolume: 1 });
  assert.equal(exported.summary.volume, 11);
  assert.throws(
    () => createMcstructure(document, { maxVolume: 0 }),
    /warning threshold must be a positive safe integer/i,
  );
});

test("Bedrock state resolver converts Java facing and removes pane connections", () => {
  assert.deepEqual(resolveBedrockBlockState({
    blockId: "minecraft:end_rod",
    properties: { facing: "north" },
  }), {
    blockId: "minecraft:end_rod",
    states: { facing_direction: 2 },
  });
  assert.deepEqual(resolveBedrockBlockState({
    blockId: "minecraft:white_stained_glass_pane",
    properties: { north: "true", waterlogged: "true", unsupported: "value" },
  }), {
    blockId: "minecraft:stained_glass_pane",
    states: { color: "white" },
  });
});

test("Bedrock state resolver maps palette families without leaking Java properties", () => {
  assert.deepEqual(resolveBedrockBlockState({
    blockId: "minecraft:light_gray_concrete",
    properties: { facing: "north", waterlogged: "true" },
  }), {
    blockId: "minecraft:light_gray_concrete",
    states: {},
  });
  assert.deepEqual(resolveBedrockBlockState({ blockId: "minecraft:pink_terracotta" }), {
    blockId: "minecraft:stained_hardened_clay",
    states: { color: "pink" },
  });
  assert.deepEqual(resolveBedrockBlockState({ blockId: "minecraft:smooth_quartz" }), {
    blockId: "minecraft:quartz_block",
    states: { chisel_type: "smooth", pillar_axis: "y" },
  });
  assert.deepEqual(resolveBedrockBlockState({ blockId: "minecraft:cut_sandstone" }), {
    blockId: "minecraft:sandstone",
    states: { sand_stone_type: "cut" },
  });
  assert.deepEqual(resolveBedrockBlockState({ blockId: "minecraft:oxidized_copper" }), {
    blockId: "minecraft:oxidized_copper",
    states: {},
  });
});

test("Bedrock attachment states use direction bit masks", () => {
  const vineBits = { south: 1, west: 2, north: 4, east: 8 } as const;
  for (const [direction, bit] of Object.entries(vineBits)) {
    assert.deepEqual(resolveBedrockBlockState({
      blockId: "minecraft:vine",
      properties: { [direction]: "true" },
    }), {
      blockId: "minecraft:vine",
      states: { vine_direction_bits: bit },
    });
  }
  const lichenBits = { down: 1, up: 2, north: 4, south: 8, west: 16, east: 32 } as const;
  for (const [direction, bit] of Object.entries(lichenBits)) {
    assert.deepEqual(resolveBedrockBlockState({
      blockId: "minecraft:glow_lichen",
      properties: { [direction]: "true" },
    }), {
      blockId: "minecraft:glow_lichen",
      states: { multi_face_direction_bits: bit },
    });
  }
  assert.deepEqual(resolveBedrockBlockState({
    blockId: "minecraft:vine",
    properties: {
      east: "true",
      north: "true",
      south: "true",
      up: "true",
      west: "true",
      unsupported: "true",
    },
  }), {
    blockId: "minecraft:vine",
    states: { vine_direction_bits: 15 },
  });
  assert.deepEqual(resolveBedrockBlockState({
    blockId: "minecraft:glow_lichen",
    properties: {
      down: "true",
      east: "true",
      north: "true",
      south: "true",
      up: "true",
      waterlogged: "true",
      west: "true",
    },
  }), {
    blockId: "minecraft:glow_lichen",
    states: { multi_face_direction_bits: 63 },
  });
  assert.deepEqual(resolveBedrockBlockState({
    blockId: "minecraft:vine",
    properties: { up: "true" },
  }), {
    blockId: "minecraft:vine",
    states: { vine_direction_bits: 0 },
  });
});
