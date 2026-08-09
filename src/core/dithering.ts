import { ciede2000, rgbToLab, type Rgb } from "./color";

export interface DitherPaletteEntry {
  blockId: string;
  color: Rgb;
}

export interface DitherPixel {
  x: number;
  y: number;
  color: Rgb;
  protected?: boolean;
}

export interface DitherResult {
  paletteIndices: Uint16Array;
  colors: Uint8ClampedArray;
}

const clampChannel = (value: number) => Math.max(0, Math.min(255, value));

const nearestPaletteIndex = (
  rgb: Rgb,
  palette: readonly DitherPaletteEntry[],
  paletteLabs: readonly ReturnType<typeof rgbToLab>[],
) => {
  const target = rgbToLab(rgb);
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index += 1) {
    const distance = ciede2000(target, paletteLabs[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
};

const coordinateKey = (x: number, y: number) => `${x},${y}`;

export const ditherPixels = (
  pixels: readonly DitherPixel[],
  palette: readonly DitherPaletteEntry[],
  amountPercent: number,
): DitherResult => {
  if (!palette.length) throw new Error("Dithering requires at least one palette entry");
  const amount = Math.max(0, Math.min(1, amountPercent / 100));
  const ordered = pixels
    .map((pixel, sourceIndex) => ({ ...pixel, sourceIndex }))
    .sort((left, right) => left.y - right.y || left.x - right.x || left.sourceIndex - right.sourceIndex);
  const orderedLookup = new Map(ordered.map((pixel, index) => [coordinateKey(pixel.x, pixel.y), index]));
  const working = new Float64Array(ordered.length * 3);
  ordered.forEach((pixel, index) => working.set(pixel.color, index * 3));
  const paletteLabs = palette.map((entry) => rgbToLab(entry.color));
  const orderedIndices = new Uint16Array(ordered.length);
  const resultColors = new Uint8ClampedArray(ordered.length * 3);

  const diffuse = (x: number, y: number, error: readonly number[], weight: number) => {
    const index = orderedLookup.get(coordinateKey(x, y));
    if (index === undefined || ordered[index].protected) return;
    for (let channel = 0; channel < 3; channel += 1) {
      const offset = index * 3 + channel;
      working[offset] = clampChannel(working[offset] + error[channel] * weight * amount);
    }
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const pixel = ordered[index];
    const current: Rgb = [
      clampChannel(working[index * 3]),
      clampChannel(working[index * 3 + 1]),
      clampChannel(working[index * 3 + 2]),
    ];
    const paletteIndex = nearestPaletteIndex(current, palette, paletteLabs);
    const chosen = palette[paletteIndex].color;
    orderedIndices[index] = paletteIndex;
    resultColors.set(chosen, index * 3);
    if (amount === 0 || pixel.protected) continue;
    const error = [
      current[0] - chosen[0],
      current[1] - chosen[1],
      current[2] - chosen[2],
    ];
    diffuse(pixel.x + 1, pixel.y, error, 7 / 16);
    diffuse(pixel.x - 1, pixel.y + 1, error, 3 / 16);
    diffuse(pixel.x, pixel.y + 1, error, 5 / 16);
    diffuse(pixel.x + 1, pixel.y + 1, error, 1 / 16);
  }

  const paletteIndices = new Uint16Array(pixels.length);
  const colors = new Uint8ClampedArray(pixels.length * 3);
  ordered.forEach((pixel, orderedIndex) => {
    paletteIndices[pixel.sourceIndex] = orderedIndices[orderedIndex];
    colors.set(resultColors.subarray(orderedIndex * 3, orderedIndex * 3 + 3), pixel.sourceIndex * 3);
  });
  return { paletteIndices, colors };
};
