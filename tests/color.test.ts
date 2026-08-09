import assert from "node:assert/strict";
import { test } from "node:test";
import { ciede2000, rgbToLab } from "../src/core/color";
import { createBlockPalette, matchBlockColor } from "../src/core/blockPalette";
import type { SolidOptions } from "../src/types";

const paletteOptions: SolidOptions = {
  targetHeight: 320,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell",
  palettePreset: "balanced",
  faceDetail: "balanced",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: [],
  excludeGravity: false,
  excludeRare: false,
};

test("CIEDE2000 matches published Sharma reference pairs", () => {
  const pairs = [
    { left: [50, 2.6772, -79.7751], right: [50, 0, -82.7485], expected: 2.0425 },
    { left: [50, 3.1571, -77.2803], right: [50, 0, -82.7485], expected: 2.8615 },
    { left: [50, 2.8361, -74.02], right: [50, 0, -82.7485], expected: 3.4412 },
    { left: [50, -1.3802, -84.2814], right: [50, 0, -82.7485], expected: 1 },
  ] as const;
  for (const pair of pairs) {
    assert.ok(Math.abs(ciede2000([...pair.left], [...pair.right]) - pair.expected) < 0.0002);
  }
});

test("RGB to Lab preserves perceptual lightness ordering", () => {
  const black = rgbToLab([0, 0, 0]);
  const gray = rgbToLab([128, 128, 128]);
  const white = rgbToLab([255, 255, 255]);
  assert.ok(black[0] < gray[0]);
  assert.ok(gray[0] < white[0]);
  assert.ok(Math.abs(white[0] - 100) < 0.001);
});

test("face feature palette preserves clean high-contrast facial colors", () => {
  const palette = createBlockPalette(paletteOptions);
  const expected = [
    ["minecraft:black_concrete", [8, 10, 15]],
    ["minecraft:white_concrete", [207, 213, 214]],
    ["minecraft:blue_concrete", [44, 46, 143]],
    ["minecraft:cyan_concrete", [21, 119, 136]],
    ["minecraft:purple_concrete", [100, 31, 156]],
    ["minecraft:pink_concrete", [214, 101, 143]],
    ["minecraft:red_concrete", [142, 32, 32]],
  ] as const;

  for (const [blockId, rgb] of expected) {
    const index = matchBlockColor([...rgb], palette, "faceFeature");
    assert.equal(palette.entries[index].blockId, blockId);
  }
});

test("face feature matching never selects textured, noisy, gravity, or rare blocks", () => {
  const palette = createBlockPalette(paletteOptions);
  const samples = [
    [188, 188, 183],
    [219, 207, 163],
    [98, 237, 228],
    [237, 141, 172],
    [161, 78, 78],
  ] as const;

  for (const rgb of samples) {
    const index = matchBlockColor([...rgb], palette, "faceFeature");
    assert.match(palette.entries[index].blockId, /^minecraft:[a-z_]+_concrete$/);
  }
});

test("boolean palette roles remain compatible with the role API", () => {
  const palette = createBlockPalette(paletteOptions);
  const rgb: [number, number, number] = [224, 170, 153];
  assert.equal(
    matchBlockColor(rgb, palette, false),
    matchBlockColor(rgb, palette, "general"),
  );
  assert.equal(
    matchBlockColor(rgb, palette, true),
    matchBlockColor(rgb, palette, "skinBase"),
  );
});
