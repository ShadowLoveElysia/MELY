import assert from "node:assert/strict";
import test from "node:test";
import { ditherPixels } from "../src/core/dithering";
import { emissiveStrength, isEmissiveMaterial, matchEmissiveBlock } from "../src/core/emissiveMapping";

const palette = [
  { blockId: "minecraft:white_concrete", color: [240, 240, 240] as [number, number, number] },
  { blockId: "minecraft:pink_concrete", color: [200, 90, 140] as [number, number, number] },
];

test("zero-percent dithering is deterministic flat nearest-color matching", () => {
  const result = ditherPixels([
    { x: 0, y: 0, color: [235, 220, 228] },
    { x: 1, y: 0, color: [205, 105, 150] },
  ], palette, 0);
  assert.deepEqual([...result.paletteIndices], [0, 1]);
});

test("Floyd-Steinberg error diffusion is stable and skips protected facial pixels", () => {
  const pixels = [
    { x: 0, y: 0, color: [215, 160, 185] as [number, number, number], protected: true },
    { x: 1, y: 0, color: [215, 160, 185] as [number, number, number] },
    { x: 0, y: 1, color: [215, 160, 185] as [number, number, number] },
    { x: 1, y: 1, color: [215, 160, 185] as [number, number, number] },
  ];
  const first = ditherPixels(pixels, palette, 100);
  const reversed = [...pixels].reverse();
  const second = ditherPixels(reversed, palette, 100);
  assert.equal(first.paletteIndices[0], 1);
  const colorsByCoordinate = (
    source: typeof pixels,
    colors: Uint8ClampedArray,
  ) => new Map(source.map((pixel, index) => [
    `${pixel.x},${pixel.y}`,
    [...colors.subarray(index * 3, index * 3 + 3)],
  ]));
  assert.deepEqual(colorsByCoordinate(pixels, first.colors), colorsByCoordinate(reversed, second.colors));
  assert.deepEqual([...first.colors.subarray(0, 3)], palette[1].color);
});

test("emissive detection supports parsed channels and explicit user overrides", () => {
  assert.ok(emissiveStrength({ color: [255, 255, 255], emissive: [0.8, 0.8, 0.8] }) > 0.5);
  assert.equal(isEmissiveMaterial({ color: [255, 255, 255], ambient: [0.8, 0.8, 0.8] }), false);
  assert.equal(isEmissiveMaterial({ color: [30, 30, 30], ambient: [0.1, 0.1, 0.1] }), false);
  assert.equal(isEmissiveMaterial({ color: [30, 30, 30], manual: true }), true);
  assert.equal(matchEmissiveBlock([235, 210, 225]).blockId, "minecraft:pearlescent_froglight");
});
