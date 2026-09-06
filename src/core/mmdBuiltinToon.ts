import { normalizeAssetPath } from "./mmdAssets";

const BUILTIN_TOON_CACHE = new Map<string, File>();

const writeU16 = (view: DataView, offset: number, value: number) => view.setUint16(offset, value, true);
const writeU32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value, true);

/** Creates a tiny neutral toon ramp without depending on browser image decoders. */
const createBuiltinToon = (name: string) => {
  const width = 4;
  const height = 4;
  const rowSize = width * 3;
  const imageSize = rowSize * height;
  const bytes = new Uint8Array(54 + imageSize);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42; bytes[1] = 0x4d;
  writeU32(view, 2, bytes.byteLength);
  writeU32(view, 10, 54);
  writeU32(view, 14, 40);
  writeU32(view, 18, width);
  writeU32(view, 22, height);
  writeU16(view, 26, 1);
  writeU16(view, 28, 24);
  writeU32(view, 34, imageSize);
  const shades = [32, 80, 160, 255];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = shades[x];
      const offset = 54 + y * rowSize + x * 3;
      bytes[offset] = value;
      bytes[offset + 1] = value;
      bytes[offset + 2] = value;
    }
  }
  const file = new File([bytes], name, { type: "image/bmp" });
  Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: name });
  return file;
};

export const isToonReference = (value: string) => {
  const normalized = normalizeAssetPath(value).toLowerCase();
  return /(?:^|\/)(?:toon|toons)(?:\/|$)/i.test(normalized)
    || /(?:^|\/)toon\d*\.(?:bmp|png|tga|jpg|jpeg)$/i.test(normalized);
};

export const builtinToonFile = (reference: string) => {
  const basename = normalizeAssetPath(reference).split("/").pop() || "toon01.bmp";
  const name = /^toon\d+\./i.test(basename) ? basename : "toon01.bmp";
  const existing = BUILTIN_TOON_CACHE.get(name.toLowerCase());
  if (existing) return existing;
  const file = createBuiltinToon(name.replace(/\.(?:png|tga|jpg|jpeg)$/i, ".bmp"));
  BUILTIN_TOON_CACHE.set(name.toLowerCase(), file);
  return file;
};
