import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { gunzipSync } from "fflate";
import * as nbt from "prismarine-nbt";
import { createProjectionDocument } from "../src/core/projectionDocument";
import { createSchematic } from "../src/core/schematic";

const decodeVarInts = (bytes: Uint8Array, count: number) => {
  const values: number[] = [];
  let cursor = 0;
  while (values.length < count) {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = bytes[cursor++];
      assert.notEqual(byte, undefined);
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      assert.ok(shift < 35);
    }
    values.push(value >>> 0);
  }
  assert.equal(cursor, bytes.length);
  return values;
};

test("Sponge schematic v3 is gzip-compressed canonical NBT with sparse blocks", async () => {
  const document = createProjectionDocument([
    { position: [-2, 4, 10], paletteIndex: 0 },
    { position: [0, 4, 10], paletteIndex: 1 },
    { position: [-1, 5, 11], paletteIndex: 0 },
  ], [
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
    { blockId: "minecraft:black_concrete" },
  ], { minecraftVersion: "1.20.1" });
  const exported = createSchematic(document, {
    name: "MELY Schematic Test",
    author: "MELY",
  });

  assert.deepEqual([...exported.bytes.slice(0, 2)], [0x1f, 0x8b]);
  const raw = gunzipSync(exported.bytes);
  const parsed = nbt.parseUncompressed(Buffer.from(raw), "big");
  assert.equal(parsed.name, "Schematic");
  const root = nbt.simplify(parsed) as any;
  assert.equal(root.Version, 3);
  assert.equal(root.DataVersion, 3465);
  assert.deepEqual([root.Width, root.Height, root.Length], [3, 2, 2]);
  assert.deepEqual(root.Offset, [-2, 4, 10]);
  assert.equal(root.Metadata.Name, "MELY Schematic Test");
  assert.deepEqual(root.Blocks.Palette, {
    "minecraft:air": 0,
    "minecraft:end_rod[facing=up]": 1,
    "minecraft:black_concrete": 2,
  });

  const indices = decodeVarInts(Uint8Array.from(root.Blocks.Data), 12);
  assert.equal(indices.filter((index) => index !== 0).length, 3);
  assert.equal(indices[(0 * 2 + 0) * 3 + 0], 1);
  assert.equal(indices[(0 * 2 + 0) * 3 + 2], 2);
  assert.equal(indices[(1 * 2 + 1) * 3 + 1], 1);
  assert.deepEqual(root.Blocks.BlockEntities, []);
  assert.deepEqual(root.Entities, []);
});

test("Sponge schematic rejects empty and oversized dense bounds", () => {
  assert.throws(
    () => createSchematic(createProjectionDocument([], [{ blockId: "minecraft:stone" }])),
    /empty/i,
  );
  const sparse = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [100, 100, 100], paletteIndex: 0 },
  ], [{ blockId: "minecraft:stone" }]);
  assert.throws(() => createSchematic(sparse, { maxVolume: 1000 }), /exceeds limit/i);
});
