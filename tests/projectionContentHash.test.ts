import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createProjectionViewContentHash,
  sha256Hex,
} from "../src/core/projectionContentHash";
import {
  createProjectionDocument,
  splitProjectionViews,
} from "../src/core/projectionDocument";

test("projection content hashing uses standard SHA-256", () => {
  for (const value of ["", "abc", "MELY".repeat(40)]) {
    const bytes = new TextEncoder().encode(value);
    assert.equal(
      sha256Hex(bytes),
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
});

test("part content hashes are stable across palette order and global placement", () => {
  const palette = [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:end_rod", properties: { facing: "up" } },
  ];
  const first = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [1, 2, 3], paletteIndex: 1 },
  ], palette);
  const reorderedAndMoved = createProjectionDocument([
    { position: [101, 12, -7], paletteIndex: 0 },
    { position: [100, 10, -10], paletteIndex: 1 },
  ], [palette[1], palette[0]]);
  const firstView = splitProjectionViews(first, 32)[0];
  const secondView = splitProjectionViews(reorderedAndMoved, 32)[0];

  assert.equal(
    createProjectionViewContentHash(first, firstView),
    createProjectionViewContentHash(reorderedAndMoved, secondView),
  );
});

test("part content hashes change when a block state changes", () => {
  const first = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:end_rod", properties: { facing: "up" } }]);
  const changed = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:end_rod", properties: { facing: "north" } }]);

  assert.notEqual(
    createProjectionViewContentHash(first, splitProjectionViews(first, 32)[0]),
    createProjectionViewContentHash(changed, splitProjectionViews(changed, 32)[0]),
  );
});
