import assert from "node:assert/strict";
import test from "node:test";
import {
  MMD_PREVIEW_MIN_DISTANCE,
  MMD_PREVIEW_VERTICAL_FOV_RADIANS,
  perspectiveFrameDistance,
  transformFrameBounds,
} from "../src/core/perspectiveFraming.ts";

test("shared perspective framing accounts for height, width, depth, and aspect", () => {
  const portrait = perspectiveFrameDistance({ width: 20, height: 80, depth: 12 }, 16 / 9);
  const narrowViewport = perspectiveFrameDistance({ width: 80, height: 20, depth: 12 }, 0.5);
  const deepModel = perspectiveFrameDistance({ width: 2, height: 2, depth: 80 }, 16 / 9);

  assert.ok(portrait > 120);
  assert.ok(narrowViewport > portrait);
  assert.equal(deepModel, 80 * 1.28 + 80 * 0.45);
});

test("shared framing applies native root scaling, rotation, and translation", () => {
  const transformed = transformFrameBounds({
    min: [-1, -2, -3],
    max: [1, 2, 3],
  }, {
    scale: [2, 1, 0.5],
    position: [10, 20, 30],
    rotationQuaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  });

  assert.deepEqual(transformed.min.map((value) => Math.round(value * 1e9) / 1e9), [8.5, 18, 28]);
  assert.deepEqual(transformed.max.map((value) => Math.round(value * 1e9) / 1e9), [11.5, 22, 32]);
});

test("shared perspective framing is deterministic and fails safely for invalid input", () => {
  const size = { width: 24, height: 48, depth: 16 };
  const expected = perspectiveFrameDistance(size, 16 / 9, MMD_PREVIEW_VERTICAL_FOV_RADIANS);

  assert.equal(perspectiveFrameDistance(size, 16 / 9), expected);
  assert.equal(
    perspectiveFrameDistance({ width: Number.NaN, height: -1, depth: Number.POSITIVE_INFINITY }, Number.NaN),
    MMD_PREVIEW_MIN_DISTANCE,
  );
});
