import { TGALoader } from "three-stdlib";
import { normalizeAssetPath } from "./mmdAssets";

const LEGACY_TEXTURE_PATTERN = /\.(?:bmp|tga)$/i;
const crcTable = (() => { const table = new Uint32Array(256); for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); table[index] = value >>> 0; } return table; })();
const crc32 = (bytes: Uint8Array) => { let value = 0xffffffff; bytes.forEach((byte) => { value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]; }); return (value ^ 0xffffffff) >>> 0; };
const pngChunk = (type: string, data: Uint8Array) => { const typeBytes = new TextEncoder().encode(type); const output = new Uint8Array(12 + data.length); const view = new DataView(output.buffer); view.setUint32(0, data.length); output.set(typeBytes, 4); output.set(data, 8); view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length))); return output; };
const concat = (...parts: Uint8Array[]) => { const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; parts.forEach((part) => { output.set(part, offset); offset += part.length; }); return output; };

export const decodeBmp = (bytes: Uint8Array) => {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const pixelOffset = view.getUint32(10, true); const headerSize = view.getUint32(14, true); const width = view.getInt32(18, true); const signedHeight = view.getInt32(22, true); const planes = view.getUint16(26, true); const bits = view.getUint16(28, true); const compression = view.getUint32(30, true);
  if (headerSize < 40 || pixelOffset >= bytes.length || width <= 0 || signedHeight === 0 || planes !== 1 || ![8, 24, 32].includes(bits) || compression !== 0) return undefined;
  const height = Math.abs(signedHeight); const rowSize = Math.ceil((width * bits) / 32) * 4; if (pixelOffset + rowSize * height > bytes.length) return undefined;
  const paletteEntries = bits === 8 ? (view.getUint32(46, true) || 256) : 0;
  const paletteOffset = 14 + headerSize;
  if (bits === 8 && paletteOffset + paletteEntries * 4 > bytes.length) return undefined;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = pixelOffset + (signedHeight > 0 ? height - 1 - y : y) * rowSize + x * (bits / 8);
    const target = (y * width + x) * 4;
    if (bits === 8) {
      const palette = paletteOffset + bytes[source] * 4;
      rgba[target] = bytes[palette + 2]; rgba[target + 1] = bytes[palette + 1]; rgba[target + 2] = bytes[palette]; rgba[target + 3] = 255;
    } else {
      rgba[target] = bytes[source + 2]; rgba[target + 1] = bytes[source + 1]; rgba[target + 2] = bytes[source]; rgba[target + 3] = bits === 32 ? bytes[source + 3] : 255;
    }
  }
  return { data: rgba, width, height };
};

const encodePng = async (rgba: Uint8Array, width: number, height: number) => { const scanlines = new Uint8Array(height * (width * 4 + 1)); for (let y = 0; y < height; y += 1) scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1); const compressed = new Uint8Array(await new Response(new Blob([scanlines]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()); const header = new Uint8Array(13); const view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6; return concat(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array())); };

export interface PreparedMmdAssets { files: File[]; modelFile: File; warnings: string[]; }
const rewriteLegacyTextureExtensions = (bytes: Uint8Array, convertedNames: ReadonlySet<string>) => {
  const output = Uint8Array.from(bytes);
  for (const stride of [1, 2]) {
    for (let offset = 0; offset + stride * 3 < output.length; offset += 1) {
      const read = (index: number) => String.fromCharCode(output[offset + index * stride]).toLowerCase();
      const extension = `${read(0)}${read(1)}${read(2)}${read(3)}`;
      if (extension !== ".bmp" && extension !== ".tga") continue;
      if (stride === 2 && [0, 1, 2, 3].some((index) => output[offset + index * stride + 1] !== 0)) continue;
      let start = offset;
      while (start > stride && output[start - stride] !== 0) start -= stride;
      const rawName = Array.from({ length: Math.min(260, Math.floor((offset - start) / stride)) }, (_, index) => String.fromCharCode(output[start + index * stride])).join("") + extension;
      const basename = rawName.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? rawName.toLowerCase();
      if (!convertedNames.has(basename)) continue;
      for (let index = 0; index < 4; index += 1) output[offset + index * stride] = ".png".charCodeAt(index);
    }
  }
  return output;
};

export const prepareMmdTextureAssets = async (files: readonly File[], modelFile: File): Promise<PreparedMmdAssets> => { const warnings: string[] = []; const replacements = new Map<string, File>(); const convertedTgaNames = new Set<string>(); for (const file of files) { if (!LEGACY_TEXTURE_PATTERN.test(file.name)) continue; const bytes = new Uint8Array(await file.arrayBuffer()); let decoded = decodeBmp(bytes); const isTga = /\.tga$/i.test(file.name); if (isTga) { try { const texture = new TGALoader().parse(bytes.buffer); const data = texture.image?.data; decoded = data ? { data: new Uint8Array(data as ArrayBufferLike), width: texture.image.width, height: texture.image.height } : undefined; } catch { decoded = undefined; } } const originalPath = normalizeAssetPath(file.webkitRelativePath || file.name); if (!decoded) { warnings.push(`decode-failed: ${originalPath}`); continue; } const pngPath = originalPath.replace(/\.(?:bmp|tga)$/i, ".png"); const pngBytes = await encodePng(decoded.data, decoded.width, decoded.height); const converted = new File([pngBytes], pngPath.split("/").pop() || "texture.png", { type: "image/png" }); Object.defineProperty(converted, "webkitRelativePath", { configurable: true, value: pngPath }); replacements.set(originalPath.toLowerCase(), converted); if (isTga) convertedTgaNames.add(originalPath.split("/").pop()?.toLowerCase() ?? originalPath.toLowerCase()); } const preparedFiles = files.map((file) => replacements.get(normalizeAssetPath(file.webkitRelativePath || file.name).toLowerCase()) ?? file); const preparedModel = convertedTgaNames.size ? new File([rewriteLegacyTextureExtensions(new Uint8Array(await modelFile.arrayBuffer()), convertedTgaNames)], modelFile.name, { type: modelFile.type || "application/octet-stream" }) : modelFile; if (convertedTgaNames.size) Object.defineProperty(preparedModel, "webkitRelativePath", { configurable: true, value: modelFile.webkitRelativePath || modelFile.name }); return { files: preparedFiles, modelFile: preparedModel, warnings }; };
