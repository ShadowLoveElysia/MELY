import { normalizeAssetPath } from "./mmdAssets";

const BUILTIN_TOON_CACHE = new Map<string, File>();

const BUILTIN_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAIElEQVR42mNQUFD4j4wZAgIC/iNjhgULFvxHxgz/0QAAMEwopWV0VAkAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));

const createBuiltinToon = (name: string) => {
  const pngName = name.replace(/\.bmp$/i, ".png");
  const file = new File([BUILTIN_PNG], pngName, { type: "image/png" });
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
  const file = createBuiltinToon(name.replace(/\.(?:tga|jpg|jpeg)$/i, ".png"));
  BUILTIN_TOON_CACHE.set(name.toLowerCase(), file);
  return file;
};
