import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createProjectionDocumentContentHash,
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

test("document content hashes include changes outside the first 32-block view", () => {
  const palette = [{ blockId: "minecraft:white_concrete" }];
  const first = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [64, 0, 0], paletteIndex: 0 },
  ], palette);
  const changedOutsideFirstView = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [65, 0, 0], paletteIndex: 0 },
  ], palette);

  assert.notEqual(
    createProjectionDocumentContentHash(first),
    createProjectionDocumentContentHash(changedOutsideFirstView),
  );
});

test("document content hashes bind absolute positions without depending on chunk or palette order", () => {
  const palette = [
    { blockId: "minecraft:white_concrete", color: [207, 213, 214] as [number, number, number] },
    { blockId: "minecraft:end_rod", properties: { facing: "up" }, emissive: true },
  ];
  const first = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [64, 0, 0], paletteIndex: 1 },
    { position: [96, 0, 0], paletteIndex: 0 },
  ], palette);
  const structurallyReordered = createProjectionDocument([
    { position: [96, 0, 0], paletteIndex: 1 },
    { position: [64, 0, 0], paletteIndex: 0 },
    { position: [0, 0, 0], paletteIndex: 1 },
  ], [palette[1], palette[0]]);
  structurallyReordered.chunks.reverse();
  const movedInsideSameView = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [65, 0, 0], paletteIndex: 1 },
    { position: [96, 0, 0], paletteIndex: 0 },
  ], palette);

  assert.equal(
    createProjectionDocumentContentHash(first),
    createProjectionDocumentContentHash(structurallyReordered),
  );
  assert.notEqual(
    createProjectionDocumentContentHash(first),
    createProjectionDocumentContentHash(movedInsideSameView),
  );
});

test("document content hashes include headers, metadata, color, and emissive state", () => {
  const create = (
    metadata: Record<string, string | number | boolean>,
    color: [number, number, number],
    emissive: boolean,
  ) => createProjectionDocument([
    { position: [-1, 2, 3], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete", color, emissive }], {
    minecraftVersion: "1.20.1",
    metadata,
  });
  const first = create({ generator: "MELY", targetHeight: 4064 }, [1, 2, 3], false);
  const reorderedMetadata = create({ targetHeight: 4064, generator: "MELY" }, [1, 2, 3], false);
  const changedMetadata = create({ generator: "MELY", targetHeight: 2032 }, [1, 2, 3], false);
  const changedColor = create({ generator: "MELY", targetHeight: 4064 }, [1, 2, 4], false);
  const changedEmissive = create({ generator: "MELY", targetHeight: 4064 }, [1, 2, 3], true);
  const changedVersion = {
    ...first,
    minecraftVersion: "1.20.2",
  };

  assert.equal(
    createProjectionDocumentContentHash(first),
    createProjectionDocumentContentHash(reorderedMetadata),
  );
  for (const changed of [changedMetadata, changedColor, changedEmissive, changedVersion]) {
    assert.notEqual(
      createProjectionDocumentContentHash(first),
      createProjectionDocumentContentHash(changed),
    );
  }
});

test("document content hashes canonicalize Unicode keys and bounds field order", () => {
  const first = createProjectionDocument([
    { position: [-32, 0, 31], paletteIndex: 0 },
  ], [{
    blockId: "minecraft:end_rod",
    properties: { "e\u0301": "first", "é": "second" },
  }], {
    metadata: { "e\u0301": "first", "é": "second" },
  });
  const reordered = createProjectionDocument([
    { position: [-32, 0, 31], paletteIndex: 0 },
  ], [{
    blockId: "minecraft:end_rod",
    properties: { "é": "second", "e\u0301": "first" },
  }], {
    metadata: { "é": "second", "e\u0301": "first" },
  });
  reordered.bounds = reordered.bounds && {
    dimensions: [...reordered.bounds.dimensions],
    max: [...reordered.bounds.max],
    min: [...reordered.bounds.min],
  };

  assert.equal(
    createProjectionDocumentContentHash(first),
    createProjectionDocumentContentHash(reordered),
  );
});

test("document content hashes reject non-finite runtime metadata", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }], {
    metadata: { targetHeight: 4064 },
  });
  document.metadata!.targetHeight = Number.POSITIVE_INFINITY;

  assert.throws(
    () => createProjectionDocumentContentHash(document),
    /finite scalar value/,
  );
});
