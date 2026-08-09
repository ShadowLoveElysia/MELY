import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DENSE_EXPORT_VOLUME_LIMIT,
  preflightProjectionExport,
  type ExportPreflightFormat,
} from "../src/core/exportPreflight";
import { createProjectionDocument } from "../src/core/projectionDocument";
import type { ProjectionDocument } from "../src/types";

const formats: ExportPreflightFormat[] = [
  "litematic",
  "bundle",
  "schematic",
  "mcstructure",
  "mcfunction",
];

const palette = [{ blockId: "minecraft:white_concrete" }];

const sparseDocument = (max: [number, number, number]) => createProjectionDocument([
  { position: [0, 0, 0], paletteIndex: 0 },
  { position: max, paletteIndex: 0 },
], palette);

test("small projections pass every export preflight", () => {
  const document = sparseDocument([3, 4, 5]);
  for (const format of formats) {
    const result = preflightProjectionExport(document, format);
    assert.equal(result.allowed, true, format);
    assert.equal(result.reason, null, format);
    assert.deepEqual(result.dimensions, [4, 5, 6]);
    assert.equal(result.volume, 120);
  }
});

test("large sparse bounds disable only dense schematic formats", () => {
  const document = sparseDocument([4095, 4095, 4]);
  assert.ok(document.bounds);
  assert.ok(
    document.bounds.dimensions.reduce((volume, dimension) => volume * dimension, 1)
      > DEFAULT_DENSE_EXPORT_VOLUME_LIMIT,
  );

  for (const format of ["schematic", "mcstructure"] as const) {
    const result = preflightProjectionExport(document, format);
    assert.equal(result.allowed, false, format);
    assert.equal(result.reason, "unsafeVolume", format);
  }
  for (const format of ["litematic", "bundle", "mcfunction"] as const) {
    assert.equal(preflightProjectionExport(document, format).allowed, true, format);
  }
});

test("Sponge dimensions stop at 32767 without restricting Bedrock structures", () => {
  const document = sparseDocument([32767, 0, 0]);
  const schematic = preflightProjectionExport(document, "schematic");
  assert.equal(schematic.allowed, false);
  assert.equal(schematic.reason, "dimensionLimit");
  assert.equal(schematic.dimensionLimit, 32767);
  assert.equal(preflightProjectionExport(document, "mcstructure").allowed, true);
});

test("custom dense volume limits include their exact boundary", () => {
  const document = sparseDocument([3, 3, 3]);
  assert.equal(
    preflightProjectionExport(document, "mcstructure", { volumeLimit: 64 }).allowed,
    true,
  );
  const rejected = preflightProjectionExport(document, "mcstructure", { maxVolume: 63 });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reason, "unsafeVolume");
  assert.equal(rejected.volumeLimit, 63);
});

test("non-safe dense volume multiplication is rejected", () => {
  const document = {
    ...sparseDocument([1, 1, 1]),
    bounds: {
      min: [0, 0, 0],
      max: [Number.MAX_SAFE_INTEGER - 1, 1, 0],
      dimensions: [Number.MAX_SAFE_INTEGER, 2, 1],
    },
  } as ProjectionDocument;
  const result = preflightProjectionExport(document, "mcstructure", {
    volumeLimit: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "unsafeVolume");
  assert.equal(result.volume, Number.POSITIVE_INFINITY);
});

test("empty projections are rejected consistently", () => {
  const document = createProjectionDocument([], palette);
  for (const format of formats) {
    const result = preflightProjectionExport(document, format);
    assert.equal(result.allowed, false, format);
    assert.equal(result.reason, "empty", format);
    assert.equal(result.dimensions, null, format);
  }
});

test("sparse formats remain available for bounds beyond safe dense arithmetic", () => {
  const document = {
    ...sparseDocument([1, 1, 1]),
    bounds: {
      min: [0, 0, 0],
      max: [Number.MAX_SAFE_INTEGER - 1, 1, 0],
      dimensions: [Number.MAX_SAFE_INTEGER, 2, 1],
    },
  } as ProjectionDocument;
  for (const format of ["litematic", "bundle", "mcfunction"] as const) {
    assert.equal(preflightProjectionExport(document, format).allowed, true, format);
  }
});
